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
# For a dedicated host's already connected PocoAgent. Page readiness is polled
# by run_preview; do not add another fixed post-click wait in the SDK.
PREVIEW_POCO_OPTIONS = {"pre_action_wait_for_appearance": 0,
                        "action_interval": 0, "poll_interval": .25}
PACKAGE = "com.tencent.wework"
SEND = "发送添加邀请"
# Device 67's observed WeCom build exposes the + icon as an unlabeled TextView.
# Unknown resource names remain unsupported; no screenshot-coordinate fallback.
OBSERVED_HOME_MENU = "com.tencent.wework:id/nt3"
# Additional + controls visually confirmed on 157, 59 and 93.
# Require the full home context and top-right unique enabled control below.
OBSERVED_HOME_MENUS = (OBSERVED_HOME_MENU, "com.tencent.wework:id/o70", "com.tencent.wework:id/ns5", "com.tencent.wework:id/ns8", "com.tencent.wework:id/n30", "com.tencent.wework:id/nd7")
OBSERVED_PHONE_SEARCH_VIEW = "com.tencent.wework:id/m0f"
OBSERVED_PROFILE_DESCRIPTION = "com.tencent.wework:id/csu"
OBSERVED_PROFILE_DESCRIPTIONS = (OBSERVED_PROFILE_DESCRIPTION, "com.tencent.wework:id/cxu", "com.tencent.wework:id/cso", "com.tencent.wework:id/csn", "com.tencent.wework:id/cii", "com.tencent.wework:id/cm0")
NODE_TYPES = ("android.widget.TextView", "android.widget.Button",
              "android.widget.ImageView", "android.widget.ImageButton",
              "android.widget.EditText", "android.widget.SearchView", "android.view.View",
              "android.view.ViewGroup")
HUMAN_MARKERS = ("请完成验证", "安全验证", "拖动滑块", "拼图", "操作过于频繁",
                 "操作频繁", "添加客户已达上限", "今日添加客户数量已达上限", "同事辅助验证")


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


def is_system_status_indicator(node):
    """Ignore only SystemUI status visuals wholly inside the measured top band.

    Poco includes the separate status-bar window (clock/battery/Wi-Fi activity)
    in WeCom's hierarchy. Keep every app node, body overlay and unknown text;
    the action-time full-page and live-target comparisons remain unchanged.
    """
    background = node.name == 'android:id/statusBarBackground'
    if not background and not node.name.startswith("com.android.systemui:id/"):
        return False
    x, y = node.position
    width, height = node.size
    if (not all(math.isfinite(v) for v in (x, y, width, height))
            or not 0 <= x <= 1 or not 0 <= y <= .05
            or not 0 < width <= 1 or not 0 < height <= (.05 if background else .04)
            or y + height / 2 > .05):
        return False
    if node.desc:
        return False
    if background:
        return node.kind == 'android.view.View' and not node.text
    if node.kind == "android.widget.TextView":
        return ((node.name == "com.android.systemui:id/clock"
                 and re.fullmatch(r"[0-2]?[0-9]:[0-5][0-9]", node.text) is not None)
                or (node.name == "com.android.systemui:id/battery_percentage_view"
                    and re.fullmatch(r"(?:100|[0-9]{1,2})%", node.text) is not None)
                or (node.name == "com.android.systemui:id/battery_text"
                    and re.fullmatch(r"(?:100|[0-9]{1,2})", node.text) is not None)
                or (node.name == "com.android.systemui:id/networkspeed_num"
                    and re.fullmatch(r"[0-9]{1,4}(?:\.[0-9]{1,2})?", node.text) is not None)
                or (node.name == "com.android.systemui:id/networkspeed_unit"
                    and node.text in ("B/s", "KB/s", "MB/s", "GB/s")))
    return (node.kind in ("android.widget.ImageView", "android.view.View", "android.view.ViewGroup")
            and not node.text)


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
    visible_ids = {n.name for n in screen.nodes if n.visible}
    if ({'com.android.systemui:id/qs_detail_back',
         'com.android.systemui:id/detail_items_title'} <= visible_ids
            or {'com.android.systemui:id/settings_button',
                'com.android.systemui:id/notification_container_parent'} <= visible_ids):
        # The underlying resumed Activity can still be WeCom while SystemUI
        # covers it. Stop, never close panels or operate beneath them.
        raise StopPreview('system_overlay_interrupted')
    system_limit = any(n.kind == 'android.widget.TextView' and n.name == 'android:id/message'
                       and n.text in ('添加好友过于频繁', '添加好友过于频繁，请稍后再试', '添加好友过于频繁，请稍后再试。')
                       for n in screen.nodes if n.visible)
    # 152's native WeCom dialog has its own message and action resource IDs.
    wecom_limit = {'com.tencent.wework:id/dnc', 'com.tencent.wework:id/dnf'} <= visible_ids and any(
        n.visible and n.kind == 'android.widget.TextView' and n.name == 'com.tencent.wework:id/dnb'
        and n.text == '添加好友过于频繁，当前功能暂时被限制'
        for n in screen.nodes
    )
    if system_limit or wecom_limit:
        raise StopPreview('wecom_add_friend_too_frequent')
    texts = [v for n in screen.nodes if n.visible for v in (n.text, n.desc)]
    if any(marker in v for v in texts for marker in HUMAN_MARKERS):
        raise StopPreview("human_required")
    if any(screen.has(v) for v in ("手机号登录", "登录", "登录已过期", "重新登录", "登录失效，请重新登录。", "登录失效，请重新登录")):
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
    return (all(screen.has(v) for v in ("发起群聊", "扫一扫"))
            and any(screen.has(v) for v in ("添加客户", "加微信")))


