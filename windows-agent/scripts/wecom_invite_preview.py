#!/usr/bin/env python3
"""WeCom invite preview only. No send operation and no ADB/Agent lifecycle code.

Host entry: run_preview(PocoPreviewDriver(existing_poco, foreground, lease), request).
The host must already hold this device's exclusive automation lease and provide
bounded Poco RPCs. Importing this module never connects to a device.
"""
import argparse
import json
import math
import re
import time
from dataclasses import dataclass


WORKFLOW = "wecom-invite-preview-v1"
PACKAGE = "com.tencent.wework"
SEND = "发送添加邀请"
NODE_TYPES = ("android.widget.TextView", "android.widget.Button",
              "android.widget.ImageView", "android.widget.ImageButton",
              "android.widget.EditText", "android.view.View",
              "android.view.ViewGroup")
HUMAN_MARKERS = ("请完成验证", "安全验证", "拖动滑块", "拼图", "操作过于频繁",
                 "操作频繁", "添加客户已达上限", "今日添加客户数量已达上限")


class StopPreview(Exception):
    """Only fixed public error codes, never raw UI text or provider errors."""


@dataclass(frozen=True)
class Node:
    kind: str
    text: str = ""
    name: str = ""
    desc: str = ""
    enabled: bool = True
    visible: bool = True
    # Normalized Poco geometry; used only to disambiguate the top menu icon.
    position: tuple = (0.5, 0.5)
    size: tuple = (0.1, 0.1)

    def labeled(self, value):
        return value in (self.text.strip(), self.desc.strip())


@dataclass(frozen=True)
class Screen:
    package: str
    nodes: tuple

    def has(self, label):
        return any(n.visible and n.labeled(label) for n in self.nodes)

    def matching(self, predicate):
        return [n for n in self.nodes if n.visible and n.enabled and predicate(n)]


def validate_request(request):
    if not isinstance(request, dict) or set(request) - {"phoneNumber", "mode"}:
        raise StopPreview("invalid_request")
    phone = request.get("phoneNumber")
    if not isinstance(phone, str) or not re.fullmatch(r"1[3-9][0-9]{9}", phone):
        raise StopPreview("invalid_phone_number")
    if request.get("mode", "preview") != "preview":
        raise StopPreview("send_mode_forbidden")
    return phone


def guard(screen):
    if screen.package != PACKAGE:
        raise StopPreview("wrong_foreground_app")
    texts = [v for n in screen.nodes if n.visible for v in (n.text, n.desc)]
    if any(marker in v for v in texts for marker in HUMAN_MARKERS):
        raise StopPreview("human_required")
    if any(screen.has(v) for v in ("手机号登录", "登录", "登录已过期", "重新登录")):
        raise StopPreview("login_required")
    if any(screen.has(v) for v in ("该用户不存在", "用户不存在", "未找到相关用户")):
        raise StopPreview("not_found")


def unique(nodes):
    if len(nodes) != 1:
        raise StopPreview("ambiguous_or_missing_element")
    return nodes[0]


def is_home(screen):
    return all(screen.has(v) for v in ("消息", "工作台", "通讯录"))


def is_menu(screen):
    return all(screen.has(v) for v in ("添加客户", "发起群聊", "扫一扫"))


def is_add_page(screen):
    return all(screen.has(v) for v in ("添加客户", "面对面添加", "搜索手机号添加"))


def editor(screen):
    return unique(screen.matching(lambda n: n.kind == "android.widget.EditText"))


def profile_matches(screen, phone):
    return (screen.has("个人信息") and screen.has("设置备注和描述")
            and any(n.visible and re.sub(r"[\s-]", "", n.text) in (phone, "电话" + phone)
                    for n in screen.nodes))


