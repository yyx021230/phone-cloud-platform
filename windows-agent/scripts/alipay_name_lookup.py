#!/usr/bin/env python3
"""State-preserving, element-driven Alipay masked-name lookup task runner.

Each invocation is short lived, while the phone remains on Alipay's global
search page between invocations. A query therefore reuses the visible page;
only an evidenced abnormal state triggers a bounded full-path recovery.
"""
import argparse
import json
import os
import random
import re
import subprocess
import time
import traceback
import xml.etree.ElementTree as ET

ALIPAY_PACKAGE = "com.eg.android.AlipayGphone"
ALIPAY_HOME = "com.eg.android.AlipayGphone/.AlipayLogin"
ALIPAY_LOGIN_ACTIVITY = "com.ali.user.mobile.loginupgrade.activity.LoginActivity"
SEARCH_INPUT_ID = "com.alipay.mobile.antui:id/search_input_box"
ACCOUNT_ID = "com.alipay.mobile.securitybiz:id/tv_am_item_account"
ACCOUNT_CURRENT_ID = "com.alipay.mobile.securitybiz:id/tv_am_item_current"
TAB_DESCRIPTION_ID = "com.alipay.android.tablauncher:id/tab_description"
SETTINGS_ENTRY_ID = "com.alipay.mobile.antui:id/right_text"
VERIFICATION_TITLE = "为保障您的正常访问请进行验证"
VERIFICATION_ACTION = "向右滑动验证"
JIGSAW_VERIFICATION_ACTION = "请拖动滑块完成拼图"
JIGSAW_FEEDBACK_PREFIX = "反馈码:"
ACCESS_DENIED_TITLE = "访问被拒绝"
ACCESS_DENIED_PROXY_HINT = "代理软件"
ACCESS_DENIED_VPN_HINT = "VPN"
DEVICE_RISK_TITLE = "您的设备可能存在风险，请检查或切换设备"
DEVICE_RISK_HINT = "检查或切换设备后，请等待一段时间再试"
FREQUENT_OR_ABNORMAL_ACCESS_TITLE = "操作频繁或访问异常，请稍后再试"
FREQUENT_OR_ABNORMAL_ACCESS_HINT = "请稍后"
COLOROS_SECUREPAY_PACKAGE = "com.coloros.securepay"
COLOROS_USB_TRANSFER_TITLE = "已允许 USB 传输数据，请切换为“仅充电”后再使用支付应用。"
COLOROS_REMOTE_CONTROL_RISK = "存在被远程控制、泄露隐私的风险。"
COLOROS_IGNORE_BUTTON_ID = "android:id/button2"
ACCOUNT_SWITCH_REASONS = {
    "access_denied", "device_risk", "frequent_or_abnormal_access",
}
# Leave room for Agent dispatch and result persistence so the user-visible
# no-name response stays close to five seconds end to end.
POCO_NO_NAME_RESULT_SECONDS = 4.4
POCO_SEARCH_SUBMIT_DELAY_SECONDS = 0.4
QUERY_INPUT_DELAY_MIN_SECONDS = 3.0
QUERY_INPUT_DELAY_MAX_SECONDS = 10.0