def is_add_page(screen):
    return (all(screen.has(v) for v in ("面对面添加", "搜索手机号添加"))
            and any(screen.has(v) for v in ("添加客户", "添加外部联系人")))


def is_phone_editor(node):
    return (node.kind == "android.widget.EditText" or
            (node.kind == "android.widget.SearchView" and node.name == OBSERVED_PHONE_SEARCH_VIEW))


def is_observed_progress(screen):
    """Observed WeCom modal only; never treat an arbitrary page as loading."""
    nodes = [n for n in screen.nodes if n.visible and not is_system_status_indicator(n)]
    progress = [n for n in nodes if n.kind == "android.widget.TextView"
                and n.name == "com.tencent.wework:id/krm"
                and n.text in ("查找中", "请稍候…")]
    return (screen.package == PACKAGE and len(progress) == 1 and len(nodes) <= 3
            and all(n.kind not in ("android.widget.EditText", "android.widget.Button")
                    and (not n.text or n == progress[0]) for n in nodes))


def editor(screen):
    return unique(screen.matching(is_phone_editor))


def customer_detail_phone(screen):
    # 23's observed already-added view. This recognizes a safe RETURN context,
    # never the current request's result; that still requires exact target match.
    try:guard(screen)
    except StopPreview:return None
    layout=(('n26','客户详情'),('cii','描述'),('cii','设置标签'),('bg6','发消息'))
    # 202's observed already-added native page. Its title and action IDs differ
    # from 23; bind the unlabelled phone value to the actual 电话 row, never a
    # phone-looking nickname or description elsewhere on the screen.
    layout_202=(('o64','客户详情'),('cxu','描述'),('cxu','设置标签'),('cxu','添加时间'),
                ('bsc','发消息'),('bsa','语音通话'))
    def has_layout(values):
        return all(len(screen.matching(lambda n:n.kind=='android.widget.TextView'
            and n.name=='com.tencent.wework:id/'+resource and n.text==label))==1
            for resource,label in values)
    if (screen.has(SEND) or screen.has('添加为联系人') or any(n.visible and is_phone_editor(n)for n in screen.nodes)
        or not (has_layout(layout)or has_layout(layout_202))):
        return None
    if has_layout(layout_202):
        # PocoService Node.getAttr("name") falls back to the native class when
        # resourceId/contentDescription are empty; an XML resource-id stays empty.
        unnamed=lambda n:n.name in ('','android.widget.TextView')
        labels=screen.matching(lambda n:n.kind=='android.widget.TextView'and n.text=='电话'and unnamed(n))
        if len(labels)!=1:return None
        label=labels[0];phones=[]
        for node in screen.matching(lambda n:n.kind=='android.widget.TextView'and unnamed(n)):
            value=re.sub(r'[\s-]','',node.text)
            if not re.fullmatch(r'1[3-9][0-9]{9}',value):continue
            lx,ly=label.position;lw,lh=label.size;nx,ny=node.position;nw,nh=node.size
            if (all(math.isfinite(v)for v in(lx,ly,lw,lh,nx,ny,nw,nh))
                and all(0<=v<=1 for v in(lx,ly,nx,ny))and all(0<v<=1 for v in(lw,lh,nw,nh))
                and nx>lx and lx+lw/2<=nx-nw/2+.015 and abs(ly-ny)<=min(lh,nh)/4):
                phones.append(value)
        return phones[0]if len(phones)==1 else None
    phones=[]
    for node in screen.nodes:
        if not node.visible:continue
        value=re.sub(r'[\s-]','',node.text)
        if value.startswith('电话'):value=value[2:]
        if re.fullmatch(r'1[3-9][0-9]{9}',value):phones.append(value)
    return phones[0]if len(phones)==1 else None