def resolve_action(action, screen, phone):
    """Closed action vocabulary: the final send and remark-save do not exist."""
    guard(screen)
    if screen.has(SEND):
        raise StopPreview("send_boundary_reached")
    if action == "open_menu" and is_home(screen):
        return unique(screen.matching(lambda n: n.kind in (
            "android.widget.ImageView", "android.widget.ImageButton", "android.widget.Button")
            and any(n.labeled(v) for v in ("+", "更多", "添加"))
            and n.position[0] > 0.75 and n.position[1] < 0.18))
    if action == "open_add" and is_menu(screen):
        return unique(screen.matching(lambda n: n.labeled("添加客户")))
    if action == "open_search" and is_add_page(screen):
        return unique(screen.matching(lambda n: n.labeled("搜索手机号添加")))
    if action == "enter_phone":
        node = editor(screen)
        if not node.labeled("手机号"):
            raise StopPreview("unrecognized_phone_input")
        if node.text not in ("", "手机号"):
            raise StopPreview("search_input_not_empty")
        return node
    if action == "search":
        if editor(screen).text != phone:
            raise StopPreview("phone_readback_mismatch")
        return unique(screen.matching(lambda n: re.sub(r"\s", "", n.text).replace("：", ":")
                                      == "网络查找手机/邮箱:" + phone))
    if action == "open_preview" and profile_matches(screen, phone):
        if screen.has("发消息"):
            raise StopPreview("already_contact")
        return unique(screen.matching(lambda n: n.labeled("添加为联系人")))
    raise StopPreview("action_not_allowed")


def run_preview(driver, request, timeout=45, max_reads=90, cancelled=lambda: False,
                clock=time.monotonic, sleep=time.sleep):
    """Single traversal. A timed-out action is never blindly repeated.

    driver.snapshot() -> Screen; driver.apply(action, expected_screen, phone).
    apply MUST revalidate the lease, foreground, screen and closed action policy.
    Every invocation starts from the home/menu/add page, never trusts an
    invitation left over from another run. No customer data in returned events.
    """
    events = []
    stage = "entry"
    target_verified = False
    preview_frames = 0

    def result(status, code):
        return {"workflowVersion": WORKFLOW, "status": status, "code": code,
                "readyToSend": status == "ready_before_send",
                "invitationSent": False, "remarkSaved": False,
                "stage": stage, "events": events}

    try:
        phone = validate_request(request)
        if (not isinstance(timeout, (int, float)) or not math.isfinite(timeout)
                or not 1 <= timeout <= 120 or type(max_reads) is not int or not 1 <= max_reads <= 240):
            raise StopPreview("invalid_budget")
        deadline = clock() + timeout

        def check_budget():
            if cancelled():
                raise StopPreview("cancelled")
            if clock() >= deadline:
                raise StopPreview("timeout")

        for _ in range(max_reads):
            check_budget()
            screen = driver.snapshot()
            check_budget()
            guard(screen)
            if screen.has(SEND):
                if stage != "preview" or not target_verified:
                    raise StopPreview("preview_target_unverified")
                unique(screen.matching(lambda n: n.labeled(SEND)))
                preview_frames += 1
                if preview_frames >= 2:
                    return result("ready_before_send", "stopped_before_send")
                sleep(0.25)
                continue
            preview_frames = 0
            action = None
            next_stage = stage
            if stage == "entry":
                if is_menu(screen):
                    action, next_stage = "open_add", "add"
                elif is_add_page(screen):
                    action, next_stage = "open_search", "search"
                elif is_home(screen):
                    action, next_stage = "open_menu", "menu"
                else:
                    # Do not inherit an arbitrary chat editor or old customer.
                    raise StopPreview("unsupported_start_page")
            elif stage == "menu" and is_menu(screen):
                action, next_stage = "open_add", "add"
            elif stage == "add" and is_add_page(screen):
                action, next_stage = "open_search", "search"
            elif stage == "search":
                if screen.matching(lambda n: n.kind == "android.widget.EditText"):
                    action, next_stage = "enter_phone", "readback"
            elif stage == "readback":
                if not screen.matching(lambda n: n.kind == "android.widget.EditText"):
                    sleep(0.25)
                    continue
                value = editor(screen).text
                if value not in ("", "手机号", phone):
                    raise StopPreview("phone_readback_mismatch")
                if value == phone and screen.matching(lambda n: n.text.startswith("网络查找手机/邮箱")):
                    action, next_stage = "search", "profile"
            elif stage == "profile" and screen.has("个人信息"):
                if not profile_matches(screen, phone):
                    raise StopPreview("profile_phone_mismatch")
                if screen.has("发消息"):
                    raise StopPreview("already_contact")
                target_verified = True
                action, next_stage = "open_preview", "preview"
            if action:
                resolve_action(action, screen, phone)
                check_budget()
                driver.apply(action, screen, phone, check_budget)
                events.append({"step": action})
                stage = next_stage
            sleep(0.25)
        raise StopPreview("observation_budget_exhausted")
    except StopPreview as exc:
        return result("stopped", str(exc))
    except Exception:
        # A transport may have executed before failing. Never replay or log its
        # exception (which can contain the phone number / raw hierarchy).
        return result("stopped", "executor_error_no_replay")