class Runner:
    def __init__(self, payload):
        self.payload = payload
        self.serial = str(payload["serial"])
        self.adb_path = str(payload.get("adbPath") or "adb")
        self.task_id = re.sub(r"[^0-9A-Za-z_.-]", "_", str(payload.get("taskId") or int(time.time() * 1000)))
        self.log = []
        self.started = time.perf_counter()
        self.human_verification_passes = 0
        self.account_switched = False
        self.current_account_after_switch = ""
        self.account_switch_reason = ""
        self.account_switch_history = []
        self.restricted_accounts = set()
        self.saved_account_count = 0
        self._display_size = None

    def emit(self, step, **detail):
        item = {"step": step, "elapsedMs": int((time.perf_counter() - self.started) * 1000), **detail}
        self.log.append(item)
        print(json.dumps({"event": item}, ensure_ascii=True), flush=True)

    def wait_before_phone_input(self, driver):
        delay_seconds = random.uniform(
            QUERY_INPUT_DELAY_MIN_SECONDS, QUERY_INPUT_DELAY_MAX_SECONDS,
        )
        self.emit(
            "query_input_throttle_wait", driver=driver,
            minSeconds=QUERY_INPUT_DELAY_MIN_SECONDS,
            maxSeconds=QUERY_INPUT_DELAY_MAX_SECONDS,
            delayMs=int(round(delay_seconds * 1000)),
        )
        time.sleep(delay_seconds)
        return delay_seconds

    def adb(self, args, timeout=20, check=True, binary=False):
        proc = subprocess.run(
            [self.adb_path, "-s", self.serial, *args], capture_output=True,
            text=not binary, encoding=None if binary else "utf-8",
            errors=None if binary else "ignore", timeout=timeout,
        )
        if check and proc.returncode:
            detail = proc.stderr if binary else (proc.stderr or proc.stdout)
            if isinstance(detail, bytes):
                detail = detail.decode("utf-8", "ignore")
            raise RuntimeError((detail or f"adb exited {proc.returncode}").strip())
        return proc.stdout

    def focus(self):
        output = self.adb(["shell", "dumpsys", "window"], timeout=10, check=False)
        return [line.strip() for line in str(output).splitlines() if "mCurrentFocus" in line or "mFocusedApp" in line]

    def keep_awake_usb_best_effort(self):
        """Keep the screen awake without making a transient shell stall fatal.

        Device state and package availability are hard preconditions checked by
        the caller.  `svc power stayon usb` is only a convenience and some OEM
        shells have been observed to time out once while the next shell command
        succeeds normally, so retain evidence and continue.
        """
        try:
            self.adb(["shell", "svc", "power", "stayon", "usb"], timeout=2, check=False)
            return True
        except Exception as exc:
            self.emit(
                "keep_awake_usb_skipped",
                reason="noncritical_adb_shell_unavailable",
                errorType=type(exc).__name__,
            )
            return False

    def wake_and_unlock_for_lookup_start(self):
        """Wake the display before reading the foreground Poco hierarchy.

        KEYCODE_WAKEUP is normally idempotent, but vivo V2442A on Android 14
        has been observed to leave ``mWakefulness=Asleep`` after accepting it.
        Only when a read-only power-state check proves that the screen is still
        asleep do we send KEYCODE_POWER, avoiding the risk of toggling an
        already-awake display off.
        """
        self.adb(["shell", "input", "keyevent", "224"], timeout=5, check=False)
        self.adb(["shell", "wm", "dismiss-keyguard"], timeout=5, check=False)
        power_state = str(self.adb(
            ["shell", "dumpsys", "power"], timeout=5, check=False,
        ))
        if re.search(r"mWakefulness\s*=\s*Asleep\b", power_state, re.IGNORECASE):
            self.adb(["shell", "input", "keyevent", "26"], timeout=5, check=False)
            self.adb(["shell", "wm", "dismiss-keyguard"], timeout=5, check=False)
            self.emit(
                "wake_display_power_fallback",
                reason="keycode_wakeup_left_device_asleep",
                driver="adb_power_state_guard",
            )
        else:
            self.emit("wake_display_ready", driver="adb_keycode_wakeup")

    def display_size(self):
        if self._display_size:
            return self._display_size
        output = str(self.adb(["shell", "wm", "size"], timeout=5, check=False))
        matches = re.findall(r"(\d+)x(\d+)", output)
        self._display_size = tuple(map(int, matches[-1])) if matches else (1080, 2400)
        return self._display_size

    def poco_tap(self, node):
        """Use Poco for element location, but keep the actual tap bounded by ADB."""
        x, y = node.get_position()
        width, height = self.display_size()
        px = max(1, min(width - 1, int(round(x * width))))
        py = max(1, min(height - 1, int(round(y * height))))
        self.adb(["shell", "input", "tap", str(px), str(py)], timeout=5)

    @staticmethod
    def bounds_center(bounds):
        values = [int(value) for value in re.findall(r"\d+", bounds or "")]
        if len(values) != 4:
            raise RuntimeError(f"invalid bounds: {bounds!r}")
        return (values[0] + values[2]) // 2, (values[1] + values[3]) // 2

    @staticmethod
    def bounds_values(bounds):
        values = [int(value) for value in re.findall(r"\d+", bounds or "")]
        if len(values) != 4:
            raise RuntimeError(f"invalid bounds: {bounds!r}")
        return values

    def dump(self, token, command_timeout=15, read_timeout=12, allow_tty_fallback=True):
        remote = f"/sdcard/PhoneCloud/.alipay-name-{self.task_id}-{token}.xml"
        self.adb(["shell", "mkdir", "-p", "/sdcard/PhoneCloud"], timeout=8)
        self.adb(["shell", "uiautomator", "dump", remote], timeout=command_timeout, check=False)
        raw = self.adb(["exec-out", "cat", remote], timeout=read_timeout, binary=True)
        if b"<hierarchy" not in raw and allow_tty_fallback:
            raw = self.adb(
                ["exec-out", "uiautomator", "dump", "/dev/tty"],
                timeout=command_timeout,
                check=False,
                binary=True,
            )
        decoded = raw.decode("utf-8", "replace")
        start, end = decoded.find("<hierarchy"), decoded.rfind("</hierarchy>")
        if start < 0 or end < start:
            raise RuntimeError("uiautomator_hierarchy_missing")
        root = ET.fromstring(decoded[start:end + len("</hierarchy>")])
        parent = {child: node for node in root.iter() for child in node}
        return root, parent

    @staticmethod
    def find(root, text=None, desc=None, resource_id=None):
        result = []
        for node in root.iter("node"):
            if text is not None and (node.get("text") or "").strip() != text:
                continue
            if desc is not None and (node.get("content-desc") or "").strip() != desc:
                continue
            if resource_id is not None and (node.get("resource-id") or "").strip() != resource_id:
                continue
            result.append(node)
        return result

    @staticmethod
    def texts(root, limit=100):
        values = []
        for node in root.iter("node"):
            for key in ("text", "content-desc"):
                value = (node.get(key) or "").strip()
                if value and value not in values:
                    values.append(value)
                    if len(values) >= limit:
                        return values
        return values

    def verification_evidence(self, root):
        texts = set(self.texts(root, 120))
        protected = VERIFICATION_TITLE
        action = JIGSAW_VERIFICATION_ACTION if JIGSAW_VERIFICATION_ACTION in texts else VERIFICATION_ACTION
        feedback = next((value for value in texts if value.startswith(JIGSAW_FEEDBACK_PREFIX)), "")
        if protected in texts or action in texts or feedback:
            return {
                "title": protected if protected in texts else "",
                "action": action if action in texts else "",
                "feedback": feedback,
                "manual": action == JIGSAW_VERIFICATION_ACTION or bool(feedback),
            }
        return None

    @staticmethod
    def access_denied_evidence_from_texts(values):
        normalized = [re.sub(r"\s+", "", str(value or "")) for value in values]
        title = next((value for value in normalized if value == ACCESS_DENIED_TITLE), "")
        hint = next((
            value for value in normalized
            if ACCESS_DENIED_PROXY_HINT in value and ACCESS_DENIED_VPN_HINT in value.upper()
        ), "")
        if not title or not hint:
            return None
        return {"title": title, "hint": hint}

    def access_denied_evidence(self, root):
        return self.access_denied_evidence_from_texts(self.texts(root, 120))

    @classmethod
    def account_restriction_evidence_from_texts(cls, values):
        normalized = [re.sub(r"\s+", "", str(value or "")) for value in values]
        access_denied = cls.access_denied_evidence_from_texts(normalized)
        if access_denied:
            return {"reason": "access_denied", **access_denied}
        if DEVICE_RISK_TITLE in normalized and DEVICE_RISK_HINT in normalized:
            return {
                "reason": "device_risk",
                "title": DEVICE_RISK_TITLE,
                "hint": DEVICE_RISK_HINT,
            }
        if (
            FREQUENT_OR_ABNORMAL_ACCESS_TITLE in normalized
            and FREQUENT_OR_ABNORMAL_ACCESS_HINT in normalized
        ):
            return {
                "reason": "frequent_or_abnormal_access",
                "title": FREQUENT_OR_ABNORMAL_ACCESS_TITLE,
                "hint": FREQUENT_OR_ABNORMAL_ACCESS_HINT,
            }
        return None

    def account_restriction_evidence(self, root):
        return self.account_restriction_evidence_from_texts(self.texts(root, 160))

    @staticmethod
    def account_switch_reason_from_error(error):
        raw = str(error or "")
        if "alipay_access_denied_account_switch_required" in raw:
            return "access_denied"
        match = re.search(
            r"alipay_account_restriction_(?:switch_required|before_search):([a-z_]+)",
            raw,
        )
        reason = match.group(1) if match else ""
        return reason if reason in ACCOUNT_SWITCH_REASONS else ""

    def raise_account_restriction(self, evidence, phase, driver, phone_query_started=False):
        reason = str(evidence.get("reason") or "")
        event = "alipay_access_denied_detected" if reason == "access_denied" else "alipay_account_restriction_detected"
        self.emit(
            event,
            phase=phase,
            driver=driver,
            reason=reason,
            title=evidence.get("title", ""),
            phoneQueryStarted=bool(phone_query_started),
            accountSwitchRequired=bool(phone_query_started),
        )
        if not phone_query_started:
            raise RuntimeError(f"alipay_account_restriction_before_search:{reason}")
        if reason == "access_denied":
            raise RuntimeError("alipay_access_denied_account_switch_required")
        raise RuntimeError(f"alipay_account_restriction_switch_required:{reason}")

    def raise_access_denied(self, evidence, phase, driver):
        self.raise_account_restriction({"reason": "access_denied", **evidence}, phase, driver)

    def return_to_home_for_account_switch(self, evidence, token):
        """Leave an evidenced restriction surface without treating it as healthy."""
        for attempt in range(1, 5):
            self.adb(["shell", "input", "keyevent", "4"], timeout=5, check=False)
            time.sleep(0.45)
            root, parent = self.dump(f"{token}-restriction-back-{attempt}")
            if len(self.find(root, text="我的", resource_id=TAB_DESCRIPTION_ID)) == 1:
                self.emit(
                    "account_restriction_dismissed_for_switch",
                    reason=evidence.get("reason", ""), attempt=attempt,
                )
                return root, parent
        raise RuntimeError(
            f"alipay_account_restriction_home_recovery_failed:{evidence.get('reason', '')}"
        )

    def find_slider_anchor(self, root):
        """Locate the current slider hint/knob from exact UI evidence."""
        for node in root.iter("node"):
            bounds = node.get("bounds")
            if not bounds:
                continue
            text = (node.get("text") or "").strip()
            desc = (node.get("content-desc") or "").strip()
            if "滑动" in text or "滑动" in desc or "向右" in text:
                return self.bounds_values(bounds)
        return None

    def find_slider_track(self, root, anchor):
        """Find the widest short horizontal element aligned with the slider."""
        if anchor is None:
            return None
        anchor_y = (anchor[1] + anchor[3]) // 2
        best, best_width = None, -1
        for node in root.iter("node"):
            bounds = node.get("bounds")
            if not bounds:
                continue
            x1, y1, x2, y2 = self.bounds_values(bounds)
            width, height = x2 - x1, y2 - y1
            if height <= 0 or height > 160 or width <= 150:
                continue
            if not (y1 - 40 <= anchor_y <= y2 + 40):
                continue
            if width > best_width:
                best, best_width = (x1, y1, x2, y2), width
        return best

    def slider_area_nodes(self, root, anchor_y):
        nodes = []
        for node in root.iter("node"):
            bounds = node.get("bounds")
            if not bounds:
                continue
            x1, y1, x2, y2 = self.bounds_values(bounds)
            if not (y1 - 60 <= anchor_y <= y2 + 60):
                continue
            text = (node.get("text") or "").strip()
            desc = (node.get("content-desc") or "").strip()
            if text or desc:
                nodes.append({
                    "text": text[:40], "desc": desc[:40],
                    "class": node.get("class") or "", "bounds": [x1, y1, x2, y2],
                })
        return nodes

    def solve_human_verification(self, root, parent, token, max_attempts=3):
        """Drag the evidenced Alipay slider and verify that it disappeared."""
        evidence = self.verification_evidence(root)
        if not evidence:
            return root, parent
        anchor = self.find_slider_anchor(root)
        anchor_y = (anchor[1] + anchor[3]) // 2 if anchor else None
        self.emit(
            "human_verification_detected", evidence=evidence, token=token,
            sliderAreaNodes=self.slider_area_nodes(root, anchor_y) if anchor_y is not None else [],
        )
        if evidence.get("manual"):
            raise RuntimeError("alipay_human_verification_required:jigsaw_verification")
        for attempt in range(1, max_attempts + 1):
            anchor = self.find_slider_anchor(root)
            track = self.find_slider_track(root, anchor)
            if anchor is None or track is None:
                self.emit(
                    "human_verification_geometry_missing", attempt=attempt,
                    anchorFound=anchor is not None, trackFound=track is not None,
                    texts=self.texts(root, 60),
                )
                break
            x1, y1, x2, y2 = track
            knob_half = max(8, (y2 - y1) // 2)
            start_x, start_y = x1 + knob_half, (y1 + y2) // 2
            screen_right = max(
                (self.bounds_values(node.get("bounds"))[2]
                 for node in root.iter() if node.get("bounds")),
                default=x2,
            )
            end_x, end_y = max(x2 - knob_half, screen_right - 10), start_y
            duration_ms = 2200 + (attempt - 1) * 300
            self.adb([
                "shell", "input", "swipe", str(start_x), str(start_y),
                str(end_x), str(end_y), str(duration_ms),
            ], timeout=15)
            self.emit(
                "human_verification_slider_drag", attempt=attempt, track=list(track),
                start=[start_x, start_y], end=[end_x, end_y], durationMs=duration_ms,
            )
            time.sleep(1.5)
            root, parent = self.dump(f"{token}-verify-{attempt}")
            if not self.verification_evidence(root):
                self.human_verification_passes += 1
                self.emit("human_verification_passed", attempt=attempt, token=token)
                return root, parent
            self.emit("human_verification_retry", attempt=attempt, texts=self.texts(root, 60))
        self.emit("human_verification_failed", token=token, attempts=max_attempts)
        raise RuntimeError("alipay_basic_slider_verification_failed")

    def solve_verification_from_xml_if_present(self, token):
        """Bridge a Poco-blind Alipay challenge using exact UIAutomator evidence."""
        poco_released = False
        try:
            root, parent = self.dump(
                f"{token}-verification-probe",
                command_timeout=6, read_timeout=4, allow_tty_fallback=False,
            )
        except Exception as exc:
            self.emit(
                "verification_xml_probe_unavailable", token=token,
                error=str(exc), driver="xml_uiautomator_probe",
            )
            if "uiautomator_hierarchy_missing" not in str(exc):
                return False
            try:
                from xhs_airtest_poco import release_poco_for_confirm_xml
                release_poco_for_confirm_xml(self.adb_path, self.serial, self.log)
                poco_released = True
                root, parent = self.dump(
                    f"{token}-verification-after-poco-release",
                    command_timeout=8, read_timeout=5, allow_tty_fallback=True,
                )
            except Exception as release_exc:
                raise RuntimeError(
                    f"poco_rpc_failed:verification_xml_handoff_failed:{release_exc}"
                ) from release_exc
        evidence = self.verification_evidence(root)
        if not evidence:
            if poco_released:
                raise RuntimeError(
                    "poco_rpc_failed:verification_xml_handoff_no_challenge:"
                    "worker_reattach_required"
                )
            return False
        self.emit(
            "verification_recovered_from_xml", token=token, evidence=evidence,
            driver="xml_uiautomator_probe", resubmitsInput=False,
        )
        self.solve_human_verification(root, parent, token)
        if poco_released:
            raise RuntimeError(
                "poco_rpc_failed:basic_slider_solved_worker_reattach_required"
            )
        return True

    @staticmethod
    def tappable(node, parent):
        current = node
        while current is not None:
            if current.get("bounds") and current.get("enabled", "true") != "false" and current.get("clickable") == "true":
                return current
            current = parent.get(current)
        return node if node.get("bounds") else None

    def tap_unique(self, root, parent, label, **selector):
        matches = self.find(root, **selector)
        if len(matches) != 1:
            raise RuntimeError(f"{label}: expected one exact element, got {len(matches)}")
        target = self.tappable(matches[0], parent)
        x, y = self.bounds_center(target.get("bounds"))
        self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
        self.emit(label, selector=selector, tap={"x": x, "y": y})
        return matches[0]

    @staticmethod
    def coloros_securepay_usb_evidence(root):
        """Return exact evidence for ColorOS's USB/remote-control warning.

        The dialog also exposes a "仅充电" action which can tear down the
        phone's data/ADB path.  Requiring the vendor package, both exact message
        elements, and the exact secondary action id keeps recovery fail-closed.
        """
        nodes = list(root.iter("node"))

        def exact(text, resource_id):
            return [
                node for node in nodes
                if (node.get("package") or "").strip() == COLOROS_SECUREPAY_PACKAGE
                and (node.get("text") or "").strip() == text
                and (node.get("resource-id") or "").strip() == resource_id
            ]

        titles = exact(COLOROS_USB_TRANSFER_TITLE, "com.coloros.securepay:id/alertTitle")
        messages = exact(COLOROS_REMOTE_CONTROL_RISK, "com.coloros.securepay:id/tv_message")
        ignores = exact("忽略", COLOROS_IGNORE_BUTTON_ID)
        if len(titles) != 1 or len(messages) != 1 or len(ignores) != 1:
            return None
        return {"title": titles[0], "message": messages[0], "ignore": ignores[0]}

    def dismiss_coloros_securepay_usb_dialog(self, root=None, parent=None, driver="xml_uiautomator"):
        """Dismiss the evidenced ColorOS warning without changing USB mode."""
        if root is None:
            # Avoid starting UIAutomator on a normal/slow Alipay page.  The
            # hierarchy probe is allowed only after Poco missed its target and
            # WindowManager proves that ColorOS SecurePay owns the foreground.
            focus = "\n".join(self.focus())
            if COLOROS_SECUREPAY_PACKAGE not in focus:
                return False
            try:
                root, parent = self.dump(
                    "coloros-securepay-usb-warning",
                    command_timeout=4,
                    read_timeout=4,
                    allow_tty_fallback=False,
                )
            except Exception as exc:
                # Some older ColorOS builds do not let a second UiAutomation
                # client coexist with the resident Poco instrumentation.  Ask
                # the Agent to stop Poco and enter its clean XML fallback now,
                # instead of consuming the normal two-stage dump budget.
                self.emit(
                    "coloros_securepay_probe_deferred_to_clean_xml",
                    errorType=type(exc).__name__,
                    driver=driver,
                )
                raise RuntimeError("coloros_securepay_requires_clean_xml_fallback") from exc
        evidence = self.coloros_securepay_usb_evidence(root)
        if not evidence:
            return False
        parent = parent or {child: node for node in root.iter() for child in node}
        target = self.tappable(evidence["ignore"], parent)
        if target is None:
            raise RuntimeError("coloros_securepay_ignore_not_tappable")
        x, y = self.bounds_center(target.get("bounds"))
        self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
        self.emit(
            "dismiss_coloros_securepay_usb_warning",
            driver=driver,
            selector={"package": COLOROS_SECUREPAY_PACKAGE, "resourceId": COLOROS_IGNORE_BUTTON_ID, "text": "忽略"},
            usbModeChanged=False,
            tap={"x": x, "y": y},
        )
        deadline = time.time() + 3.0
        while time.time() < deadline:
            if COLOROS_SECUREPAY_PACKAGE not in "\n".join(self.focus()):
                time.sleep(0.2)
                return True
            time.sleep(0.15)
        raise RuntimeError("coloros_securepay_usb_warning_dismiss_timeout")

    def dismiss_unverified_account_modal_visual(self):
        """Dismiss Alipay's Canvas-only "account not verified" home modal.

        Some Alipay builds render this modal completely outside the
        accessibility hierarchy.  The underlying Home/My nodes are still
        exposed, so repeated element taps are silently consumed by the modal.
        Require the modal's responsive geometry (large bright centre card,
        blue CTA, dim surround, and a centred lower close ring) before tapping
        its detected close control.  This keeps the fallback fail-closed and
        avoids a blind coordinate or Back action on a normal home page.
        """
        try:
            import cv2
            import numpy as np

            raw = self.adb(["exec-out", "screencap", "-p"], timeout=15, binary=True)
            image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                return False
            height, width = image.shape[:2]
            if width < 300 or height < 600:
                return False
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            card = gray[int(height * .30):int(height * .69), int(width * .14):int(width * .86)]
            surround = gray[int(height * .34):int(height * .66), int(width * .02):int(width * .11)]
            cta = image[int(height * .60):int(height * .69), int(width * .22):int(width * .78)]
            if not card.size or not surround.size or not cta.size:
                return False
            bright_card_ratio = float((card >= 225).mean())
            dim_surround_ratio = float((surround <= 175).mean())
            blue_cta_ratio = float((
                (cta[:, :, 0] >= 150)
                & (cta[:, :, 0] >= cta[:, :, 1] * .95)
                & (cta[:, :, 2] <= 120)
            ).mean())
            if bright_card_ratio < .48 or dim_surround_ratio < .60 or blue_cta_ratio < .12:
                return False

            lower = gray[int(height * .71):int(height * .84), :]
            binary = (lower >= 205).astype(np.uint8)
            count, _, stats, centers = cv2.connectedComponentsWithStats(binary)
            candidates = []
            for index in range(1, count):
                x, y, component_width, component_height, area = stats[index]
                center_x, center_y = centers[index]
                absolute_y = float(center_y + int(height * .71))
                if not (width * .42 <= center_x <= width * .58):
                    continue
                if not (height * .735 <= absolute_y <= height * .82):
                    continue
                if not (width * .055 <= component_width <= width * .13):
                    continue
                if not (width * .055 <= component_height <= width * .13):
                    continue
                aspect = component_width / max(1.0, float(component_height))
                if not (.72 <= aspect <= 1.38):
                    continue
                if area < width * height * .00022:
                    continue
                candidates.append((int(round(center_x)), int(round(absolute_y)), int(area)))
            if len(candidates) != 1:
                return False
            tap_x, tap_y, area = candidates[0]
            self.adb(["shell", "input", "tap", str(tap_x), str(tap_y)], timeout=8)
            self.emit(
                "dismiss_alipay_unverified_account_modal",
                method="responsive_modal_close_detection",
                evidence={
                    "brightCardRatio": round(bright_card_ratio, 3),
                    "dimSurroundRatio": round(dim_surround_ratio, 3),
                    "blueCtaRatio": round(blue_cta_ratio, 3),
                    "closeComponentArea": area,
                },
                tap={"x": tap_x, "y": tap_y},
            )
            time.sleep(0.5)
            return True
        except Exception as exc:
            self.emit(
                "unverified_account_modal_visual_probe_failed",
                errorType=type(exc).__name__,
            )
            return False

    def dismiss_known_overlay(self, root=None, parent=None):
        if "com.hihonor.hndockbar.DockTipDialogActivity" in "\n".join(self.focus()):
            self.adb(["shell", "input", "keyevent", "4"], timeout=5, check=False)
            self.emit("dismiss_honor_dock_tip")
            time.sleep(0.5)
            return True
        if root is None:
            root, parent = self.dump("overlay")
        ads, closes = self.find(root, desc="全屏广告"), self.find(root, desc="关闭")
        if len(ads) == 1 and len(closes) == 1:
            target = self.tappable(closes[0], parent)
            x, y = self.bounds_center(target.get("bounds"))
            self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
            self.emit("dismiss_alipay_fullscreen_ad", tap={"x": x, "y": y})
            time.sleep(0.5)
            return True
        if self.dismiss_unverified_account_modal_visual():
            return True
        return False

    def launch(self, reason):
        self.adb(["shell", "input", "keyevent", "224"], timeout=8, check=False)
        self.adb(["shell", "wm", "dismiss-keyguard"], timeout=8, check=False)
        self.adb(["shell", "am", "force-stop", ALIPAY_PACKAGE], timeout=8)
        output = self.adb([
            "shell", "am", "start", "-W", "-f", "0x10008000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", ALIPAY_HOME,
        ], timeout=25, check=False)
        self.emit("launch_alipay", reason=reason, detail=str(output)[-600:])
        time.sleep(1.0)
        self.dismiss_known_overlay()

    def wait_unique(self, token, timeout=12, **selector):
        deadline = time.time() + timeout
        root = parent = None
        securepay_recoveries = 0
        while time.time() < deadline:
            root, parent = self.dump(token)
            restriction = self.account_restriction_evidence(root)
            if restriction:
                self.raise_account_restriction(restriction, token, "xml_uiautomator")
            verification = self.verification_evidence(root)
            if verification:
                root, parent = self.solve_human_verification(root, parent, token)
            matches = self.find(root, **selector)
            if len(matches) == 1:
                return root, parent, matches[0]
            if len(matches) > 1:
                raise RuntimeError(f"selector_not_unique:{selector!r}")
            if securepay_recoveries < 1 and self.dismiss_coloros_securepay_usb_dialog(
                root, parent, driver="xml_uiautomator",
            ):
                securepay_recoveries += 1
                self.emit("retry_target_after_coloros_securepay_warning", selector=selector, driver="xml_uiautomator")
                continue
            time.sleep(0.35)
        raise RuntimeError(f"selector_missing:{selector!r}; texts={self.texts(root, 50)!r}; focus={self.focus()!r}")

    def open_search(self, reason):
        root, parent, _ = self.wait_unique(f"home-{reason}", desc="搜索框")
        if self.dismiss_known_overlay(root, parent):
            root, parent, _ = self.wait_unique(f"home-{reason}-after-overlay", desc="搜索框")
        self.tap_unique(root, parent, "open_search", desc="搜索框")
        time.sleep(0.7)
        self.wait_unique(f"search-{reason}", resource_id=SEARCH_INPUT_ID)

    def prepare_full_path(self, reason):
        self.launch(reason)
        self.open_search(reason)

    def try_reuse_search_page(self):
        focus = "\n".join(self.focus())
        if "com.eg.android.AlipayGphone" in focus and "MainSearchActivity" in focus:
            self.search_ready()
            self.emit("reuse_existing_search_page", method="already_foreground")
            return True
        activities = self.adb(["shell", "dumpsys", "activity", "activities"], timeout=12, check=False)
        if "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity" not in str(activities):
            return False
        self.adb([
            "shell", "am", "start", "-W", "-f", "0x10200000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", ALIPAY_HOME,
        ], timeout=20, check=False)
        time.sleep(0.7)
        self.dismiss_known_overlay()
        self.search_ready()
        self.emit("reuse_existing_search_page", method="resume_existing_task")
        return True

    def search_ready(self):
        focus = "\n".join(self.focus())
        if "com.eg.android.AlipayGphone" not in focus or "MainSearchActivity" not in focus:
            try:
                root, _ = self.dump("search-ready-focus")
                restriction = self.account_restriction_evidence(root)
                if restriction:
                    self.raise_account_restriction(restriction, "search-ready-focus", "xml_uiautomator")
            except Exception as exc:
                if self.account_switch_reason_from_error(exc):
                    raise
                self.emit("account_restriction_probe_unavailable", phase="search-ready-focus", driver="xml_uiautomator", error=str(exc))
            raise RuntimeError(f"alipay_search_not_foreground:{focus}")
        root, parent, input_node = self.wait_unique("search-ready", timeout=5, resource_id=SEARCH_INPUT_ID)
        verification = self.verification_evidence(root)
        if verification:
            root, parent = self.solve_human_verification(root, parent, "search-ready")
            matches = self.find(root, resource_id=SEARCH_INPUT_ID)
            if len(matches) != 1:
                raise RuntimeError("search_input_missing_after_human_verification")
            input_node = matches[0]
        return root, parent, input_node

    def focused_search_input_ready(self):
        """Prove that the reusable Alipay search EditText still owns input focus.

        This is an element-identity fast path, not a coordinate shortcut.  If
        either the foreground Activity or the served resource id differs, the
        caller falls back to the full UIAutomator hierarchy check.
        """
        focus = "\n".join(self.focus())
        if "com.eg.android.AlipayGphone" not in focus or "MainSearchActivity" not in focus:
            return False
        state = str(self.adb(["shell", "dumpsys", "input_method"], timeout=8, check=False))
        served = re.search(
            r"mServedView=.*com\.alipay\.mobile\.antui:id/search_input_box",
            state,
        )
        current_editor = re.search(
            r"mCurrent(?:EditorInfo|TextBoxAttribute):[\s\S]{0,800}?"
            r"packageName=com\.eg\.android\.AlipayGphone",
            state,
        )
        return bool(served and current_editor)

    def focused_search_input_length(self):
        """Return the real focused EditText cursor length, excluding its hint.

        Alipay exposes rotating search hints through Accessibility/Poco's
        ``text`` attribute even while the EditText is actually empty. Some
        hints contain digits (for example an amount), so digit-counting that
        attribute can incorrectly look like a partially entered phone. The
        active input connection's cursor is based on editable content and does
        not include the hint.
        """
        focus = "\n".join(self.focus())
        if "com.eg.android.AlipayGphone" not in focus or "MainSearchActivity" not in focus:
            return None
        state = str(self.adb(
            ["shell", "dumpsys", "input_method"], timeout=8, check=False,
        ))
        if not re.search(
            r"mServedView=.*com\.alipay\.mobile\.antui:id/search_input_box",
            state,
        ):
            return None
        if not re.search(
            r"mCurrent(?:EditorInfo|TextBoxAttribute):[\s\S]{0,800}?"
            r"packageName=com\.eg\.android\.AlipayGphone",
            state,
        ):
            return None
        cursors = re.findall(
            r"mCursorSelStart=(\d+)\s+mCursorSelEnd=(\d+)", state,
        )
        if not cursors:
            return None
        start, end = map(int, cursors[-1])
        return max(start, end)

    @staticmethod
    def descendant_texts(node):
        values = []
        for child in node.iter("node"):
            for key in ("text", "content-desc"):
                value = (child.get(key) or "").strip()
                if value and value not in values:
                    values.append(value)
        return values

    @staticmethod
    def not_real_named_display_matches(display, phone):
        compact = re.sub(r"\s+", "", str(display or ""))
        match = re.fullmatch(r"(\d{3})\*+(\d{2})[\(（]未实名[\)）]", compact)
        return bool(
            match
            and str(phone).startswith(match.group(1))
            and str(phone).endswith(match.group(2))
        )

    @staticmethod
    def not_real_named_result(display, phone, match_method):
        return {
            "alipayDisplayName": str(display or ""),
            "realNameTailCharacter": "",
            "matchedPhone": phone,
            "matchMethod": match_method,
            "notFound": True,
            "message": "account_not_real_named",
        }

    def emit_query_result(self, result, driver=""):
        detail = {"matchMethod": result.get("matchMethod", "")}
        if driver:
            detail["driver"] = driver
        if result.get("notFound"):
            self.emit(
                "lookup_no_name_result",
                reason=result.get("message", "no_name_result"),
                **detail,
            )
            return
        self.emit(
            "masked_real_name_tail_extracted",
            character=result["realNameTailCharacter"],
            **detail,
        )

    def parse_result(self, root, parent, phone):
        parent = parent or {child: node for node in root.iter() for child in node}
        patterns = [
            re.compile(r"[\(（]\*+([^\(\)（）\s])[\)）]\s*$"),
            re.compile(r"^\*+([\u4e00-\u9fff])$"),
            re.compile(r"^.{1,12}\*+([\u4e00-\u9fff])$"),
        ]
        candidates = []
        not_real_named_candidates = []
        for node in root.iter("node"):
            display = (node.get("text") or "").strip()
            if self.not_real_named_display_matches(display, phone):
                not_real_named_candidates.append((node, display))
            match = next((pattern.search(display) for pattern in patterns if pattern.search(display)), None)
            if match:
                candidates.append((node, display, next(group for group in match.groups() if group)))

        for node, display in not_real_named_candidates:
            current = node
            for _ in range(10):
                if current is None:
                    break
                values = self.descendant_texts(current)
                if phone in values and ("转账" in values or "加好友" in values):
                    return self.not_real_named_result(
                        display, phone, "same_accessibility_unverified_account_container",
                    )
                current = parent.get(current)

        for node, display, tail in candidates:
            current = node
            for _ in range(10):
                if current is None:
                    break
                values = self.descendant_texts(current)
                if phone in values and ("转账" in values or "加好友" in values):
                    return {
                        "alipayDisplayName": display, "realNameTailCharacter": tail,
                        "matchedPhone": phone, "matchMethod": "same_accessibility_result_container",
                    }
                current = parent.get(current)

        actions = {
            (node.get("text") or "").strip()
            for node in root.iter("node")
            if (node.get("text") or "").strip() in {"转账", "加好友"}
        }
        phone_nodes = [
            node for node in root.iter("node")
            if (node.get("text") or "").strip() == phone and node.get("bounds")
        ]
        if {"转账", "加好友"}.issubset(actions):
            for node, display in not_real_named_candidates:
                if not node.get("bounds"):
                    continue
                _, name_y = self.bounds_center(node.get("bounds"))
                for phone_node in phone_nodes:
                    _, phone_y = self.bounds_center(phone_node.get("bounds"))
                    if 0 < phone_y - name_y < 140:
                        return self.not_real_named_result(
                            display, phone, "element_geometry_unverified_account",
                        )
            for node, display, tail in candidates:
                if not node.get("bounds"):
                    continue
                _, name_y = self.bounds_center(node.get("bounds"))
                for phone_node in phone_nodes:
                    _, phone_y = self.bounds_center(phone_node.get("bounds"))
                    if 0 < phone_y - name_y < 140:
                        return {
                            "alipayDisplayName": display, "realNameTailCharacter": tail,
                            "matchedPhone": phone,
                            "matchMethod": "element_geometry_plus_exact_account_actions",
                        }
        return None

    @staticmethod
    def poco_text(node):
        for key in ("text", "desc"):
            try:
                value = (node.attr(key) or "").strip()
            except Exception:
                value = ""
            if value:
                return value
        return ""

    @staticmethod
    def poco_nodes(snapshot, **selector):
        try:
            proxy = snapshot(**selector)
            if isinstance(proxy, (list, tuple)):
                return list(proxy)
            if not proxy.exists():
                return []
            return list(proxy)
        except Exception as exc:
            # Poco may expose a normal absent optional node as an exception
            # while materializing the proxy (observed on vivo). Normalize only
            # this exact no-node semantic; transport and RPC errors still fail.
            if "Cannot find any visible node by query" in str(exc):
                return []
            raise

    def poco_snapshot_texts(self, snapshot, limit=120):
        values = []
        for node_type in ("android.widget.TextView", "android.view.View", "android.widget.Button"):
            for node in self.poco_nodes(snapshot, type=node_type):
                value = self.poco_text(node)
                if value and value not in values:
                    values.append(value)
                    if len(values) >= limit:
                        return values
        return values

    def poco_verification_evidence(self, snapshot):
        texts = set(self.poco_snapshot_texts(snapshot, 160))
        action = JIGSAW_VERIFICATION_ACTION if JIGSAW_VERIFICATION_ACTION in texts else VERIFICATION_ACTION
        feedback = next((value for value in texts if value.startswith(JIGSAW_FEEDBACK_PREFIX)), "")
        if VERIFICATION_TITLE in texts and (action in texts or feedback):
            return {
                "title": VERIFICATION_TITLE,
                "action": action if action in texts else "",
                "feedback": feedback,
                "manual": action == JIGSAW_VERIFICATION_ACTION or bool(feedback),
            }
        return None

    def poco_access_denied_evidence(self, snapshot):
        return self.access_denied_evidence_from_texts(self.poco_snapshot_texts(snapshot, 160))

    def poco_account_restriction_evidence(self, snapshot):
        return self.account_restriction_evidence_from_texts(self.poco_snapshot_texts(snapshot, 200))

    def poco_raise_if_account_restricted(self, snapshot, phase, phone_query_started=False):
        evidence = self.poco_account_restriction_evidence(snapshot)
        if evidence:
            self.raise_account_restriction(
                evidence, phase, "poco", phone_query_started=phone_query_started,
            )

    def poco_raise_if_login_required(self, snapshot, phase):
        texts = set(self.poco_snapshot_texts(snapshot, 120))
        sms_required = {"短信验证码登录", "其他验证方式"}
        sms_corroborating = {"换号", "注册账号", "遇到问题"}
        carrier_required = {"本机号码一键登录", "同意支付宝向运营商获取完整本机号码"}
        sms_login = sms_required.issubset(texts) and texts.intersection(sms_corroborating)
        carrier_login = carrier_required.issubset(texts) and "换号" in texts
        if sms_login or carrier_login:
            self.emit(
                "alipay_login_required_detected",
                phase=phase,
                driver="poco",
                phoneQueryStarted=False,
                loginSurface="sms_code" if sms_login else "carrier_one_tap",
            )
            raise RuntimeError("poco_alipay_login_required")

    def poco_raise_if_login_focus(self, focus, phase):
        """Fail closed on the exact Alipay login activity seen by WindowManager.

        `.AlipayLogin` is Alipay's normal launcher/home activity and must not be
        confused with the actual account-login activity below.
        """
        normalized = str(focus or "")
        if ALIPAY_LOGIN_ACTIVITY not in normalized:
            return
        self.emit(
            "alipay_login_required_detected",
            phase=phase,
            driver="poco_window_focus",
            phoneQueryStarted=False,
            loginSurface="login_activity",
            activity=ALIPAY_LOGIN_ACTIVITY,
        )
        raise RuntimeError("poco_alipay_login_required")

    def poco_raise_if_access_denied(self, snapshot, phase):
        # Backward-compatible alias for tests and older worker callers.
        self.poco_raise_if_account_restricted(snapshot, phase)

    def poco_wait_for_post_query_restriction(self, poco, phase, timeout=6.0):
        deadline = time.time() + timeout
        last_texts = []
        while time.time() < deadline:
            try:
                snapshot = poco.freeze()
                last_texts = self.poco_snapshot_texts(snapshot, 200)
                verification = self.poco_verification_evidence(snapshot)
                if verification and verification.get("manual"):
                    self.emit(
                        "human_verification_detected", evidence=verification,
                        token=phase, driver="poco",
                    )
                    raise RuntimeError(
                        "poco_alipay_human_verification_required:jigsaw_verification"
                    )
                evidence = self.account_restriction_evidence_from_texts(last_texts)
                if evidence:
                    self.raise_account_restriction(
                        evidence, phase, "poco", phone_query_started=True,
                    )
            except Exception as exc:
                if "human_verification_required" in str(exc):
                    raise
                if self.account_switch_reason_from_error(exc):
                    raise
                self.emit(
                    "post_query_restriction_probe_retry", phase=phase,
                    driver="poco", error=str(exc),
                )
            time.sleep(0.2)
        self.emit(
            "post_query_restriction_not_observed", phase=phase,
            driver="poco", texts=last_texts[:30],
        )

    def poco_slider_geometry(self, snapshot):
        entries = []
        node_types = (
            "android.widget.FrameLayout", "android.widget.LinearLayout",
            "android.widget.RelativeLayout", "android.widget.TextView", "android.view.View",
        )
        for node_type in node_types:
            for node in self.poco_nodes(snapshot, type=node_type):
                try:
                    x, y = node.get_position()
                    width, height = node.get_size()
                except Exception:
                    continue
                entries.append((node, self.poco_text(node), x, y, width, height, node_type))
        anchors = [entry for entry in entries if VERIFICATION_ACTION in entry[1]]
        if len(anchors) != 1:
            return None
        anchor_y = anchors[0][3]
        tracks = [
            entry for entry in entries
            if entry[4] >= 0.45 and 0.015 <= entry[5] <= 0.12 and abs(entry[3] - anchor_y) <= 0.055
        ]
        if not tracks:
            return None
        track = max(tracks, key=lambda entry: entry[4])
        _, _, center_x, center_y, width, height, node_type = track
        left, right = center_x - width / 2, center_x + width / 2
        return {
            "track": (left, center_y - height / 2, right, center_y + height / 2),
            "nodeType": node_type,
        }

    def poco_solve_human_verification(self, poco, token, max_attempts=3):
        snapshot = poco.freeze()
        evidence = self.poco_verification_evidence(snapshot)
        if not evidence:
            return False
        self.emit("human_verification_detected", evidence=evidence, token=token, driver="poco")
        if evidence.get("manual"):
            raise RuntimeError("poco_alipay_human_verification_required:jigsaw_verification")
        width, height = self.display_size()
        for attempt in range(1, max_attempts + 1):
            geometry = self.poco_slider_geometry(snapshot)
            if not geometry:
                self.emit("human_verification_geometry_missing", attempt=attempt, driver="poco")
                raise RuntimeError("poco_human_verification_geometry_missing")
            left, top, right, bottom = geometry["track"]
            knob_half = max(8, int(round((bottom - top) * height / 2)))
            start_x = max(1, min(width - 1, int(round(left * width)) + knob_half))
            start_y = max(1, min(height - 1, int(round(((top + bottom) / 2) * height))))
            end_x = max(1, width - 10)
            end_y = start_y
            duration_ms = 2200 + (attempt - 1) * 300
            self.adb([
                "shell", "input", "swipe", str(start_x), str(start_y),
                str(end_x), str(end_y), str(duration_ms),
            ], timeout=15)
            self.emit(
                "human_verification_slider_drag", attempt=attempt,
                start=[start_x, start_y], end=[end_x, end_y], durationMs=duration_ms,
                track=[round(value, 4) for value in geometry["track"]],
                trackNodeType=geometry["nodeType"], driver="poco",
            )
            time.sleep(1.5)
            snapshot = poco.freeze()
            if not self.poco_verification_evidence(snapshot):
                self.human_verification_passes += 1
                self.emit("human_verification_passed", attempt=attempt, token=token, driver="poco")
                return True
            self.emit("human_verification_retry", attempt=attempt, driver="poco")
        self.emit("human_verification_failed", token=token, attempts=max_attempts, driver="poco")
        raise RuntimeError("poco_alipay_basic_slider_verification_failed")

    def parse_poco_result(self, snapshot, phone):
        """Extract the same evidenced result from one frozen Poco snapshot."""
        patterns = [
            re.compile(r"[\(（]\*+([^\(\)（）\s])[\)）]\s*$"),
            re.compile(r"^\*+([\u4e00-\u9fff])$"),
            re.compile(r"^.{1,12}\*+([\u4e00-\u9fff])$"),
        ]
        nodes = []
        for node_type in ("android.widget.TextView", "android.view.View", "android.widget.Button"):
            nodes.extend(self.poco_nodes(snapshot, type=node_type))
        entries = []
        for node in nodes:
            text = self.poco_text(node)
            if not text:
                continue
            try:
                position = node.get_position()
            except Exception:
                position = None
            entries.append((node, text, position))

        actions = {text for _, text, _ in entries if text in {"转账", "加好友"}}
        if not {"转账", "加好友"}.issubset(actions):
            return None
        phones = [entry for entry in entries if entry[1] == phone and entry[2] is not None]
        not_real_named_candidates = [
            entry for entry in entries
            if entry[2] is not None and self.not_real_named_display_matches(entry[1], phone)
        ]
        for _, display, (_, name_y) in not_real_named_candidates:
            for _, _, (_, phone_y) in phones:
                if 0 < phone_y - name_y < 0.12:
                    return self.not_real_named_result(
                        display, phone, "poco_geometry_unverified_account",
                    )
        candidates = []
        for node, display, position in entries:
            match = next((pattern.search(display) for pattern in patterns if pattern.search(display)), None)
            if match and position is not None:
                candidates.append((node, display, next(group for group in match.groups() if group), position))
        for _, display, tail, (_, name_y) in candidates:
            for _, _, (_, phone_y) in phones:
                # Poco positions are normalized. The XML path accepts a name
                # up to 140 px above the exact phone row; 0.12 safely covers
                # that distance across the supported fleet resolutions.
                if 0 < phone_y - name_y < 0.12:
                    return {
                        "alipayDisplayName": display,
                        "realNameTailCharacter": tail,
                        "matchedPhone": phone,
                        "matchMethod": "poco_geometry_plus_exact_account_actions",
                    }
        return None

    def poco_unique(self, poco, timeout=3.0, live=True, **selector):
        deadline = time.time() + timeout
        last_count = 0
        while time.time() < deadline:
            try:
                # Materialize one hierarchy first and evaluate the selector on
                # that frozen snapshot.  Some vivo builds let a live proxy's
                # exists()/list() block for the Agent's full task timeout when
                # the element is absent, ignoring the intended 3-second loop.
                # A frozen Poco hierarchy keeps the UI source and selectors in
                # Poco while making the missing-element decision local.  The
                # snapshot node is read-only, so return a fresh live proxy only
                # after the frozen hierarchy has proved the selector unique.
                freeze = getattr(poco, "freeze", None)
                scope = freeze() if callable(freeze) else poco
                nodes = self.poco_nodes(scope, **selector)
            except Exception as exc:
                raise RuntimeError(f"poco_rpc_failed:{exc}") from exc
            last_count = len(nodes)
            if last_count == 1:
                # Taps need only stable coordinates and must use the frozen
                # node that proved uniqueness. Returning a second live proxy
                # can race an OEM overlay between the snapshot and
                # get_position(). Inputs still request a live node because
                # set_text is an RPC operation.
                return poco(**selector) if live else nodes[0]
            if last_count > 1:
                raise RuntimeError(f"poco_selector_not_unique:{selector!r}")
            time.sleep(0.15)
        raise RuntimeError(f"poco_selector_missing:{selector!r}; count={last_count}")

    def poco_search_ready(self, poco, live=True):
        focus = "\n".join(self.focus())
        self.poco_raise_if_login_focus(focus, "search-ready-focus")
        self.emit(
            "poco_search_ready_focus",
            searchForeground=("com.eg.android.AlipayGphone" in focus and "MainSearchActivity" in focus),
            driver="poco",
        )
        if COLOROS_SECUREPAY_PACKAGE in focus:
            if self.poco_dismiss_coloros_securepay_usb_dialog(poco):
                self.emit(
                    "retry_search_ready_after_coloros_securepay_warning",
                    selector={"name": SEARCH_INPUT_ID}, driver="poco",
                )
                focus = "\n".join(self.focus())
        if "com.eg.android.AlipayGphone" not in focus or "MainSearchActivity" not in focus:
            try:
                self.emit("poco_search_ready_restriction_probe_begin", driver="poco")
                snapshot = poco.freeze()
                self.emit("poco_search_ready_restriction_probe_done", driver="poco")
                self.poco_raise_if_login_required(snapshot, "search-ready-focus")
                self.poco_raise_if_account_restricted(snapshot, "search-ready-focus")
            except Exception as exc:
                if self.account_switch_reason_from_error(exc) or "poco_alipay_login_required" in str(exc):
                    raise
                self.emit("account_restriction_probe_unavailable", phase="search-ready-focus", driver="poco", error=str(exc))
            raise RuntimeError(f"poco_alipay_search_not_foreground:{focus}")
        try:
            self.emit("poco_search_input_probe_begin", driver="poco")
            return self.poco_unique(
                poco, timeout=2.0, live=live, name=SEARCH_INPUT_ID,
            )
        except Exception as exc:
            if (
                "poco_selector_missing:" in str(exc)
                and self.solve_verification_from_xml_if_present("poco-search-ready")
            ):
                return self.poco_unique(
                    poco, timeout=5.0, live=live, name=SEARCH_INPUT_ID,
                )
            try:
                snapshot = poco.freeze()
                self.poco_raise_if_account_restricted(snapshot, "search-ready-selector")
            except Exception as probe_exc:
                if self.account_switch_reason_from_error(probe_exc):
                    raise
            raise exc

    def poco_dismiss_known_overlay(self, poco):
        if "com.hihonor.hndockbar.DockTipDialogActivity" in "\n".join(self.focus()):
            self.adb(["shell", "input", "keyevent", "4"], timeout=5, check=False)
            self.emit("dismiss_honor_dock_tip")
            time.sleep(0.4)
            return True
        try:
            ads = self.poco_nodes(poco, desc="全屏广告")
            closes = self.poco_nodes(poco, desc="关闭")
        except Exception as exc:
            raise RuntimeError(f"poco_rpc_failed:{exc}") from exc
        if len(ads) == 1 and len(closes) == 1:
            self.poco_tap(closes[0])
            self.emit("dismiss_alipay_fullscreen_ad", driver="poco")
            time.sleep(0.4)
            return True
        return False

    def poco_dismiss_coloros_securepay_usb_dialog(self, poco):
        """Handle ColorOS SecurePay in the resident Poco session when visible."""
        focus = "\n".join(self.focus())
        if COLOROS_SECUREPAY_PACKAGE not in focus:
            return False
        try:
            snapshot = poco.freeze()
            titles = self.poco_nodes(
                snapshot,
                name="com.coloros.securepay:id/alertTitle",
                text=COLOROS_USB_TRANSFER_TITLE,
            )
            messages = self.poco_nodes(
                snapshot,
                name="com.coloros.securepay:id/tv_message",
                text=COLOROS_REMOTE_CONTROL_RISK,
            )
            ignores = self.poco_nodes(snapshot, name=COLOROS_IGNORE_BUTTON_ID, text="忽略")
            ignore_selector = {
                "package": COLOROS_SECUREPAY_PACKAGE,
                "resourceId": COLOROS_IGNORE_BUTTON_ID,
                "text": "忽略",
            }
            if len(ignores) != 1:
                # ColorOS 15 exposes the exact Ignore label but assigns a
                # vendor-specific button id. The exact foreground package,
                # title and risk message below make one unique Ignore label a
                # safe equivalent selector without involving XML.
                ignores = self.poco_nodes(snapshot, text="忽略")
                ignore_selector = {
                    "package": COLOROS_SECUREPAY_PACKAGE,
                    "text": "忽略",
                    "evidence": "exact_title_and_risk_message",
                }
        except Exception as exc:
            self.emit(
                "poco_coloros_securepay_probe_failed",
                errorType=type(exc).__name__,
                driver="poco",
            )
            # This exact ColorOS system dialog can block Alipay's Poco
            # hierarchy. Cancel it with Back after verifying its foreground
            # package, avoiding both a USB-mode change and UIAutomator/XML.
            self.adb(["shell", "input", "keyevent", "4"], timeout=5, check=False)
            self.emit(
                "dismiss_coloros_securepay_usb_warning",
                driver="poco_focus_adb_back",
                selector={"package": COLOROS_SECUREPAY_PACKAGE},
                method="back",
                usbModeChanged=False,
            )
            deadline = time.time() + 3.0
            while time.time() < deadline:
                if COLOROS_SECUREPAY_PACKAGE not in "\n".join(self.focus()):
                    time.sleep(0.2)
                    return True
                time.sleep(0.15)
            return False
        if len(titles) != 1 or len(messages) != 1 or len(ignores) != 1:
            self.emit(
                "poco_coloros_securepay_elements_missing",
                titleCount=len(titles),
                messageCount=len(messages),
                ignoreCount=len(ignores),
                texts=self.poco_snapshot_texts(snapshot, 20),
                driver="poco",
            )
            return False
        self.poco_tap(ignores[0])
        self.emit(
            "dismiss_coloros_securepay_usb_warning",
            driver="poco",
            selector=ignore_selector,
            usbModeChanged=False,
        )
        deadline = time.time() + 3.0
        while time.time() < deadline:
            if COLOROS_SECUREPAY_PACKAGE not in "\n".join(self.focus()):
                time.sleep(0.2)
                return True
            time.sleep(0.15)
        raise RuntimeError("poco_coloros_securepay_usb_warning_dismiss_timeout")

    def poco_open_search(self, poco, reason, verification_recoveries=0):
        self.poco_raise_if_login_focus("\n".join(self.focus()), f"open-search-{reason}")
        try:
            search = self.poco_unique(poco, timeout=3.0, live=False, desc="搜索框")
        except Exception as exc:
            if "poco_selector_missing" not in str(exc):
                raise
            dismissed = self.poco_dismiss_coloros_securepay_usb_dialog(poco)
            if not dismissed:
                dismissed = self.poco_dismiss_known_overlay(poco)
            if not dismissed:
                # This modal is Canvas-only on affected Alipay builds, so Poco
                # cannot expose its close control. Reuse the existing bounded
                # visual detector before any XML/UIAutomator probe.
                dismissed = self.dismiss_unverified_account_modal_visual()
            if not dismissed:
                dismissed = self.dismiss_coloros_securepay_usb_dialog(driver="poco_target_missing_xml_probe")
            if not dismissed:
                snapshot = poco.freeze()
                self.poco_raise_if_login_required(snapshot, f"open-search-{reason}")
                self.poco_raise_if_account_restricted(snapshot, f"open-search-{reason}")
                if self.poco_verification_evidence(snapshot):
                    if verification_recoveries >= 2:
                        raise RuntimeError("poco_alipay_human_verification_repeatedly_invalidated_start")
                    self.poco_solve_human_verification(poco, f"{reason}-launch")
                    return self.poco_prepare_full_path(poco, reason, verification_recoveries + 1)
            if dismissed:
                self.emit("retry_target_after_known_overlay", selector={"desc": "搜索框"}, driver="poco")
            # Preserve the original eight-second target budget for ordinary
            # slow launches while probing XML only for the evidenced vendor
            # foreground above.
            try:
                search = self.poco_unique(poco, timeout=5.0, live=False, desc="搜索框")
            except Exception as retry_exc:
                if "poco_selector_missing" not in str(retry_exc):
                    raise
                # Some restriction WebViews finish rendering only after the
                # initial three-second selector budget.  Re-inspect the live
                # Poco hierarchy at the end of the full eight-second budget
                # before the selector error can reach the XML fallback.
                self.emit(
                    "poco_open_search_final_restriction_probe_begin",
                    phase=f"open-search-{reason}", driver="poco",
                )
                snapshot = poco.freeze()
                self.emit(
                    "poco_open_search_final_restriction_probe_done",
                    phase=f"open-search-{reason}", driver="poco",
                )
                self.poco_raise_if_login_required(snapshot, f"open-search-{reason}")
                self.poco_raise_if_account_restricted(snapshot, f"open-search-{reason}")
                if self.poco_verification_evidence(snapshot):
                    if verification_recoveries >= 2:
                        raise RuntimeError("poco_alipay_human_verification_repeatedly_invalidated_start")
                    self.poco_solve_human_verification(poco, f"{reason}-launch")
                    return self.poco_prepare_full_path(poco, reason, verification_recoveries + 1)
                raise retry_exc
        self.poco_tap(search)
        self.emit("open_search", reason=reason, driver="poco")
        time.sleep(0.35)
        try:
            self.poco_unique(poco, timeout=5.0, name=SEARCH_INPUT_ID)
        except Exception as exc:
            if "poco_selector_missing" not in str(exc):
                raise
            if not self.poco_dismiss_coloros_securepay_usb_dialog(poco):
                raise
            self.emit(
                "retry_search_input_after_coloros_securepay_warning",
                selector={"name": SEARCH_INPUT_ID}, driver="poco",
            )
            self.poco_unique(poco, timeout=5.0, name=SEARCH_INPUT_ID)

    def poco_prepare_full_path(self, poco, reason, verification_recoveries=0):
        self.adb(["shell", "input", "keyevent", "224"], timeout=8, check=False)
        self.adb(["shell", "wm", "dismiss-keyguard"], timeout=8, check=False)
        self.adb(["shell", "am", "force-stop", ALIPAY_PACKAGE], timeout=8)
        output = self.adb([
            "shell", "am", "start", "-W", "-f", "0x10008000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", ALIPAY_HOME,
        ], timeout=25, check=False)
        self.emit("launch_alipay", reason=reason, detail=str(output)[-600:], driver="poco")
        time.sleep(1.0)
        if self.poco_dismiss_coloros_securepay_usb_dialog(poco):
            self.emit("retry_launch_after_coloros_securepay_warning", driver="poco")
        self.poco_open_search(poco, reason, verification_recoveries)

    def poco_try_reuse_search_page(self, poco):
        focus = "\n".join(self.focus())
        # ColorOS reports the underlying Alipay activity through mFocusedApp
        # while its SecurePay warning owns mCurrentFocus.  Handle that exact
        # system foreground before treating Alipay as reusable: the warning
        # blocks Alipay's Poco hierarchy, so probing the hierarchy first can
        # only end in a transport timeout.
        if COLOROS_SECUREPAY_PACKAGE in focus:
            if not self.poco_dismiss_coloros_securepay_usb_dialog(poco):
                raise RuntimeError("poco_coloros_securepay_usb_warning_not_dismissed")
            self.emit("retry_reuse_after_coloros_securepay_warning", driver="poco")
            focus = "\n".join(self.focus())
        self.poco_raise_if_login_focus(focus, "reuse-foreground")
        self.emit(
            "poco_reuse_focus_observed",
            searchForeground=("com.eg.android.AlipayGphone" in focus and "MainSearchActivity" in focus),
            alipayForeground=("com.eg.android.AlipayGphone" in focus),
            driver="poco",
        )
        if "com.eg.android.AlipayGphone" in focus and "MainSearchActivity" in focus:
            self.poco_search_ready(poco)
            self.emit("reuse_existing_search_page", method="poco_already_foreground")
            return True
        if "com.eg.android.AlipayGphone" in focus:
            # A restriction can replace the search activity entirely, so the
            # old task stack no longer contains MainSearchActivity.  Inspect
            # the current Poco hierarchy before deciding that a full Alipay
            # relaunch is necessary; relaunching an already evidenced
            # restriction page only breaks the live hierarchy channel.
            try:
                self.emit("poco_reuse_restriction_probe_begin", driver="poco")
                snapshot = poco.freeze()
                self.emit("poco_reuse_restriction_probe_done", driver="poco")
                self.poco_raise_if_login_required(snapshot, "reuse-foreground")
                self.poco_raise_if_account_restricted(snapshot, "reuse-foreground")
            except Exception as exc:
                if self.account_switch_reason_from_error(exc) or "poco_alipay_login_required" in str(exc):
                    raise
                self.emit(
                    "account_restriction_probe_unavailable",
                    phase="reuse-foreground", driver="poco", error=str(exc),
                )
            # Alipay is already foreground and the hierarchy is responsive.
            # Open Search directly from the current home surface instead of
            # force-stopping the app.  A cold relaunch invalidates Poco's
            # hierarchy transport on some devices for several seconds and is
            # unnecessary when the live home search element is available.
            self.poco_open_search(poco, "reuse-foreground")
            self.emit("reuse_existing_search_page", method="poco_open_from_foreground")
            return True
        activities = self.adb(["shell", "dumpsys", "activity", "activities"], timeout=12, check=False)
        if "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity" not in str(activities):
            return False
        self.adb([
            "shell", "am", "start", "-W", "-f", "0x10200000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", ALIPAY_HOME,
        ], timeout=20, check=False)
        time.sleep(0.35)
        self.poco_dismiss_known_overlay(poco)
        self.poco_search_ready(poco)
        self.emit("reuse_existing_search_page", method="poco_resume_existing_task")
        return True

    def query_once_poco(
        self, poco, phone, verification_recoveries=0, query_deadline=None,
        resume_after_input=False, allow_empty_reinput=True,
        observation_only_resume=False,
    ):
        if query_deadline is None:
            query_deadline = time.perf_counter() + 40.0
        no_name_deadline = time.time() + POCO_NO_NAME_RESULT_SECONDS
        if resume_after_input:
            # The previous worker already set the phone before its hierarchy
            # response channel stalled. Rebuild Poco only to inspect the page;
            # never submit the number a second time.
            self.emit("resume_query_without_reinput", driver="poco", resubmitsInput=False)
            try:
                resume_snapshot = poco.freeze()
            except Exception as exc:
                raise RuntimeError(
                    f"poco_query_resume_snapshot_failed:{type(exc).__name__}:{exc}"
                ) from exc
            self.poco_raise_if_account_restricted(
                resume_snapshot, "query-resume", phone_query_started=True,
            )
            if self.poco_verification_evidence(resume_snapshot):
                raise RuntimeError("poco_alipay_human_verification_required")
            resumed_result = self.parse_poco_result(resume_snapshot, phone)
            if resumed_result:
                self.emit_query_result(resumed_result, driver="poco")
                return resumed_result
            if observation_only_resume:
                # A preceding query_resume already focused and submitted the
                # original number before its Poco result channel timed out.
                # After rebuilding Poco, observe only the page that is already
                # rendered: never focus the field, inject text, or click search
                # again. This closes the false-failure window without creating
                # a duplicate lookup.
                self.emit(
                    "resume_result_observation_only",
                    driver="poco", resubmitsInput=False, resubmitsSearch=False,
                )
                observation_deadline = min(
                    time.time() + POCO_NO_NAME_RESULT_SECONDS,
                    time.time() + max(0.0, query_deadline - time.perf_counter()),
                )
                while time.time() < observation_deadline:
                    time.sleep(0.18)
                    try:
                        resume_snapshot = poco.freeze()
                    except Exception as exc:
                        raise RuntimeError(
                            "poco_query_result_channel_timeout_after_input:"
                            f"observation_only:{type(exc).__name__}:{exc}"
                        ) from exc
                    self.poco_raise_if_account_restricted(
                        resume_snapshot, "query-resume-observation",
                        phone_query_started=True,
                    )
                    if self.poco_verification_evidence(resume_snapshot):
                        raise RuntimeError("poco_alipay_human_verification_required")
                    resumed_result = self.parse_poco_result(resume_snapshot, phone)
                    if resumed_result:
                        self.emit_query_result(resumed_result, driver="poco")
                        return resumed_result
                raise RuntimeError("poco_query_resume_observation_no_result")
            resume_inputs = self.poco_nodes(resume_snapshot, name=SEARCH_INPUT_ID)
            resume_actual = self.poco_text(resume_inputs[0]) if len(resume_inputs) == 1 else ""
            resume_actual_digits = re.sub(r"\D", "", resume_actual)
            if resume_actual_digits != phone:
                # The Agent reaches query_resume only after terminating the
                # worker whose set_text RPC timed out.  If the rebuilt Poco
                # hierarchy proves that the one exact search input is still
                # empty, the original input did not land and cannot arrive
                # later.  Keep Poco as the element authority, focus that
                # frozen exact node, and use bounded ADB text injection once.
                # Any non-empty mismatch remains ambiguous and fails closed.
                if (
                    allow_empty_reinput
                    and len(resume_inputs) == 1
                    and not resume_actual_digits
                ):
                    self.emit(
                        "resume_empty_input_confirmed",
                        selector="exact_search_input",
                        resubmitsInput=True,
                        driver="poco",
                    )
                    self.wait_before_phone_input("poco_resume_empty_adb")
                    no_name_deadline = time.time() + POCO_NO_NAME_RESULT_SECONDS
                    self.poco_tap(resume_inputs[0])
                    self.input_phone_humanized(
                        phone, "adb_keyevents_after_poco_confirmed_empty", timeout=5,
                        driver="poco",
                    )
                    # The frozen node already proved the exact input and was
                    # used to focus it. Avoid an immediate redundant live
                    # selector RPC on devices whose set_text channel is the
                    # failure being recovered; the bounded readback below is
                    # the authoritative post-input verification.
                    input_node = resume_inputs[0]
                else:
                    raise RuntimeError(
                        "poco_query_resume_state_mismatch:"
                        f"length={len(resume_actual_digits)};"
                        f"emptyReinputAllowed={str(bool(allow_empty_reinput)).lower()}"
                    )
            else:
                input_node = self.poco_search_ready(poco)
                # Completing a jigsaw can return to MainSearchActivity with
                # the original phone still present but the input unfocused.
                # In that state Alipay hides search_confirm, so observation
                # alone eventually reports poco_search_submit_unavailable.
                # Focus the exact, already-matching input without changing its
                # value; this only reveals the normal submit control.
                self.poco_tap(input_node)
                self.emit(
                    "resume_existing_input_focused",
                    selector="exact_search_input",
                    resubmitsInput=False,
                    driver="poco",
                )
        else:
            # Poco's synchronous set_text RPC becomes unreliable during a
            # long sequence of searches on some vivo builds: the operation can
            # reach the phone but its HTTP response stalls, leaving the caller
            # unable to distinguish a completed, partial, or absent write.
            # Keep Poco as the sole element authority, but perform the bounded
            # clear/type actions through ADB after exact frozen-node focus.
            input_node = self.poco_search_ready(poco, live=False)
            try:
                self.poco_tap(input_node)
                # Move the cursor to the end so the active input connection
                # reports the real editable length. Unlike Poco/Accessibility
                # text, this excludes Alipay's rotating hint text.
                self.adb(["shell", "input", "keyevent", "123"], timeout=5)
                editable_length = self.focused_search_input_length()
                if editable_length is None:
                    raise RuntimeError("poco_exact_input_focus_not_confirmed")
                if editable_length:
                    self.clear_focused_search_input(
                        method="poco_exact_input_adb_keyevents",
                    )
                    editable_length = self.focused_search_input_length()
                if editable_length != 0:
                    raise RuntimeError(
                        "poco_query_input_state_invalid_before_input:"
                        f"editableLength={editable_length}"
                    )
                cleared_snapshot = poco.freeze()
                self.poco_raise_if_account_restricted(
                    cleared_snapshot, "input-clear", phone_query_started=False,
                )
                if self.poco_verification_evidence(cleared_snapshot):
                    raise RuntimeError("poco_alipay_human_verification_required")
                cleared_inputs = self.poco_nodes(
                    cleared_snapshot, name=SEARCH_INPUT_ID,
                )
                if len(cleared_inputs) != 1:
                    raise RuntimeError(
                        "poco_query_input_state_invalid_before_input:"
                        f"count={len(cleared_inputs)}"
                    )
                input_node = cleared_inputs[0]
                self.emit(
                    "poco_input_clear_confirmed",
                    selector="exact_search_input", editableLength=0,
                    driver="poco_input_connection",
                )
                self.wait_before_phone_input("poco")
                no_name_deadline = time.time() + POCO_NO_NAME_RESULT_SECONDS
                self.poco_tap(input_node)
                self.input_phone_humanized(
                    phone, "adb_keyevents_after_poco_exact_input", timeout=5,
                    driver="poco",
                )
            except Exception as exc:
                # Once the clear has started, a transport failure leaves the
                # exact input state unknown. Rebuild Poco and inspect it via
                # query_resume; an empty field permits one evidenced input,
                # the full target continues, and every other value fails
                # closed. This also covers a bounded ADB input failure without
                # ever blindly submitting the number twice.
                raise RuntimeError(
                    f"poco_query_result_channel_timeout_after_input:"
                    f"poco_bounded_input_failed:{type(exc).__name__}:{exc}"
                ) from exc

        readback_deadline = min(
            time.time() + 3.0,
            no_name_deadline,
            time.time() + max(0.0, query_deadline - time.perf_counter()),
        )
        actual_digits = ""
        while time.time() < readback_deadline:
            try:
                snapshot = poco.freeze()
            except Exception as exc:
                raise RuntimeError(
                    f"poco_query_result_channel_timeout_after_input:{type(exc).__name__}:{exc}"
                ) from exc
            self.poco_raise_if_account_restricted(
                snapshot, "input-readback", phone_query_started=True,
            )
            if self.poco_verification_evidence(snapshot):
                if verification_recoveries >= 2:
                    raise RuntimeError("poco_alipay_human_verification_repeatedly_invalidated_query")
                next_attempt = verification_recoveries + 1
                self.poco_solve_human_verification(poco, f"input-readback-{next_attempt}")
                self.emit(
                    "resume_query_after_human_verification", recoveryAttempt=next_attempt,
                    phase="input-readback", driver="poco", resubmitsInput=False,
                )
                return self.query_once_poco(
                    poco, phone, next_attempt, query_deadline,
                    resume_after_input=True,
                    allow_empty_reinput=allow_empty_reinput,
                )
            result = self.parse_poco_result(snapshot, phone)
            if result:
                self.emit_query_result(result, driver="poco")
                return result
            try:
                inputs = self.poco_nodes(snapshot, name=SEARCH_INPUT_ID)
                actual = self.poco_text(inputs[0]) if len(inputs) == 1 else ""
                actual_digits = re.sub(r"\D", "", actual)
            except Exception as exc:
                raise RuntimeError(
                    f"poco_query_result_channel_timeout_after_input:"
                    f"poco_input_readback_failed:{exc}"
                ) from exc
            if actual_digits == phone:
                break
            time.sleep(0.1)
        else:
            self.poco_wait_for_post_query_restriction(
                poco, "input-readback-transition",
            )
            raise RuntimeError(
                f"poco_query_result_channel_timeout_after_input:"
                f"search_input_readback_mismatch:length={len(actual_digits)}"
            )

        deadline = min(
            no_name_deadline,
            time.time() + max(0.0, query_deadline - time.perf_counter()),
        )
        submit_after = min(deadline, time.time() + POCO_SEARCH_SUBMIT_DELAY_SECONDS)
        submit_count = 0
        last_snapshot = None
        while time.time() < deadline:
            try:
                snapshot = poco.freeze()
                last_snapshot = snapshot
            except Exception as exc:
                raise RuntimeError(
                    f"poco_query_result_channel_timeout_after_input:{type(exc).__name__}:{exc}"
                ) from exc
            self.poco_raise_if_account_restricted(
                snapshot, "result", phone_query_started=True,
            )
            if self.poco_verification_evidence(snapshot):
                if verification_recoveries >= 2:
                    raise RuntimeError("poco_alipay_human_verification_repeatedly_invalidated_query")
                next_attempt = verification_recoveries + 1
                self.poco_solve_human_verification(poco, f"result-{next_attempt}")
                self.emit(
                    "resume_query_after_human_verification", recoveryAttempt=next_attempt,
                    phase="result", driver="poco", resubmitsInput=False,
                )
                return self.query_once_poco(
                    poco, phone, next_attempt, query_deadline,
                    resume_after_input=True,
                    allow_empty_reinput=allow_empty_reinput,
                )
            result = self.parse_poco_result(snapshot, phone)
            if result:
                self.emit_query_result(result, driver="poco")
                return result
            should_submit = submit_count == 0 and time.time() >= submit_after
            if should_submit:
                confirms = self.poco_nodes(snapshot, name="com.alipay.mobile.antui:id/search_confirm")
                if len(confirms) == 1:
                    self.poco_tap(confirms[0])
                    submit_count += 1
                    self.emit(
                        "submit_search",
                        selector="exact_search_confirm", attempt=submit_count, driver="poco",
                    )
            time.sleep(0.18)
        if submit_count < 1 or last_snapshot is None:
            self.poco_wait_for_post_query_restriction(
                poco, "search-submit-unavailable",
            )
            raise RuntimeError(
                "poco_query_result_channel_timeout_after_input:"
                "poco_search_submit_unavailable"
            )
        try:
            inputs = self.poco_nodes(last_snapshot, name=SEARCH_INPUT_ID)
            actual = self.poco_text(inputs[0]) if len(inputs) == 1 else ""
            actual_digits = re.sub(r"\D", "", actual)
        except Exception as exc:
            raise RuntimeError(
                f"poco_query_result_channel_timeout_after_input:"
                f"poco_result_state_readback_failed:{exc}"
            ) from exc
        if actual_digits != phone:
            # A submitted search can transition through an input-less WebView
            # before an account restriction finishes rendering (observed on
            # vivo V2442A). Keep probing that existing page through Poco. If no
            # restriction becomes visible, force Agent's query_resume path;
            # both outcomes are post-input and must never enter XML or submit
            # the number again.
            self.poco_wait_for_post_query_restriction(
                poco, "result-page-state-changed",
            )
            raise RuntimeError(
                f"poco_query_result_channel_timeout_after_input:"
                f"poco_result_page_state_changed:length={len(actual_digits)}"
            )
        self.emit(
            "lookup_no_name_result", reason="stable_search_page_without_name_result",
            submitAttempts=submit_count, driver="poco",
        )
        return {
            "alipayDisplayName": "",
            "realNameTailCharacter": "",
            "matchedPhone": phone,
            "matchMethod": "poco_stable_no_name_result",
            "notFound": True,
            "message": "no_name_result",
        }

    def run_poco(self, poco):
        operation = str(self.payload.get("operation") or "")
        self.emit("poco_request_received", operation=operation, workflow="alipay_name")
        if self.adb(["get-state"], timeout=8).strip() != "device":
            raise RuntimeError("device_not_online")
        if not self.adb(["shell", "pm", "path", ALIPAY_PACKAGE], timeout=10).strip():
            raise RuntimeError("alipay_not_installed")
        self.emit("poco_reused", workflow="alipay_name")
        if operation == "start":
            self.keep_awake_usb_best_effort()
            self.wake_and_unlock_for_lookup_start()
            reuse_selector_retry = 0
            while True:
                try:
                    reused = self.poco_try_reuse_search_page(poco)
                    break
                except Exception as exc:
                    raw_error = str(exc)
                    if "poco_alipay_login_required" in raw_error:
                        raise
                    if "human_verification_required:jigsaw_verification" in raw_error:
                        self.emit(
                            "lookup_session_ready_on_human_verification_page",
                            restrictionReason="jigsaw_verification",
                            phoneQueryStarted=False,
                            driver="poco",
                        )
                        return {
                            "ok": True,
                            "message": "search_session_human_verification_required",
                            "restrictionReason": "jigsaw_verification",
                            "requiresHumanAction": True,
                            "currentAccount": "",
                            "log": self.log,
                        }
                    restriction_reason = self.account_switch_reason_from_error(exc)
                    if (
                        "alipay_account_restriction_before_search:" in raw_error
                        and restriction_reason
                    ):
                        # The restriction page is already a stable, evidenced
                        # Alipay state.  Keep it in place and let the session open
                        # without relaunching Alipay, which would only invalidate
                        # Poco's hierarchy channel and can never make the search
                        # input available while this page remains foreground.
                        self.emit(
                            "lookup_session_ready_on_restriction_page",
                            restrictionReason=restriction_reason,
                            phoneQueryStarted=False,
                            driver="poco",
                        )
                        return {
                            "ok": True,
                            "message": "search_session_restricted",
                            "restrictionReason": restriction_reason,
                            "currentAccount": "",
                            "log": self.log,
                        }
                    if "poco_rpc_failed:" in raw_error:
                        # A broken hierarchy transport cannot be healed by
                        # force-stopping and relaunching Alipay.  Return control
                        # to the Agent immediately so it can rebuild only the
                        # Poco worker and attach to the already-foreground app.
                        self.emit(
                            "reuse_search_transport_failed",
                            error=str(exc),
                            errorType=type(exc).__name__,
                            driver="poco",
                        )
                        raise
                    if (
                        reuse_selector_retry == 0
                        and "poco_selector_missing:" in raw_error
                        and "com.eg.android.AlipayGphone" in "\n".join(self.focus())
                    ):
                        # Some newly attached PocoService instances observe the
                        # Search tap before their hierarchy publishes the input.
                        # Retry once against the same foreground task and worker;
                        # force-stopping Alipay here invalidates that healthy
                        # transport and can consume another full worker bootstrap.
                        reuse_selector_retry += 1
                        self.emit(
                            "reuse_search_selector_missing_retry",
                            retryAttempt=reuse_selector_retry,
                            maxRetries=1,
                            relaunchesAlipay=False,
                            driver="poco",
                        )
                        time.sleep(0.15)
                        continue
                    self.emit("reuse_search_page_failed", error=str(exc), driver="poco")
                    reused = False
                    break
            if not reused:
                self.poco_prepare_full_path(poco, "session-start")
            return {"ok": True, "message": "search_session_ready", "currentAccount": "", "log": self.log}
        if operation == "stop":
            # A query restriction is already an evidenced terminal page.  A
            # stop request only needs to release the platform session; it must
            # not rebuild the search page with XML just to clear an input that
            # is no longer visible.  Keep the exact restriction page in place
            # for diagnosis/account switching and finish entirely in Poco.
            try:
                self.poco_dismiss_coloros_securepay_usb_dialog(poco)
                stop_snapshot = poco.freeze()
                stop_restriction = self.poco_account_restriction_evidence(stop_snapshot)
            except Exception as exc:
                self.emit(
                    "stop_restriction_probe_unavailable",
                    driver="poco", errorType=type(exc).__name__,
                )
                stop_restriction = None
            if stop_restriction:
                self.emit(
                    "lookup_session_stopped",
                    searchPageKeptWarm=False,
                    restrictionPageKeptForDiagnosis=True,
                    restrictionReason=stop_restriction.get("reason", ""),
                    driver="poco",
                )
                return {"ok": True, "message": "session_stopped", "log": self.log}
            input_node = self.poco_search_ready(poco, live=False)
            self.poco_tap(input_node)
            self.clear_focused_search_input(
                method="poco_exact_input_adb_keyevents",
            )
            self.emit("lookup_session_stopped", searchPageKeptWarm=True, driver="poco")
            return {"ok": True, "message": "session_stopped", "log": self.log}
        if operation not in ("query", "query_resume"):
            raise RuntimeError("unsupported_operation")
        phone = re.sub(r"\D", "", str(self.payload.get("phoneNumber") or ""))
        if not re.fullmatch(r"1\d{10}", phone):
            raise RuntimeError("invalid_phone_number")
        result = self.query_once_poco(
            poco, phone,
            resume_after_input=(operation == "query_resume"),
            allow_empty_reinput=bool(
                self.payload.get("allowEmptyInputRecovery", True)
            ),
            observation_only_resume=bool(
                self.payload.get("observationOnlyResume", False)
            ),
        )
        return {
            "ok": True, **result, "currentAccount": "", "accountSwitched": False,
            "recoveryAttempts": 0,
            "elapsedMs": int((time.perf_counter() - self.started) * 1000), "log": self.log,
        }

    def current_account(self):
        # The picker is not opened during the fast path. Return an empty value
        # unless a switch just produced exact account evidence.
        return ""

    def clear_focused_search_input(self, method="focused_input_resource"):
        # Android's input command accepts multiple key codes.  Keep the same
        # bounded clear behavior without paying one ADB round trip per delete.
        key_delay_ms = random.randint(55, 95)
        self.adb(
            ["shell", "input", "keyevent", "--delay", str(key_delay_ms), "123", *(["67"] * 24)],
            timeout=8,
        )
        self.emit(
            "clear_previous_query", selector="exact_search_input",
            method=method, keyCount=25, keyDelayMs=key_delay_ms,
        )

    def input_phone_humanized(self, phone, method, timeout=8, driver="xml_uiautomator"):
        key_delay_ms = random.randint(85, 145)
        keycodes = [str(7 + int(digit)) for digit in phone]
        self.adb(
            ["shell", "input", "keyevent", "--delay", str(key_delay_ms), *keycodes],
            timeout=timeout,
        )
        self.emit(
            "input_phone", method=method, keyCount=len(keycodes),
            keyDelayMs=key_delay_ms, driver=driver,
        )

    def clear_search_input(self, root, parent, input_node):
        target = self.tappable(input_node, parent)
        x, y = self.bounds_center(target.get("bounds"))
        self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
        self.clear_focused_search_input(method="element_tap_batched_keyevents")

    def tap_visual_settings_gear(self, root):
        """Tap the Canvas-only settings gear after exact My-tab evidence.

        Alipay 10.8 may expose the selected bottom tab to UIAutomator while the
        entire profile body, including Settings, is rendered on Canvas.  The
        visual fallback is allowed only on the uniquely selected My tab and
        chooses the rightmost sizeable dark component in the top action row.
        """
        my_tabs = self.find(root, text="我的", resource_id=TAB_DESCRIPTION_ID)
        if len(my_tabs) != 1 or my_tabs[0].get("selected") != "true":
            raise RuntimeError("visual_settings_requires_selected_my_tab")
        try:
            import cv2
            import numpy as np
            raw = self.adb(["exec-out", "screencap", "-p"], timeout=15, binary=True)
            image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                raise RuntimeError("settings_screenshot_decode_failed")
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            height, width = gray.shape[:2]
            mask = (gray < 130).astype(np.uint8)
            mask[:int(height * .045), :] = 0
            mask[int(height * .15):, :] = 0
            mask[:, :int(width * .72)] = 0
            count, _, stats, centers = cv2.connectedComponentsWithStats(mask)
            candidates = []
            minimum_area = max(80, int(width * height * .00025))
            for index in range(1, count):
                x, y, component_width, component_height, area = stats[index]
                center_x, center_y = centers[index]
                if area < minimum_area:
                    continue
                if component_width < width * .035 or component_height < height * .018:
                    continue
                if not (height * .05 <= center_y <= height * .11):
                    continue
                candidates.append((float(center_x), float(center_y), int(area)))
            if not candidates:
                raise RuntimeError("settings_gear_component_missing")
            center_x, center_y, area = max(candidates, key=lambda item: item[0])
            tap_x, tap_y = int(round(center_x)), int(round(center_y))
            self.adb(["shell", "input", "tap", str(tap_x), str(tap_y)], timeout=8)
            self.emit(
                "open_settings", method="selected_my_tab_visual_gear",
                tap={"x": tap_x, "y": tap_y}, componentArea=area,
            )
            return True
        except Exception as exc:
            raise RuntimeError(f"alipay_visual_settings_open_failed:{exc}") from exc

    def enter_my_settings(self, token, max_attempts=3):
        """Enter My > Settings, tolerating only evidenced late startup ads.

        Alipay may expose the underlying home accessibility tree before its
        startup advertisement appears.  A blind tap on the visible-in-XML
        "My" tab is then consumed by the advertisement.  Treat navigation as
        successful only after the exact Settings element is present.
        """
        for attempt in range(1, max_attempts + 1):
            deadline = time.time() + 12
            root = parent = None
            while time.time() < deadline:
                root, parent = self.dump(f"{token}-home-ready-{attempt}")
                restriction = self.account_restriction_evidence(root)
                if restriction:
                    root, parent = self.return_to_home_for_account_switch(restriction, token)
                if self.dismiss_known_overlay(root, parent):
                    self.emit("account_navigation_overlay_dismissed", attempt=attempt, phase="home")
                    time.sleep(0.5)
                    continue
                matches = self.find(root, text="我的", resource_id=TAB_DESCRIPTION_ID)
                if len(matches) == 1:
                    self.tap_unique(
                        root, parent, "open_my_tab", text="我的", resource_id=TAB_DESCRIPTION_ID,
                    )
                    break
                if len(matches) > 1:
                    raise RuntimeError("alipay_my_tab_not_unique")
                time.sleep(0.35)
            else:
                raise RuntimeError(
                    f"alipay_my_tab_missing:texts={self.texts(root, 50)!r}; focus={self.focus()!r}"
                )

            navigation_deadline = time.time() + 6
            while time.time() < navigation_deadline:
                root, parent = self.dump(f"{token}-settings-ready-{attempt}")
                if self.dismiss_known_overlay(root, parent):
                    self.emit("account_navigation_overlay_dismissed", attempt=attempt, phase="after_my_tap")
                    time.sleep(0.5)
                    break
                settings = self.find(root, desc="设置", resource_id=SETTINGS_ENTRY_ID)
                if len(settings) == 1:
                    self.tap_unique(
                        root, parent, "open_settings", desc="设置", resource_id=SETTINGS_ENTRY_ID,
                    )
                    return
                if len(settings) > 1:
                    raise RuntimeError("alipay_settings_entry_not_unique")
                time.sleep(0.35)
            try:
                self.tap_visual_settings_gear(root)
                self.wait_unique(f"{token}-visual-settings-ready-{attempt}", timeout=5, text="设置")
                return
            except Exception as exc:
                self.emit(
                    "visual_settings_fallback_failed", attempt=attempt, error=str(exc),
                )
            self.emit("account_navigation_retry", attempt=attempt, reason="settings_not_visible")
        raise RuntimeError("alipay_account_settings_navigation_failed")

    def open_account_picker(self, token):
        self.enter_my_settings(token)
        time.sleep(1.0)
        # Alipay 10.6 draws the "login other account" settings card on Canvas.
        # Instead of a fixed coordinate, derive the upper of the two bottom
        # white cards from the current screenshot.
        try:
            import cv2
            import numpy as np
            raw = self.adb(["exec-out", "screencap", "-p"], timeout=15, binary=True)
            image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            height, width = gray.shape[:2]
            ratio = (gray[:, int(width * .025):int(width * .975)] >= 252).mean(axis=1)
            mask = ratio >= .76
            mask[:int(height * .5)] = False
            runs, start = [], None
            for y, value in enumerate(mask):
                if value and start is None:
                    start = y
                if start is not None and (not value or y == height - 1):
                    end = y if not value else y + 1
                    if end - start >= int(height * .035):
                        runs.append((start, end))
                    start = None
            if len(runs) < 2:
                raise RuntimeError(f"account_cards_not_detected:{runs!r}")
            upper = runs[-2]
            self.adb(["shell", "input", "tap", str(width // 2), str((upper[0] + upper[1]) // 2)], timeout=8)
            self.emit("open_saved_account_picker", method="responsive_card_segmentation")
        except Exception as exc:
            raise RuntimeError(f"alipay_account_picker_open_failed:{exc}") from exc
        time.sleep(0.8)
        deadline = time.time() + 12
        root = parent = None
        while time.time() < deadline:
            root, parent = self.dump(f"account-picker-{token}")
            titles = self.find(root, text="切换账号")
            if len(titles) == 1:
                break
            if len(titles) > 1:
                raise RuntimeError("alipay_account_picker_title_not_unique")
            login_other = self.find(root, text="登录其他账号")
            logout = self.find(root, text="退出登录")
            cancel = self.find(root, text="取消")
            if len(login_other) == len(logout) == len(cancel) == 1:
                self.tap_unique(root, parent, "open_login_other_account_sheet", text="登录其他账号")
                self.emit(
                    "account_picker_intermediate_sheet_handled",
                    evidence=["登录其他账号", "退出登录", "取消"],
                )
                time.sleep(0.6)
                continue
            time.sleep(0.35)
        else:
            raise RuntimeError(
                f"alipay_account_picker_missing:texts={self.texts(root, 50)!r}; focus={self.focus()!r}"
            )
        return self.account_picker_rows(root, parent)

    def account_picker_rows(self, root, parent):
        rows = []
        for node in self.find(root, resource_id=ACCOUNT_ID):
            account = (node.get("text") or "").strip()
            container = parent.get(node)
            current = container is not None and any(
                (child.get("resource-id") or "") == ACCOUNT_CURRENT_ID and (child.get("text") or "").strip() == "当前"
                for child in container.iter("node")
            )
            rows.append((account, current, node))
        return rows

    def reuse_open_account_picker(self, token, timeout=4.0):
        """Read the picker left open by list_accounts without navigating again."""
        deadline = time.time() + timeout
        root = parent = None
        while time.time() < deadline:
            root, parent = self.dump(f"account-picker-reuse-{token}")
            titles = self.find(root, text="切换账号")
            if len(titles) > 1:
                raise RuntimeError("alipay_account_picker_title_not_unique")
            if len(titles) == 1:
                rows = self.account_picker_rows(root, parent)
                if rows:
                    self.emit(
                        "reuse_open_account_picker",
                        savedAccountCount=len(rows),
                    )
                    return rows
            time.sleep(0.2)
        raise RuntimeError(
            f"alipay_open_account_picker_not_reusable:texts={self.texts(root, 40)!r}"
        )

    @staticmethod
    def rotation_account_rows(rows, excluded_accounts=None):
        current_indexes = [index for index, row in enumerate(rows) if row[1]]
        if len(rows) < 2 or len(current_indexes) != 1:
            raise RuntimeError("alipay_saved_account_candidate_missing")
        current_index = current_indexes[0]
        # Alipay moves the current account to the first row. Choosing the first
        # non-current row therefore bounces between the two most recently used
        # accounts. Select the preceding row with wraparound; when current is
        # first this is the last saved row and rotates through the whole list.
        excluded = set(excluded_accounts or ())
        current = rows[current_index]
        for offset in range(1, len(rows)):
            candidate = rows[(current_index - offset) % len(rows)]
            if candidate[0] not in excluded:
                return current, candidate
        raise RuntimeError("alipay_all_saved_accounts_exhausted")

    @staticmethod
    def saved_account_choices(rows):
        current_rows = [row for row in rows if row[1]]
        accounts = [str(row[0] or "").strip() for row in rows]
        if len(rows) < 2 or len(current_rows) != 1 or any(not account for account in accounts):
            raise RuntimeError("alipay_saved_account_candidate_missing")
        if len(set(accounts)) != len(accounts):
            raise RuntimeError("alipay_saved_account_labels_not_unique")
        return [
            {"account": account, "current": bool(row[1])}
            for account, row in zip(accounts, rows)
        ]

    def switch_account(
        self, reason="", excluded_accounts=None, target_account="",
        reuse_open_picker=False, verify_current_marker=True,
    ):
        rows = None
        if reuse_open_picker:
            try:
                rows = self.reuse_open_account_picker("before")
            except Exception as exc:
                self.emit("reuse_open_account_picker_failed", error=str(exc))
        if rows is None:
            self.launch("account-switch")
            rows = self.open_account_picker("before")
        self.saved_account_count = max(self.saved_account_count, len(rows))
        current_rows = [row for row in rows if row[1]]
        if len(current_rows) != 1:
            raise RuntimeError("alipay_saved_account_candidate_missing")
        current = current_rows[0]
        requested = str(target_account or "").strip()
        if requested:
            targets = [row for row in rows if row[0] == requested]
            if len(targets) != 1:
                raise RuntimeError(
                    f"alipay_target_account_not_unique_or_missing:target={requested}"
                )
            target = targets[0]
            if target[1]:
                raise RuntimeError(
                    f"alipay_target_account_already_current:target={requested}"
                )
        else:
            current, target = self.rotation_account_rows(rows, excluded_accounts)
        if reason in ACCOUNT_SWITCH_REASONS:
            self.restricted_accounts.add(current[0])
        x, y = self.bounds_center(target[2].get("bounds"))
        self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
        # The selected account can immediately open another restriction page.
        # Record the actual selection before verifying it so a caller never
        # retries the switch and ping-pongs between two saved accounts.
        self.account_switched = True
        self.current_account_after_switch = target[0]
        self.emit("account_selected", fromAccount=current[0], toAccount=target[0], selector="exact_account_resource")
        self.account_switch_history.append({
            "fromAccount": current[0], "toAccount": target[0], "reason": reason,
        })
        self.wait_unique("account-switch-returned-home", timeout=20, text="我的")
        self.emit("account_selection_returned_home")
        if verify_current_marker:
            verified_rows = self.open_account_picker("verify")
            verified = next((row for row in verified_rows if row[1]), None)
            if verified is None or verified[0] != target[0]:
                actual = verified[0] if verified else ""
                raise RuntimeError(f"alipay_account_switch_verification_failed:expected={target[0]};actual={actual}")
            current_account = verified[0]
            verification = "exact_current_marker"
            self.launch("account-switch-complete")
        else:
            # The user selected an exact row from the picker that list_accounts
            # intentionally left open. Returning to the unique Alipay home is
            # sufficient confirmation for this manual flow; reopening the
            # picker would only replay the same navigation a third time.
            current_account = target[0]
            verification = "exact_target_click_and_home_return"
        self.emit(
            "account_switch_verified", fromAccount=current[0],
            currentAccount=current_account, verification=verification,
        )
        self.open_search("account-switch-complete")
        return current_account

    def switch_account_for_reason(self, reason):
        self.emit(
            "account_switch_triggered", reason=reason, retryCurrentPhone=True,
            restrictedAccounts=sorted(self.restricted_accounts),
        )
        self.account_switch_reason = reason
        current_account = self.switch_account(
            reason=reason,
            excluded_accounts=self.restricted_accounts if reason in ACCOUNT_SWITCH_REASONS else None,
            verify_current_marker=False,
        )
        self.account_switched = True
        self.current_account_after_switch = current_account
        return current_account

    def wait_for_post_query_restriction_xml(self, phase, timeout=7.0):
        deadline = time.time() + timeout
        root = None
        while time.time() < deadline:
            try:
                root, _ = self.dump(phase)
                verification = self.verification_evidence(root)
                if verification and verification.get("manual"):
                    self.emit(
                        "human_verification_detected", evidence=verification,
                        token=phase, driver="xml_uiautomator",
                    )
                    raise RuntimeError(
                        "alipay_human_verification_required:jigsaw_verification"
                    )
                evidence = self.account_restriction_evidence(root)
                if evidence:
                    self.raise_account_restriction(
                        evidence, phase, "xml_uiautomator", phone_query_started=True,
                    )
            except Exception as exc:
                if "human_verification_required" in str(exc):
                    raise
                if self.account_switch_reason_from_error(exc):
                    raise
                self.emit(
                    "post_query_restriction_probe_retry", phase=phase,
                    driver="xml_uiautomator", error=str(exc),
                )
            time.sleep(0.3)
        self.emit(
            "post_query_restriction_not_observed", phase=phase,
            driver="xml_uiautomator", texts=self.texts(root, 30) if root is not None else [],
        )

    def query_once(self, phone, verification_recoveries=0, query_deadline=None):
        if query_deadline is None:
            query_deadline = time.perf_counter() + 55.0
        if self.focused_search_input_ready():
            self.clear_focused_search_input()
        else:
            root, parent, input_node = self.search_ready()
            self.clear_search_input(root, parent, input_node)
        self.wait_before_phone_input("xml_uiautomator")
        self.input_phone_humanized(phone, "reuse_search_EditText", timeout=8)
        input_deadline = time.time() + 4
        actual_digits = ""
        while time.time() < input_deadline:
            root, parent = self.dump("input-readback")
            restriction = self.account_restriction_evidence(root)
            if restriction:
                self.raise_account_restriction(
                    restriction, "input-readback", "xml_uiautomator", phone_query_started=True,
                )
            verification = self.verification_evidence(root)
            if verification:
                root, parent = self.solve_human_verification(root, parent, "input-readback")
                if verification_recoveries >= 2:
                    raise RuntimeError("alipay_human_verification_repeatedly_invalidated_query")
                next_attempt = verification_recoveries + 1
                self.emit(
                    "replay_query_after_human_verification",
                    recoveryAttempt=next_attempt, phase="input-readback",
                )
                self.prepare_full_path(f"verification-recovery-{next_attempt}")
                return self.query_once(phone, next_attempt, query_deadline)
            inputs = self.find(root, resource_id=SEARCH_INPUT_ID)
            actual = (inputs[0].get("text") or "").strip() if len(inputs) == 1 else ""
            actual_digits = re.sub(r"\D", "", actual)
            if actual_digits == phone:
                # The first post-input hierarchy often already contains the
                # final result.  Parse it here instead of forcing another
                # 2–3 second UIAutomator dump before returning.
                result = self.parse_result(root, parent, phone)
                if result:
                    self.emit_query_result(result)
                    return result
                break
            time.sleep(0.3)
        else:
            self.wait_for_post_query_restriction_xml("input-readback-transition")
            raise RuntimeError(f"search_input_readback_mismatch:length={len(actual_digits)}")
        remaining_budget = max(0.0, query_deadline - time.perf_counter())
        deadline = time.time() + min(10.0, remaining_budget)
        submit_after = time.time() + 1.5
        submitted = False
        while time.time() < deadline:
            root, parent = self.dump("result")
            restriction = self.account_restriction_evidence(root)
            if restriction:
                self.raise_account_restriction(
                    restriction, "result", "xml_uiautomator", phone_query_started=True,
                )
            verification = self.verification_evidence(root)
            if verification:
                root, parent = self.solve_human_verification(root, parent, "result")
                result = self.parse_result(root, parent, phone)
                if result:
                    self.emit_query_result(result)
                    return result
                if verification_recoveries >= 2:
                    raise RuntimeError("alipay_human_verification_repeatedly_invalidated_query")
                next_attempt = verification_recoveries + 1
                self.emit(
                    "replay_query_after_human_verification",
                    recoveryAttempt=next_attempt, phase="result",
                )
                self.prepare_full_path(f"verification-recovery-{next_attempt}")
                return self.query_once(phone, next_attempt, query_deadline)
            result = self.parse_result(root, parent, phone)
            if result:
                self.emit_query_result(result)
                return result
            inputs = self.find(root, resource_id=SEARCH_INPUT_ID)
            actual = (inputs[0].get("text") or "").strip() if len(inputs) == 1 else ""
            result_input_digits = re.sub(r"\D", "", actual)
            if result_input_digits != phone:
                raise RuntimeError(f"search_input_readback_mismatch:length={len(result_input_digits)}")
            if not submitted and time.time() >= submit_after:
                confirms = self.find(root, resource_id="com.alipay.mobile.antui:id/search_confirm")
                if len(confirms) == 1:
                    node = self.tappable(confirms[0], parent)
                    cx, cy = self.bounds_center(node.get("bounds"))
                    self.adb(["shell", "input", "tap", str(cx), str(cy)], timeout=8)
                    self.emit("submit_search", selector="exact_search_confirm")
                    submitted = True
            time.sleep(0.45)
        raise RuntimeError(f"alipay_person_result_not_found:texts={self.texts(root, 60)!r}")

    def raise_after_account_switch(self, restriction_reason, error):
        event = (
            "alipay_access_denied_after_account_switch"
            if restriction_reason == "access_denied"
            else "alipay_account_restricted_after_account_switch"
        )
        self.emit(
            event,
            triggerReason=self.account_switch_reason,
            restrictionReason=restriction_reason,
            currentAccount=self.current_account_after_switch,
        )
        code = (
            "alipay_access_denied_after_account_switch"
            if restriction_reason == "access_denied"
            else f"alipay_account_restricted_after_account_switch:{restriction_reason}"
        )
        raise RuntimeError(code) from error

    def raise_all_accounts_restricted(self, restriction_reason, error):
        if self.current_account_after_switch:
            self.restricted_accounts.add(self.current_account_after_switch)
        self.account_switch_reason = restriction_reason
        self.emit(
            "alipay_all_saved_accounts_restricted",
            restrictionReason=restriction_reason,
            restrictedAccounts=sorted(self.restricted_accounts),
            savedAccountCount=self.saved_account_count,
            accountSwitchHistory=self.account_switch_history,
        )
        raise RuntimeError(
            f"alipay_all_saved_accounts_restricted:{restriction_reason}"
        ) from error

    def switch_once_for_reason(self, reason):
        try:
            return self.switch_account_for_reason(reason)
        except Exception as exc:
            restriction_reason = self.account_switch_reason_from_error(exc)
            if restriction_reason and self.account_switched:
                self.raise_after_account_switch(restriction_reason, exc)
            raise

    def run(self):
        operation = str(self.payload.get("operation") or "")
        if self.adb(["get-state"], timeout=8).strip() != "device":
            raise RuntimeError("device_not_online")
        if not self.adb(["shell", "pm", "path", ALIPAY_PACKAGE], timeout=10).strip():
            raise RuntimeError("alipay_not_installed")
        if operation == "start":
            self.keep_awake_usb_best_effort()
            try:
                reused = self.try_reuse_search_page()
            except Exception as exc:
                self.emit("reuse_search_page_failed", error=str(exc))
                reused = False
            if not reused:
                self.prepare_full_path("session-start")
            return {
                "ok": True,
                "message": "search_session_ready",
                "currentAccount": self.current_account_after_switch or self.current_account(),
                "accountSwitched": self.account_switched,
                "accountSwitchReason": self.account_switch_reason,
                "log": self.log,
            }
        if operation == "list_accounts":
            self.emit("manual_account_list_requested", retryCurrentPhone=False)
            self.launch("account-list")
            rows = self.open_account_picker("list")
            choices = self.saved_account_choices(rows)
            self.saved_account_count = max(self.saved_account_count, len(rows))
            current_account = next(choice["account"] for choice in choices if choice["current"])
            self.emit(
                "saved_account_list_ready", currentAccount=current_account,
                savedAccountCount=len(choices),
            )
            return {
                "ok": True,
                "message": "saved_account_list_ready",
                "currentAccount": current_account,
                "savedAccounts": choices,
                "accountSwitched": False,
                "savedAccountCount": self.saved_account_count,
                "log": self.log,
            }
        if operation == "switch":
            target_account = str(self.payload.get("targetAccount") or "").strip()
            if not target_account:
                raise RuntimeError("alipay_target_account_required")
            self.emit(
                "manual_account_switch_requested", retryCurrentPhone=False,
                targetAccount=target_account,
            )
            current_account = self.switch_account(
                reason="manual", target_account=target_account,
                reuse_open_picker=True, verify_current_marker=False,
            )
            return {
                "ok": True,
                "message": "account_switch_completed",
                "currentAccount": current_account,
                "accountSwitched": True,
                "accountSwitchReason": "manual",
                "accountSwitchCount": len(self.account_switch_history),
                "accountSwitchHistory": self.account_switch_history,
                "savedAccountCount": self.saved_account_count,
                "log": self.log,
            }
        if operation == "stop":
            warmed = False
            try:
                root, parent, input_node = self.search_ready()
                self.clear_search_input(root, parent, input_node)
                warmed = True
            except Exception as exc:
                self.emit("stop_cleanup_skipped", reason=str(exc))
            self.emit("lookup_session_stopped", searchPageKeptWarm=warmed)
            return {"ok": True, "message": "session_stopped", "log": self.log}
        if operation != "query":
            raise RuntimeError("unsupported_operation")
        phone = re.sub(r"\D", "", str(self.payload.get("phoneNumber") or ""))
        if not re.fullmatch(r"1\d{10}", phone):
            raise RuntimeError("invalid_phone_number")
        max_recoveries = min(2, max(0, int(self.payload.get("maxRecoveryAttempts", 2))))

        def query_with_recovery():
            query_started = time.perf_counter()
            query_deadline = query_started + 55.0
            last_error = None
            for attempt in range(max_recoveries + 1):
                try:
                    return self.query_once(phone, query_deadline=query_deadline), attempt
                except Exception as exc:
                    last_error = exc
                    raw_error = str(exc)
                    if self.account_switch_reason_from_error(raw_error):
                        raise
                    if "alipay_human_verification_required" in raw_error:
                        raise
                    query_elapsed = time.perf_counter() - query_started
                    if attempt >= max_recoveries or query_elapsed >= 50:
                        break
                    self.emit("query_full_path_recovery", attempt=attempt + 1, error=raw_error)
                    self.prepare_full_path(f"query-recovery-{attempt + 1}")
            raise RuntimeError(f"alipay_lookup_failed_after_recovery:{last_error}")

        # Jigsaw verification is a human-control pause and never changes the
        # account. Only the exact, evidenced account-limit reasons above rotate
        # saved accounts. Every rotation retries this same phone before the
        # caller's queue may advance to the next item.
        while True:
            try:
                result, recovery_attempts = query_with_recovery()
                break
            except Exception as exc:
                restriction_reason = self.account_switch_reason_from_error(exc)
                if restriction_reason not in ACCOUNT_SWITCH_REASONS:
                    raise
                while True:
                    try:
                        self.switch_account_for_reason(restriction_reason)
                        break
                    except Exception as switch_error:
                        next_reason = self.account_switch_reason_from_error(switch_error)
                        if "alipay_all_saved_accounts_exhausted" in str(switch_error):
                            self.raise_all_accounts_restricted(restriction_reason, switch_error)
                        if next_reason in ACCOUNT_SWITCH_REASONS and self.current_account_after_switch:
                            self.restricted_accounts.add(self.current_account_after_switch)
                            restriction_reason = next_reason
                            continue
                        raise
        return {
            "ok": True,
            **result,
            "currentAccount": self.current_account_after_switch,
            "accountSwitched": self.account_switched,
            "accountSwitchReason": self.account_switch_reason,
            "accountSwitchCount": len(self.account_switch_history),
            "accountSwitchHistory": self.account_switch_history,
            "restrictedAccounts": sorted(self.restricted_accounts),
            "recoveryAttempts": recovery_attempts,
            "elapsedMs": int((time.perf_counter() - self.started) * 1000),
            "log": self.log,
        }


def run_poco_operation(payload, poco):
    """Run one Alipay operation inside the Agent's resident Poco worker."""
    runner = Runner(payload)
    try:
        result = runner.run_poco(poco)
        result.setdefault("elapsedMs", int((time.perf_counter() - runner.started) * 1000))
        return result
    except Exception as exc:
        runner.emit("poco_fast_path_failed", error=repr(exc), workflow="alipay_name")
        return {
            "ok": False,
            "error": str(exc),
            "elapsedMs": int((time.perf_counter() - runner.started) * 1000),
            "log": runner.log,
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", required=True)
    args = parser.parse_args()
    with open(args.payload, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    runner = Runner(payload)
    try:
        result = runner.run()
        result.setdefault("elapsedMs", int((time.perf_counter() - runner.started) * 1000))
    except Exception as exc:
        runner.emit("error", error=repr(exc), trace=traceback.format_exc(), focus=runner.focus())
        result = {
            "ok": False,
            "error": str(exc),
            "accountSwitched": runner.account_switched,
            "currentAccount": runner.current_account_after_switch,
            "accountSwitchReason": runner.account_switch_reason,
            "accountSwitchCount": len(runner.account_switch_history),
            "accountSwitchHistory": runner.account_switch_history,
            "restrictedAccounts": sorted(runner.restricted_accounts),
            "savedAccountCount": runner.saved_account_count,
            "elapsedMs": int((time.perf_counter() - runner.started) * 1000),
            "log": runner.log,
        }
    print(json.dumps(result, ensure_ascii=True), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