def observed_customer_detail(screen,phone):
    return customer_detail_phone(screen)==phone


def return_from_customer_detail(screen, *, snapshot, foreground, back, check_budget):
    if customer_detail_phone(screen)is None:return False
    if snapshot()!=screen or foreground()!=PACKAGE:
        raise StopPreview('home_navigation_page_changed')
    check_budget()
    back()  # Host provides ONLY its normal lease-guarded keyevent 4.
    return True


def profile_matches(screen, phone):
    # On 67, saving a description replaces the empty settings row with this
    # exact native description row. Keep full target-number verification.
    # 145's external-contact profile omits the tag feature. Require its exact
    # observed title/phone/description/add controls, never an arbitrary row.
    untagged_layout = (("com.tencent.wework:id/o64", "个人信息"),
                       ("com.tencent.wework:id/ldy", "电话"),
                       ("com.tencent.wework:id/cxu", "描述"),
                       ("com.tencent.wework:id/lm", "添加为联系人"))
    observed_untagged = all(len(screen.matching(lambda n: n.kind == "android.widget.TextView"
                           and n.name == resource and n.text == label)) == 1
                           for resource, label in untagged_layout)
    has_remark_entry = observed_untagged or screen.has("设置备注和描述") or (
        screen.has("设置标签") and len(screen.matching(lambda n:
            n.kind == "android.widget.TextView" and n.text == "描述"
            and n.name in OBSERVED_PROFILE_DESCRIPTIONS)) == 1)
    return observed_customer_detail(screen,phone) or (screen.has("个人信息") and has_remark_entry
            and any(n.visible and re.sub(r"[\s-]", "", n.text) in (phone, "电话" + phone)
                    for n in screen.nodes))


DUAL_ACCOUNT_HINT = "对方同时使用微信和企业微信"


def personal_wechat_entry(screen):
    """Recognize the observed dual-account result and return its WeChat row."""
    if not screen.has(DUAL_ACCOUNT_HINT):
        return None
    if not screen.has("个人信息") or screen.has(SEND) or screen.has("添加为联系人"):
        raise StopPreview("dual_wechat_entry_unverified")

    def observed(resource, kind):
        matches = screen.matching(lambda n: n.kind == kind and n.name == PACKAGE + ":id/" + resource)
        if len(matches) != 1:
            raise StopPreview("dual_wechat_entry_unverified")
        return matches[0]

    personal = observed("dz9", "android.widget.TextView")
    personal_icon = observed("dz_", "android.widget.ImageView")
    enterprise = observed("dzg", "android.widget.TextView")
    enterprise_icon = observed("dzh", "android.widget.ImageView")
    if (not personal.text or not enterprise.text
            or abs(personal.position[1] - personal_icon.position[1]) > .03
            or abs(enterprise.position[1] - enterprise_icon.position[1]) > .03
            or not personal.position[1] < enterprise.position[1]):
        raise StopPreview("dual_wechat_entry_unverified")
    return personal