class PocoPreviewDriver:
    """Adapter for an ALREADY connected, bounded Poco worker and exclusive lease.

    No Airtest connect_device(), installation, ADB command or global cleanup.
    Foreground and lease callbacks must be bounded and read-only; the lease must
    prevent any concurrent controller for the whole run. This module does not
    register a production job or assume a manually supplied boolean is a lease.
    """
    def __init__(self, poco, foreground, lease_valid):
        self.poco = poco
        self.foreground = foreground
        self.lease_valid = lease_valid

    def _guard_host(self):
        if self.lease_valid() is not True:
            raise StopPreview("device_lease_lost")
        if self.foreground() != PACKAGE:
            raise StopPreview("wrong_foreground_app")

    def snapshot(self):
        self._guard_host()
        frozen = self.poco.freeze()
        nodes = []
        for kind in NODE_TYPES:
            for item in list(frozen(type=kind)):
                visible = item.attr("visible")
                enabled = item.attr("enabled")
                if visible is not True:
                    continue
                node = Node(kind=kind, text=item.attr("text") or "",
                            name=item.attr("name") or "", desc=item.attr("contentDescription") or "",
                            enabled=enabled is True,
                            position=tuple(item.get_position()), size=tuple(item.get_size()))
                if node not in nodes:
                    nodes.append(node)
                if len(nodes) > 600:
                    raise StopPreview("hierarchy_too_large")
        self._guard_host()
        return Screen(PACKAGE, tuple(nodes))

    def apply(self, action, expected_screen, phone, check_budget=lambda: None):
        fresh = self.snapshot()
        if fresh != expected_screen:
            raise StopPreview("page_changed_before_action")
        node = resolve_action(action, fresh, phone)
        if node.text:
            selector = {"type": node.kind, "text": node.text}
        elif node.desc:
            selector = {"type": node.kind, "contentDescription": node.desc}
        elif action == "enter_phone" and node.name:
            selector = {"type": node.kind, "name": node.name}
        else:
            raise StopPreview("element_has_no_stable_selector")
        matches = list(self.poco(**selector))
        item = unique(matches)
        # Recheck position and visible/enabled after resolving the live selector.
        if (item.attr("visible") is not True or item.attr("enabled") is not True
                or (item.attr("text") or "") != node.text
                or (item.attr("contentDescription") or "") != node.desc
                or tuple(item.get_position()) != node.position or tuple(item.get_size()) != node.size):
            raise StopPreview("element_changed_before_action")
        self._guard_host()
        check_budget()
        if action == "enter_phone":
            item.set_text(phone)  # One bounded write, followed by exact readback.
        else:
            item.click()  # Only the five explicitly allowed navigation actions.


class ReplayDriver:
    """Offline scenario runner. No device, subprocess or network access."""
    def __init__(self, scenario):
        self.frames = scenario["frames"]
        self.index = 0
        self.actions = []

    def snapshot(self):
        frame = self.frames[self.index]
        return Screen(frame.get("package", PACKAGE), tuple(Node(**n) for n in frame["nodes"]))

    def apply(self, action, expected_screen, phone, check_budget=lambda: None):
        if self.snapshot() != expected_screen:
            raise StopPreview("page_changed_before_action")
        resolve_action(action, expected_screen, phone)
        check_budget()
        frame = self.frames[self.index]
        if frame.get("expectAction") != action:
            raise StopPreview("simulation_action_mismatch")
        self.actions.append(action)
        if self.index + 1 >= len(self.frames):
            raise StopPreview("simulation_missing_frame")
        self.index += 1


def main():
    parser = argparse.ArgumentParser(description="Offline WeCom preview replay; never sends invitations")
    parser.add_argument("--simulate", required=True, help="Synthetic scenario JSON; no live execution mode")
    args = parser.parse_args()
    try:
        with open(args.simulate, encoding="utf-8-sig") as stream:
            scenario = json.load(stream)
        driver = ReplayDriver(scenario)
        outcome = run_preview(driver, scenario["request"], sleep=lambda _: None)
    except Exception:
        outcome = {"status": "stopped", "code": "invalid_simulation", "invitationSent": False}
    print(json.dumps({"result": outcome}, ensure_ascii=True))
    return 0 if outcome["status"] == "ready_before_send" else 2


if __name__ == "__main__":
    raise SystemExit(main())