def resolve_action(action, screen, phone):
    """Closed action vocabulary: the final send and remark-save do not exist."""
    guard(screen)
    if screen.has(SEND):
        raise StopPreview("send_boundary_reached")
    if action == "open_menu" and is_home(screen):
        return unique(screen.matching(lambda n: (
            (n.kind in ("android.widget.ImageView", "android.widget.ImageButton", "android.widget.Button")
             and any(n.labeled(v) for v in ("+", "更多", "添加")))
            or (n.kind == "android.widget.TextView" and n.name in OBSERVED_HOME_MENUS
                and not n.text and not n.desc))
            and n.position[0] > 0.75 and n.position[1] < 0.18))
    if action == "open_add" and is_menu(screen):
        return unique(screen.matching(lambda n: n.labeled("添加客户") or n.labeled("加微信")))
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
    if action == "open_personal_wechat":
        node = personal_wechat_entry(screen)
        if node is not None:
            return node
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
    empty_input_frame = None
    home_menu_frame = None
    search_input_frame = None
    search_progress_seen = False
    returned_search_frame = None
    returned_search_count = 0

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

        reads = 0
        while reads < max_reads:
            check_budget()
            screen = driver.snapshot()
            check_budget()
            guard(screen)
            if stage in ("profile", "personal_profile", "preview") and is_observed_progress(screen):
                # An acknowledged operation is still in progress. Keep the
                # original deadline/cancellation; never click it again.
                if stage == "profile":
                    search_progress_seen = True
                    returned_search_frame = None
                    returned_search_count = 0
                sleep(0.25)
                continue
            reads += 1
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
                    guard_observation=getattr(driver,'guard_input_observation',None)
                    if guard_observation is not None:guard_observation()
                    check_budget();resolve_action('open_menu',screen,phone)
                    if home_menu_frame!=screen:
                        observe=getattr(driver,'observe_action_change',None)
                        if home_menu_frame is not None and observe is not None:
                            try:observe('open_menu',home_menu_frame,screen)
                            except Exception:pass
                        home_menu_frame=screen;sleep(.25);continue
                    action, next_stage = "open_menu", "menu"
                else:
                    # Do not inherit an arbitrary chat editor or old customer.
                    raise StopPreview("unsupported_start_page")
            elif stage == "menu" and is_menu(screen):
                action, next_stage = "open_add", "add"
            elif stage == "add" and is_add_page(screen):
                action, next_stage = "open_search", "search"
            elif stage == "search":
                input_guard=getattr(driver,'guard_input_observation',None)
                if input_guard is not None:input_guard()
                check_budget()
                if screen.matching(is_phone_editor):
                    # First write only after two stable, canonical empty frames.
                    # The adapter still compares a THIRD fresh frame before the
                    # single set_text; a later change stops without retry.
                    resolve_action("enter_phone",screen,phone)
                    if empty_input_frame!=screen:
                        observe=getattr(driver,'observe_input_change',None)
                        if empty_input_frame is not None and observe is not None:
                            try:observe(empty_input_frame,screen)
                            except Exception:pass
                        empty_input_frame=screen
                        sleep(.25);continue
                    action, next_stage = "enter_phone", "readback"
                else:
                    empty_input_frame=None
            elif stage == "readback":
                if not screen.matching(is_phone_editor):
                    search_input_frame = None
                    sleep(0.25)
                    continue
                value = editor(screen).text
                if value not in ("", "手机号", phone):
                    raise StopPreview("phone_readback_mismatch")
                if value == phone and screen.matching(lambda n: n.text.startswith("网络查找手机/邮箱")):
                    # The network-search row can appear before the keyboard and
                    # its click listener have settled. Observe two identical
                    # target-bound frames, then use the existing fresh action
                    # guard. This never repeats an already delivered search.
                    resolve_action("search", screen, phone)
                    if search_input_frame != screen:
                        search_input_frame = screen
                        sleep(0.25)
                        continue
                    action, next_stage = "search", "profile"
                else:
                    search_input_frame = None
            elif stage == "profile" and screen.has(DUAL_ACCOUNT_HINT):
                action, next_stage = "open_personal_wechat", "personal_profile"
            elif stage == "personal_profile" and screen.has(DUAL_ACCOUNT_HINT):
                # The tap was already delivered. Wait for the actual profile.
                sleep(.25)
                continue
            elif stage in ("profile", "personal_profile") and (screen.has("个人信息") or screen.has("客户详情")):
                if not profile_matches(screen, phone):
                    raise StopPreview("profile_phone_mismatch")
                if screen.has("发消息"):
                    raise StopPreview("already_contact")
                target_verified = True
                action, next_stage = "open_preview", "preview"
            elif stage == "profile" and search_progress_seen:
                # The observed modal disappeared back to this exact customer's
                # search row. This is neither a profile nor proof of not-found.
                # Require three consecutive identical frames; never tap again.
                try:
                    resolve_action("search", screen, phone)
                except StopPreview:
                    returned_search_frame = None
                    returned_search_count = 0
                else:
                    returned_search_count = returned_search_count + 1 if returned_search_frame == screen else 1
                    returned_search_frame = screen
                    if returned_search_count >= 3:
                        raise StopPreview("wecom_search_returned_without_result")
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
        self._read_started = False
        self.before_action_difference=lambda action,before,after:None

    def _guard_foreground(self):
        if self.foreground() != PACKAGE:
            raise StopPreview("wrong_foreground_app")

    def _guard_host(self):
        if self.lease_valid() is not True:
            raise StopPreview("device_lease_lost")
        self._guard_foreground()

    def snapshot(self):
        # Only the first read acquires fresh host validation. Subsequent reads
        # never touch the UI: every actual mutation below still performs its
        # own real lease + foreground check immediately before execution.
        if not self._read_started:
            self._guard_host()
            self._read_started = True
        else:
            self._guard_foreground()
        frozen = self.poco.freeze()
        nodes = []
        for kind in NODE_TYPES:
            query = frozen(type=kind)
            # Real Poco raises NoSuchNode while iterating an empty proxy;
            # len(proxy) is its supported zero-match check. Do not swallow
            # transport failures or skip nodes from a changed live hierarchy.
            if len(query) == 0:
                continue
            for item in list(query):
                visible = item.attr("visible")
                enabled = item.attr("enabled")
                if visible is not True:
                    continue
                node = Node(kind=kind, text=item.attr("text") or "",
                            name=item.attr("name") or "", desc=item.attr("contentDescription") or "",
                            enabled=enabled is True,
                            position=tuple(item.get_position()), size=tuple(item.get_size()))
                if is_system_status_indicator(node):
                    continue
                if node not in nodes:
                    nodes.append(node)
                if len(nodes) > 600:
                    raise StopPreview("hierarchy_too_large")
        screen = Screen(PACKAGE, tuple(nodes))
        # Readiness is an externally visible outcome, so validate it too.
        # A later run reusing this driver must pass the initial read gate again.
        if screen.has(SEND):
            self._guard_host()
            self._read_started = False
        return screen

    def guard_input_observation(self):self._guard_host()

    def observe_input_change(self,before,after):
        self.observe_action_change('enter_phone',before,after)

    def observe_action_change(self,action,before,after):
        try:self.before_action_difference(action,before,after)
        except Exception:pass  # Diagnostic failure never replaces the input guard.

    def apply(self, action, expected_screen, phone, check_budget=lambda: None):
        fresh = self.snapshot()
        if fresh != expected_screen:
            if action in ('enter_phone','open_menu'):self.observe_action_change(action,expected_screen,fresh)
            raise StopPreview("page_changed_before_action")
        node = resolve_action(action, fresh, phone)
        if action == "open_personal_wechat":
            selector = {"type": node.kind, "name": node.name, "text": node.text}
        elif node.text:
            selector = {"type": node.kind, "text": node.text}
        elif node.desc:
            selector = {"type": node.kind, "contentDescription": node.desc}
        elif action in ("enter_phone", "open_menu") and node.name:
            selector = {"type": node.kind, "name": node.name}
        else:
            raise StopPreview("element_has_no_stable_selector")
        matches = list(self.poco(**selector))
        item = unique(matches)
        # Recheck position and visible/enabled after resolving the live selector.
        if (item.attr("visible") is not True or item.attr("enabled") is not True
                or (item.attr("text") or "") != node.text
                or (action == "open_personal_wechat" and (item.attr("name") or "") != node.name)
                or (item.attr("contentDescription") or "") != node.desc
                or tuple(item.get_position()) != node.position or tuple(item.get_size()) != node.size):
            raise StopPreview("element_changed_before_action")
        self._guard_host()
        check_budget()
        if action == "enter_phone":
            item.set_text(phone)  # One bounded write, followed by exact readback.
        else:
            item.click()  # Only explicitly allowed navigation actions.


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
