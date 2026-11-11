#!/usr/bin/env python3
"""Collect visible Xiaohongshu Creator Center note list from one idle phone.

Navigation: 我 -> 菜单 -> 创作者中心 -> 最新笔记/更多 -> 作品分析.
This bounded probe reads list cards without opening notes. It writes a local
JSON snapshot only and does not publish, change accounts, or write to the Web
database. The list is reopened at its newest note and scanned for the last
30 days (or the configured window), not all history.
Only Android UI elements are read; no screenshot/OCR reader or image navigation.
An exact unfinished-note prompt is handled by saving the existing draft,
as authorized by the user, before continuing navigation.
"""

import argparse
import datetime as dt
import hashlib
from decimal import Decimal
import json
import os
import re
import subprocess
import sys
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

HIERARCHY_END = "</hierarchy>"
BOUNDS = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")
COUNT = re.compile(r"^(\d+(?:\.\d+)?)(万|亿)?$")
DATE = re.compile(r"^(?:\d{2}-\d{2}|\d{4}-\d{2}-\d{2})$")
XHS_PACKAGE = "com.xingin.xhs"
SHANGHAI = dt.timezone(dt.timedelta(hours=8))
# The list can expose full note text as its title (79/app2: 444 characters).
# Preserve that native value; geometry and the other five fields prove the row.
MAX_NATIVE_TITLE_CHARS = 4096
DATA_CENTER_LOAD_SECONDS = 45
DATA_CENTER_POLL_SECONDS = 2
DATA_CENTER_MAX_REOPENS = 2
# Real47/180 trials rejected this probe; retain experiments but do not pay
# its staging/read cost in the production collection path.
NATIVE_PAIR_PROBE_ENABLED = False



def adb_process(adb_path, serial, *args, timeout=12):
    read_only = (args[:2] == ("shell","dumpsys") and len(args) > 2 and args[2] in ("window","power")
                 or args[:3] == ("shell","settings","get") or args == ("get-state",)
                 or args[:3] in (("exec-out","uiautomator","dump"),("shell","uiautomator","dump"))
                 or args[:2] == ("exec-out","cat"))
    for attempt in range(3):
        result = subprocess.run(
            [adb_path, "-s", serial, *args], capture_output=True,
            timeout=timeout, check=False,
        )
        if not result.returncode:
            return result
        missing = f"device '{serial}' not found" in result.stderr.decode("utf-8","replace")
        # These reads can survive a transient USB transport loss (155).
        # Keep binary output intact; never replay inputs, writes or timeouts.
        if read_only and missing and attempt < 2:
            time.sleep(attempt+1)
            continue
        return result


def adb(adb_path, serial, *args, timeout=12):
    result = adb_process(adb_path,serial,*args,timeout=timeout)
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace").strip()[:300]
        raise RuntimeError(f"ADB {args[:3]} failed ({result.returncode}): {detail}")
    return result.stdout.decode("utf-8", "replace")


def bounds(node):
    match = BOUNDS.fullmatch(node.get("bounds", ""))
    return tuple(map(int, match.groups())) if match else None


def count(value):
    match = COUNT.fullmatch(str(value or "").strip())
    if not match:
        return None
    factor = {None: 1, "万": 10000, "亿": 100000000}[match.group(2)]
    return int(Decimal(match.group(1)) * factor)


def published_date(value, as_of):
    """Resolve the app's MM-DD label within its displayed recent history."""
    if not DATE.fullmatch(value):
        raise RuntimeError(f"unsupported note date: {value!r}")
    if len(value) == 10:
        candidate = dt.date.fromisoformat(value)
    else:
        month, day = map(int, value.split("-"))
        try:
            candidate = dt.date(as_of.year, month, day)
        except ValueError:
            candidate = dt.date(as_of.year - 1, month, day)
        if candidate > as_of:
            candidate = dt.date(as_of.year - 1, month, day)
    if candidate > as_of:
        raise RuntimeError(f"future note date: {value!r}")
    return candidate


def capture(adb_path, serial):
    for attempt in range(2):
        try:
            raw = adb(adb_path, serial, "exec-out", "uiautomator", "dump", "/dev/tty", timeout=15)
        except subprocess.TimeoutExpired:
            # A stuck /dev/tty dump does not rule out the existing fresh-file path.
            raw = ""
        start, end = raw.find("<hierarchy"), raw.rfind(HIERARCHY_END)
        if start >= 0 and end >= start:
            return ET.fromstring(raw[start:end + len(HIERARCHY_END)])
        if attempt == 0:
            time.sleep(0.5)
    current = focus(adb_path, serial)
    # Some OEM builds return no XML through /dev/tty while a file dump works.
    # Use a fresh per-capture path, never a cached hierarchy from another page.
    path = "/sdcard/phonecloud-xhs-capture-" + uuid.uuid4().hex + ".xml"
    try:
        adb(adb_path, serial, "shell", "uiautomator", "dump", path, timeout=15)
        raw = adb(adb_path, serial, "exec-out", "cat", path, timeout=8)
        start, end = raw.find("<hierarchy"), raw.rfind(HIERARCHY_END)
        if start >= 0 and end >= start:
            return ET.fromstring(raw[start:end + len(HIERARCHY_END)])
    except (RuntimeError, subprocess.TimeoutExpired):
        # Preserve the original no-hierarchy error for the narrowly scoped
        # transparent-notification recovery in navigation_capture.
        pass
    finally:
        adb(adb_path, serial, "shell", "rm", "-f", path, timeout=8)
    # 141 returned exit137 on an uncompressed dump. After both native paths
    # fail, try a fresh compressed hierarchy without changing device settings.
    try:
        raw = adb(adb_path, serial, "exec-out", "uiautomator", "dump", "--compressed", "/dev/tty", timeout=15)
        start, end = raw.find("<hierarchy"), raw.rfind(HIERARCHY_END)
        if start >= 0 and end >= start:
            return ET.fromstring(raw[start:end + len(HIERARCHY_END)])
    except (RuntimeError,subprocess.TimeoutExpired):
        pass
    raise RuntimeError("UIAutomator did not return an XML hierarchy")


class ElementListReadError(RuntimeError):
    pass


def require_element_tree(root):
    if root.get("data-source", "xml") != "xml":
        raise ElementListReadError("only native UI element hierarchies are allowed")


def login_activity(current):
    return bool(re.search(
        r"mCurrentFocus=Window\{[^\n}]*\bu\d+\s+com\.xingin\.xhs/com\.xingin\.login\."
        r"(?:halfwelcome\.HalfWelcomeActivity|activity\.WelcomeActivity|device\.offline\.DeviceOfflineRemindActivity)(?:[}\s]|$)",
        current))


def login_element_evidence(root, current, events):
    """A login Activity alone, empty tree or wrong slot never proves logout."""
    require_element_tree(root)
    nodes = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE]
    texts = {n.get("text", "").strip() for n in nodes}
    welcome_kind = native_welcome_login_controls(root, current)
    if welcome_kind and not {"我的草稿", "最新笔记", "作品分析"} & texts:
        assert_requested_foreground(current, events)
        return welcome_kind
    offline_copy = ("你的小红书账号已在其他设备登录，如非本人操作，请尽快在「设置-账号与安全-登录设备管理」中移除未知设备。" in texts
                    or any(re.fullmatch(r"你的小红书账号[^\r\n]{1,100}于\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"
                                        r"在其他设备[^\r\n]{1,100}登录。该账号的在线设备数量已达上限，本设备将自动退出登录", text) for text in texts))
    offline_copy = offline_copy or ("账号下线提示" in texts
                    and "账号已退出登录，请尝试重新登录" in texts)
    if ({"账号下线通知", "账号下线提示"} & texts and "重新登录" in texts and offline_copy
            and login_activity(current)):
        assert_requested_foreground(current, events)
        return "account_offline_notice"
    index = re.search(r"mCurrentFocus=Window\{[^\n}]*\bu\d+\s+com\.xingin\.xhs/(?:com\.xingin\.xhs\.index\.v2\.IndexActivityV2|\.index\.v2\.IndexActivityV2)[}\s]", current)
    login_title = bool({"登录后展示自己", "登录后，体验更多功能"} & texts)
    standard_controls = "微信登录" in texts and ("手机号登录" in texts or {"一键登录", "其他登录方式"} <= texts)
    selected_profile = any(n.get("class") == "android.view.ViewGroup" and n.get("selected") == "true"
                           and (n.get("content-desc") == "我" or n.get("text") == "我") for n in nodes)
    one_key_profile = (index and selected_profile and {"一键登录", "其他登录方式",
                       "我已阅读并同意《用户协议》《隐私政策》《未成年人个人信息保护规则》"} <= texts
                       and any(n.get("text") == "其他登录方式" and n.get("clickable") == "true"
                               and n.get("enabled") == "true" for n in nodes))
    if index and phone_only_profile_login_controls(root):
        assert_requested_foreground(current, events)
        return "phone_only_profile_login_controls"
    if ((login_activity(current) or index) and login_title and (standard_controls or one_key_profile)
            and not {"我的草稿", "最新笔记", "作品分析"} & texts):
        assert_requested_foreground(current, events)
        return "login_controls"
    return None


def phone_only_profile_login_controls(root):
    """Exact signed-out own-profile variant with a phone login button."""
    nodes = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
             and n.get("enabled") == "true" and n.get("visible-to-user") != "false"]
    if any(n.get("text") in {"编辑主页", "编辑资料", "我的草稿", "最新笔记", "作品分析"}
           or n.get("text", "").startswith(("小红书号:", "小红书号：")) for n in nodes):
        return False
    own = [n for n in nodes if n.get("class") == "android.view.ViewGroup"
           and n.get("content-desc") == "我" and n.get("selected") == "true"
           and n.get("clickable") == "true"]
    labels = ("登录后展示自己", "手机号登录", "其他登录方式",
              "我已阅读并同意《用户协议》《隐私政策》《未成年人个人信息保护规则》",
              "账号丢失了？", "找回账号")
    groups = [[n for n in nodes if n.get("class") == "android.widget.TextView"
               and n.get("text") == text] for text in labels]
    if len(own) != 1 or any(len(group) != 1 for group in groups):
        return False
    title, phone, other, agreement, lost, recover = [group[0] for group in groups]
    parents = {child: parent for parent in root.iter() for child in parent}
    button = parents.get(phone)
    if (button not in nodes or button.get("class") != "android.view.ViewGroup"
            or button.get("clickable") != "true" or other.get("clickable") != "true"
            or recover.get("clickable") != "true" or parents.get(lost) is not parents.get(recover)):
        return False
    boxes = [bounds(n) for n in (title, phone, other, agreement, lost, recover, own[0])]
    return (all(boxes) and boxes[0][3] < boxes[1][1] < boxes[2][1] < boxes[3][1] < boxes[4][1]
            and boxes[4][1] == boxes[5][1] < boxes[6][1])


def native_welcome_login_controls(root, current):
    """Exact native WelcomeActivity variants, with no image or SIM-number inference."""
    if not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu\d+\s+com\.xingin\.xhs/"
                     r"com\.xingin\.login\.activity\.WelcomeActivity(?:[}\s]|$)", current):
        return None
    nodes = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE]
    def one(name, cls, parent=None):
        found = [n for n in nodes if n.get("resource-id") == XHS_PACKAGE+":id/"+name
                 and n.get("class") == cls and n.get("enabled") == "true"]
        return found[0] if len(found) == 1 and (parent is None or found[0] in parent.iter("node")) else None
    welcome = one("welcomeContainer", "android.widget.FrameLayout")
    if welcome is None:return None
    main = one("mainLoginLayout", "android.widget.LinearLayout", welcome)
    if main is None:return None
    phone = one("mPhoneLoginView", "android.view.ViewGroup", main)
    privacy = one("privacyCheckContainer", "android.widget.LinearLayout", welcome)
    if privacy is None:return None
    check = one("privacyCheck", "android.widget.ImageView", privacy)
    protocol = one("loginProtocol", "android.widget.TextView", privacy)
    if check is None or check.get("clickable") != "true" or protocol is None:return None
    base_protocol = "我已阅读并同意《用户协议》《隐私政策》《儿童/青少年个人信息保护规则》"
    quick = one("quickLoginBtn", "android.widget.LinearLayout", main)
    phone_present = any(n.get("resource-id") == XHS_PACKAGE+":id/mPhoneLoginView" for n in nodes)
    quick_present = any(n.get("resource-id") == XHS_PACKAGE+":id/quickLoginBtn" for n in nodes)
    if phone is not None and not quick_present:
        text = one("mPhoneLoginTextView", "android.widget.TextView", phone)
        if (phone.get("clickable") == "true" and text is not None and text.get("text") == "手机号登录"
                and protocol.get("text") == base_protocol):return "phone_only_welcome_controls"
    if quick is not None and not phone_present:
        text = one("mTextTv", "android.widget.TextView", quick)
        other = one("otherLoginWays", "android.widget.TextView", main)
        if (quick.get("clickable") == "true" and text is not None and text.get("text") == "一键登录"
                and other is not None and other.get("text") == "其他登录方式" and other.get("clickable") == "true"
                and protocol.get("text") == base_protocol + "《联通统一认证服务条款》"):
            return "carrier_quick_welcome_controls"
    return None


def confirm_logged_out(adb_path, serial, root, guard, events):
    """Two fresh native trees plus the requested foreground user are required."""
    guard()
    current = focus(adb_path, serial)
    first = login_element_evidence(root, current, events)
    if first is None and login_activity(current):
        # Some OEM stock exports contain a valid but incomplete login root.
        # This is a read-only fallback, never an inference from the Activity.
        try:
            root = native_window_capture(adb_path, serial, current, guard, events)
        except RuntimeError as error:
            # A spontaneous update can replace the login window during a
            # read-only native export too. Its helper has proved cleanup before
            # this exception reaches us. Discard the entire stale tree once;
            # normal navigation must prove and dismiss the new overlay itself.
            changed = focus(adb_path, serial)
            if (str(error) not in {"native elements foreground changed before staging",
                                  "native elements foreground changed before read",
                                  "native elements foreground changed during read"}
                    or "login_confirmation_update_recheck" in events
                    or not re.search(r"com\.xingin\.xhs/com\.xingin\.update\.UpdateDialogActivity(?:[}\s]|$)", changed)):
                raise
            assert_requested_foreground(changed, events)
            guard()
            events.append("login_confirmation_update_recheck")
            return navigation_capture(adb_path, serial, guard, events)
        first = login_element_evidence(root, current, events)
        events.append("login_native_confirmation_fallback")
    if first is None:
        raise ElementListReadError("login state lacks native element evidence")
    def signature(tree):
        if first in {"phone_only_welcome_controls", "carrier_quick_welcome_controls"}:
            roles = {"welcomeContainer", "mainLoginLayout", "mPhoneLoginView", "mPhoneLoginTextView",
                     "privacyCheckContainer", "privacyCheck", "loginProtocol", "quickLoginBtn", "mTextTv", "otherLoginWays"}
            return sorted(tuple(n.get(k, "") for k in ("resource-id", "class", "text", "clickable", "enabled"))
                          for n in live_nodes(tree) if n.get("package") == XHS_PACKAGE
                          and n.get("resource-id", "").removeprefix(XHS_PACKAGE+":id/") in roles)
        markers = {"登录后展示自己", "登录后，体验更多功能", "微信登录", "手机号登录", "一键登录", "其他登录方式", "账号下线通知", "账号下线提示", "账号已退出登录，请尝试重新登录", "重新登录"}
        return sorted(n.get("text", "").strip() for n in live_nodes(tree) if n.get("package") == XHS_PACKAGE
                      and (n.get("text", "").strip() in markers or n.get("text", "").startswith("你的小红书账号")))
    first_signature = signature(root)
    time.sleep(.5)
    guard()
    if first == "phone_only_profile_login_controls":
        from xhs_native_window import same_foreground
        first_native = native_window_capture(adb_path, serial, current, guard, list(events))
        if (not same_foreground(current, focus(adb_path, serial))
                or login_element_evidence(first_native, current, events) != first
                or signature(first_native) != first_signature):
            raise ElementListReadError("login state changed during native confirmation")
        guard()
        time.sleep(.5)
        fresh = native_window_capture(adb_path, serial, current, guard, list(events))
        if not same_foreground(current, focus(adb_path, serial)):
            raise ElementListReadError("login state changed during native confirmation")
    else:
        fresh = (navigation_capture(adb_path, serial, guard, events)
                 if "native_window_elements_enabled" in events else capture(adb_path, serial))
    second = login_element_evidence(fresh, focus(adb_path, serial), events)
    if first != second or first_signature != signature(fresh):
        modes = {"phone_only_welcome_controls", "carrier_quick_welcome_controls"}
        if (first in modes and second in modes and "native_welcome_confirmation_recheck_once" not in events):
            # Carrier auth may finish loading after the phone-only page. Discard
            # the mismatched pair once and require two new matching native reads.
            events.append("native_welcome_confirmation_recheck_once")
            time.sleep(.5);guard()
            current = focus(adb_path, serial);assert_requested_foreground(current, events)
            fresh = native_window_capture(adb_path, serial, current, guard, events)
            return confirm_logged_out(adb_path, serial, fresh, guard, events)
        raise ElementListReadError("login state changed during native confirmation")
    events.append("login_state_confirmed:" + first)
    raise RuntimeError("Xiaohongshu account is logged out; manual login is required")


def assert_requested_foreground(current, events):
    current = current_window_dump(current)
    slots = {e.split(":", 1)[1] for e in events if e.startswith("collection_slot_requested:")}
    users = {e.split(":", 1)[1] for e in events if e.startswith("clone_user_requested:")}
    windows = re.findall(r"mCurrentFocus=Window\{[^\n}]+\}",current)
    if (slots == {"app1"} and not (users-{"0"}) and len(windows) == 1
            and re.search(r"\bu0\s+Application Not Responding: com\.xingin\.xhs(?:[}\s]|$)",windows[0])):
        # This is an app failure, never a wrong-slot or signed-out assertion.
        raise RuntimeError("Xiaohongshu app is not responding; collection stopped")
    expected = "0" if slots == {"app1"} else next(iter(users)) if slots == {"app2"} and len(users) == 1 else None
    if expected is None or not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu" + re.escape(expected)
                                       + r"\s+com\.xingin\.xhs/", current):
        raise RuntimeError("Xiaohongshu foreground user does not match the requested slot")


def works_webview_activity(current):
    return bool(re.search(r"\bu\d+\s+com\.xingin\.xhs/(?:com\.xingin\.xywebview\.activity\.WebViewActivityV2|"
                          r"\.xywebview\.activity\.WebViewActivityV2)(?:[}\s]|$)", current))


def data_center_tab_header(root):
    views = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
             and n.get("class") == "android.webkit.WebView" and n.get("text") == "数据中心"]
    if len(views) != 1:return False
    height = bounds(views[0])[3]
    for text in ("账号概览","作品分析","粉丝数据","收入数据"):
        matches = [n for n in live_nodes(views[0]) if n.get("package") == XHS_PACKAGE
                   and n.get("class") in ("android.widget.TextView","android.view.View") and n.get("text") == text]
        if len(matches) != 1 or bounds(matches[0])[3] > height*.25:return False
    return True






class CleanNativeRootUnavailable(RuntimeError):
    """Exact missing-root rejection after normal reader exit and file cleanup."""


def native_window_capture(adb_path, serial, current, guard, events):
    from xhs_native_window import read
    assert_requested_foreground(current, events)
    assert_no_poco(adb_path, serial)
    reader_exit_codes = []
    def read_process(adb, target, *args, **kwargs):
        result = adb_process(adb, target, *args, **kwargs)
        if len(args) == 2 and args[0] == "shell" and args[1].endswith(" NativeWindowReader"):
            reader_exit_codes.append(result.returncode)
        return result
    try:
        root = read(adb_path, serial, read_process, lambda: focus(adb_path, serial), guard, current)
    except RuntimeError as error:
        if (str(error) == "native elements command failed: native_elements_unproven:IllegalStateException:native root missing"
                and reader_exit_codes == [1]):
            # The fixed reader's finally has also removed and checked its jar;
            # cleanup rejection would replace this exception before it returns.
            raise CleanNativeRootUnavailable(str(error)) from error
        raise
    require_element_tree(root)
    if "native_window_elements_enabled" not in events:
        events.append("native_window_elements_enabled")
    return root


def navigation_capture(adb_path, serial, guard, events):
    # Once stock export fails, use the complete native reader on this WebView.
    # Every read still proves foreground user, occupancy and native node identity.
    from xhs_native_window import readable_foreground, honor_owner_foreground, read_honor_owner
    if "native_window_elements_enabled" in events:
        current = focus(adb_path, serial)
        if readable_foreground(current):
            transitions = {
                "native elements foreground changed before staging",
                "native elements foreground changed before read",
                "native elements foreground changed during read",
            }
            for attempt in range(3):
                try:
                    return native_window_capture(adb_path, serial, current, guard, events)
                except RuntimeError as error:
                    if (str(error) not in transitions or attempt == 2
                            or any(e.startswith("collection_scan_as_of:") for e in events)):
                        raise
                    events.append("navigation_native_transition_read_retry")
                    for _ in range(6):
                        time.sleep(.4)
                        guard()
                        fresh = focus(adb_path, serial)
                        if not fresh:
                            continue
                        assert_requested_foreground(fresh, events)
                        if not readable_foreground(fresh):
                            raise ElementListReadError("navigation transition surface is unproven")
                        current = fresh
                        break
                    else:
                        raise ElementListReadError("navigation focus did not settle after transition") from error
    try:
        root = capture(adb_path, serial)
        if not list(root.iter("node")):
            raise RuntimeError("UIAutomator did not return an XML hierarchy")
    except (RuntimeError,subprocess.TimeoutExpired) as error:
        current = focus(adb_path, serial)
        if ("collection_slot_requested:app1" in events and
                re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+Application Not Responding: com\.xingin\.xhs(?:[}\s]|$)",current)):
            # Preserve the existing element-backed ANR wait when a dialog tree
            # is readable. Only classify a failed export here; never reopen it
            # as a wrong-slot task or infer account logout.
            assert_requested_foreground(current,events)
        if (not current and (isinstance(error,subprocess.TimeoutExpired)
                             or "did not return an XML hierarchy" in str(error))
                and "focusless_asleep_recovery_attempted" not in events
                and len({e for e in events if e.startswith("collection_slot_requested:")}) == 1):
            # 47 had no input focus because its physical display actually slept.
            # The older focusless recovery covers an awake-but-unlit panel only.
            # Reuse the existing power-state-checked wake, once, then read afresh.
            events.append("focusless_asleep_recovery_attempted")
            if wake_if_asleep(adb_path, serial, guard, events):
                events.append("focusless_asleep_recovered")
                return navigation_capture(adb_path, serial, guard, events)
        if (not current and (isinstance(error,subprocess.TimeoutExpired)
                             or "did not return an XML hierarchy" in str(error))
                and wake_focusless_display(adb_path, serial, guard, events)):
            return capture(adb_path, serial)
        notification = re.search(
            r"com\.xingin\.xhs/(?:com\.xingin\.authorization\.NotificationAuthorizationTranslucentActivity|"
            r"\.authorization\.NotificationAuthorizationTranslucentActivity)(?:[}\s]|$)", current)
        if (honor_owner_foreground(current) and "did not return an XML hierarchy" in str(error)
                and {e for e in events if e.startswith("collection_slot_requested:")} == {"collection_slot_requested:app1"}
                and not any(e.startswith("collection_scan_as_of:") for e in events)):
            # Read only the exact owner chooser; the existing two-card element
            # validator selects it and must subsequently prove XHS user zero.
            assert_no_poco(adb_path, serial)
            root = read_honor_owner(adb_path,serial,adb_process,lambda:focus(adb_path,serial),guard,current)
            require_element_tree(root)
            events.append("honor_owner_chooser_native_elements")
            return root
        if readable_foreground(current) and (isinstance(error,subprocess.TimeoutExpired)
                or "did not return an XML hierarchy" in str(error)):
            assert_requested_foreground(current, events)
            try:
                return native_window_capture(adb_path, serial, current, guard, events)
            except (RuntimeError, subprocess.TimeoutExpired) as native_error:
                if not (isinstance(native_error, subprocess.TimeoutExpired)
                        or str(native_error).startswith("native elements command failed: native_elements_unproven:")):
                    raise
                # Preserve the existing bounded entry recovery only before scanning.
                # Recheck occupancy/slot first; an incomplete snapshot is never accepted.
                guard()
                assert_requested_foreground(focus(adb_path, serial), events)
                events.append("native_window_elements_rejected:" + type(native_error).__name__)
            if (works_webview_activity(current) and "creator_more_selected" in events and "works_native_more_recovery_attempted" not in events
                    and "data_center_loading_active" not in events
                    and not any(e.startswith("collection_scan_as_of:") for e in events)):
                return recover_inaccessible_more(adb_path, serial, current, guard, events)
            raise ElementListReadError("UI elements unavailable after fresh hierarchy reads") from error
        if "did not return an XML hierarchy" not in str(error) or not notification:
            raise
        guard()
        adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
        time.sleep(0.4)
        events.append("inaccessible_notification_prompt_back")
        return capture(adb_path, serial)
    require_element_tree(root)
    return root


def assert_no_poco(adb_path, serial):
    processes = adb(adb_path, serial, "shell", "ps", "-A", timeout=8)
    if "com.netease.open.pocoservice" in processes.lower():
        raise RuntimeError("PocoService is active on this phone; collection stopped")


def release_idle_poco(adb_path, serial, guard, events):
    """Release only the selected idle phone's leftover Poco before XML use."""
    processes = adb(adb_path, serial, "shell", "ps", "-A", timeout=8)
    if "com.netease.open.pocoservice" not in processes.lower():
        return
    guard()
    adb(adb_path, serial, "shell", "am", "force-stop", "com.netease.open.pocoservice", timeout=8)
    time.sleep(0.4)
    assert_no_poco(adb_path, serial)
    events.append("idle_poco_released")


def assert_idle(cache_path, serial, device_name, task_id="", app_slot="", cancel_path=""):
    if cancel_path and Path(cancel_path).exists():
        raise RuntimeError("automation_task_cancelled")
    path = Path(cache_path)
    if time.time() - path.stat().st_mtime > 90:
        raise RuntimeError("device inventory cache is stale")
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    devices = payload if isinstance(payload, list) else payload.get("devices", [])
    matches = [item for item in devices if str(item.get("adb", {}).get("serial", "")).lower() == serial.lower()]
    if len(matches) != 1:
        raise RuntimeError("target serial is not unique in the device inventory")
    item = matches[0]
    if str(item.get("deviceName")) != str(device_name):
        raise RuntimeError("target serial does not match the requested device name")
    occupancy = item.get("occupancy")
    own_task = bool(task_id and isinstance(occupancy, dict)
                    and occupancy.get("kind") == "xhs_data_collect"
                    and occupancy.get("taskId") == task_id and occupancy.get("appSlot") == app_slot)
    if item.get("adb", {}).get("state") != "device" or (occupancy and not own_task):
        raise RuntimeError("target phone is offline or occupied")
    return item


def live_nodes(root):
    visible = []
    for node in root.iter("node"):
        box = bounds(node)
        if box and box[2] > box[0] and box[3] > box[1]:
            visible.append(node)
    return visible


def label(root, value):
    return [n for n in live_nodes(root)
            if n.get("text", "").strip() == value or n.get("content-desc", "").strip() == value]


def tap_label(adb_path, serial, root, value, guard=lambda: None):
    matches = label(root, value)
    if not matches:
        raise RuntimeError(f"visible navigation label missing: {value}")
    parents = {child: parent for parent in root.iter() for child in parent}
    choices = []
    for node in matches:
        candidate = node
        while candidate is not None and candidate.get("clickable") != "true":
            candidate = parents.get(candidate)
        if candidate is not None and candidate in live_nodes(root):
            box = bounds(candidate)
            choices.append(((box[2]-box[0])*(box[3]-box[1]), candidate))
    if not choices:
        raise RuntimeError(f"navigation label has no clickable ancestor: {value}")
    node = min(choices, key=lambda item: item[0])[1]
    x1, y1, x2, y2 = bounds(node)
    guard()
    adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
    time.sleep(0.5)


def current_window_dump(output):
    """Discard a recorded LAST ANR snapshot; never borrow its old focus."""
    if "WINDOW MANAGER LAST ANR (dumpsys window lastanr)" not in output:
        return output
    policies = list(re.finditer(r"(?m)^WINDOW MANAGER POLICY STATE \(dumpsys window policy\)\r?$", output))
    if policies:
        current = output[policies[-1].start():]
        if (re.search(r"(?m)^WINDOW MANAGER DISPLAY CONTENTS \(dumpsys window displays\)\r?$", current)
                and re.search(r"(?m)^WINDOW MANAGER WINDOWS \(dumpsys window windows\)\r?$", current)):
            return current
    sections = re.split(r"(?m)^WINDOW MANAGER ", output)
    first = sections[1] if len(sections)>1 else ""
    if re.search(r"(?m)^\s*<no ANR has occurred since boot>\s*$",first):
        return output
    return ""


def focus(adb_path, serial):
    output = current_window_dump(adb(adb_path, serial, "shell", "dumpsys", "window", timeout=8))
    lines = [line.strip() for line in output.splitlines() if "mCurrentFocus=" in line]
    return next((line for line in reversed(lines) if "mCurrentFocus=null" not in line), "")


def wake_if_asleep(adb_path, serial, guard, events, dismiss_lock=True):
    power = adb(adb_path, serial, "shell", "dumpsys", "power", timeout=8)
    if "mWakefulness=Asleep" not in power and "mWakefulness=Dozing" not in power:
        return False
    guard()
    adb(adb_path, serial, "shell", "input", "keyevent", "224", timeout=7)
    adb(adb_path, serial, "shell", "wm", "dismiss-keyguard", timeout=7)
    time.sleep(0.4)
    power = adb(adb_path, serial, "shell", "dumpsys", "power", timeout=8)
    if "mWakefulness=Awake" not in power:
        guard()
        adb(adb_path, serial, "shell", "input", "keyevent", "26", timeout=7)
        adb(adb_path, serial, "shell", "wm", "dismiss-keyguard", timeout=7)
        time.sleep(0.4)
        power = adb(adb_path, serial, "shell", "dumpsys", "power", timeout=8)
    if "mWakefulness=Awake" not in power:
        raise RuntimeError("target display did not wake")
    # Some OEMs wake the display while leaving the swipe-only keyguard shown.
    # Reuse the proven nonsecure surface checks before recapturing app content.
    if dismiss_lock:
        dismiss_unsecured_keyguard(adb_path,serial,guard,events)
    events.append("screen_woken_after_timeout")
    return True


def default_display_state(window_dump):
    # Vivo may have an awake virtual display while the physical panel is off.
    # Never substitute display90000 (or an ambiguous dump) for display0.
    sections = re.split(r"(?m)^[ \t]*Display: mDisplayId=", window_dump)[1:]
    matches = [part for part in sections if re.match(r"0(?:[ \t]|$)", part)]
    if len(matches) != 1:return None
    states = re.findall(r"\bmAwake=(true|false)\s+mScreenOnEarly=(true|false)\s+mScreenOnFully=(true|false)\b", matches[0])
    return states[0] if len(states) == 1 else None


def default_display_unlit(policy):
    return default_display_state(policy) == ("true", "false", "false")


def wake_focusless_display(adb_path, serial, guard, events):
    slots = {e.split(":",1)[1] for e in events if e.startswith("collection_slot_requested:")}
    users = {e.split(":",1)[1] for e in events if e.startswith("clone_user_requested:")}
    marker = "focusless_default_display_wake_attempted"
    if (len(slots) != 1 or not slots <= {"app1","app2"} or marker in events
            or (slots == {"app2"} and (len(users) != 1 or not users <= {"128","999"}))):
        return False
    guard()
    if focus(adb_path, serial):return False
    policy = adb(adb_path, serial, "shell", "dumpsys", "window", timeout=8)
    if not default_display_unlit(policy):return False
    power = adb(adb_path, serial, "shell", "dumpsys", "power", timeout=8)
    if len(re.findall(r"(?m)^[ \t]*mWakefulness=Awake[ \t]*$",power)) != 1:return False
    guard()
    if focus(adb_path, serial):return False
    events.append(marker)
    adb(adb_path, serial, "shell", "input", "keyevent", "224", timeout=7)
    for _ in range(4):
        time.sleep(.4)
        policy = adb(adb_path, serial, "shell", "dumpsys", "window", timeout=8)
        if default_display_state(policy) == ("true", "true", "true"):
            dismiss_unsecured_keyguard(adb_path, serial, guard, events)
            events.append("focusless_default_display_woken")
            return True
    raise RuntimeError("default display stayed unlit after one confirmed wake attempt")


def explicit_clone_user(adb_path, serial):
    """Use only brand/profile pairs observed in fleet QA, never guess a user."""
    brand = adb(adb_path, serial, "shell", "getprop", "ro.product.manufacturer").strip().upper()
    profiles = {"HONOR": ("128", "分身应用"), "HUAWEI": ("128", "分身应用"),
                "XIAOMI": ("999", "XSpace"),
                "OPPO": ("999", "MultiApp"), "VIVO": ("999", "应用分身")}
    if brand not in profiles:
        return None
    expected_id, expected_name = profiles[brand]
    users = adb(adb_path, serial, "shell", "pm", "list", "users")
    clones = re.findall(r"UserInfo\{(" + expected_id + "):" + re.escape(expected_name) + r":[0-9a-fA-F]+\}", users)
    if len(clones) != 1:
        raise RuntimeError("Xiaohongshu clone profile is not uniquely proven")
    installed = adb(adb_path, serial, "shell", "pm", "list", "packages", "--user", clones[0], XHS_PACKAGE)
    if f"package:{XHS_PACKAGE}" not in installed.splitlines():
        raise RuntimeError("Xiaohongshu is not installed in the requested clone profile")
    return clones[0]


def dismiss_unsecured_keyguard(adb_path, serial, guard, events):
    policy = adb(adb_path, serial, "shell", "dumpsys", "window", "policy", timeout=8)
    if "KeyguardServiceDelegate" not in policy:
        return False
    delegate = policy.split("KeyguardServiceDelegate", 1)[1].split("KeyguardStateMonitor", 1)[0]
    showing = re.findall(r"^\s*showing=(true|false)\s*$", delegate, re.MULTILINE)
    secure = re.findall(r"^\s*secure=(true|false)\s*$", delegate, re.MULTILINE)
    if showing == ["false"] or not showing:
        return False
    if showing != ["true"] or secure != ["false"]:
        raise RuntimeError("target keyguard requires manual unlock or its security state is unproven")
    current = focus(adb_path, serial)
    if XHS_PACKAGE in current or "mKeyguardOccluded=false" not in policy:
        raise RuntimeError("unsecured keyguard foreground is not proven")
    guard()
    adb(adb_path, serial, "shell", "input", "keyevent", "82", timeout=7)
    adb(adb_path, serial, "shell", "wm", "dismiss-keyguard", timeout=7)
    time.sleep(.5)
    swiped = False
    for attempt in range(8):
        refreshed = adb(adb_path, serial, "shell", "dumpsys", "window", "policy", timeout=8)
        section = refreshed.split("KeyguardServiceDelegate", 1)[-1].split("KeyguardStateMonitor", 1)[0]
        if re.findall(r"^\s*showing=(true|false)\s*$", section, re.MULTILINE) == ["false"]:
            break
        if (re.findall(r"^\s*secure=(true|false)\s*$", section, re.MULTILINE) != ["false"]
                or "mKeyguardOccluded=false" not in refreshed):
            raise RuntimeError("target keyguard requires manual unlock or its security state is unproven")
        if attempt >= 1 and not swiped:
            # These OEMs ignore MENU/dismiss-keyguard on their swipe-only lock.
            # A swipe is allowed only on the still-proven unsecured lock surface.
            current = focus(adb_path, serial)
            if not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+(?:StatusBar|NotificationShade|com\.android\.systemui[^}]*NotificationShade)[}\s]", current):
                # Wake/dismiss can leave an old showing=true while the app is
                # already foreground. Wait for policy; never swipe that app.
                if attempt == 7:raise RuntimeError("unsecured keyguard swipe surface is not proven")
                time.sleep(.5)
                continue
            size = adb(adb_path, serial, "shell", "wm", "size", timeout=7)
            physical = re.findall(r"Physical size: (\d+)x(\d+)", size)
            override = re.findall(r"Override size: (\d+)x(\d+)", size)
            sizes = override or physical
            if len(sizes) != 1 or not all(300 <= int(v) <= 5000 for v in sizes[0]):
                raise RuntimeError("unsecured keyguard screen size is not proven")
            width, height = map(int, sizes[0])
            guard()
            try:
                adb(adb_path, serial, "shell", "input", "swipe", str(width//2), str(height*85//100),
                    str(width//2), str(height*30//100), "350", timeout=7)
            except subprocess.TimeoutExpired:
                # The swipe can complete on-device after its ADB client times
                # out. Accept only the readback of the actual unlocked state.
                guard()
                window = adb(adb_path, serial, "shell", "dumpsys", "window", timeout=8)
                after = window.partition("KeyguardServiceDelegate")[2].partition("KeyguardStateMonitor")[0]
                if (default_display_state(window) != ("true", "true", "true")
                        or any(re.findall(r"^\s*" + key + r"=(true|false)\s*$", after, re.MULTILINE) != ["false"]
                               for key in ("showing", "secure", "occluded", "inputRestricted"))):
                    raise
                focused = [line.strip() for line in window.splitlines()
                           if "mCurrentFocus=Window{" in line]
                if len(focused) != 1:
                    raise
                assert_requested_foreground(focused[0], events)
                events.append("unsecured_keyguard_swipe_completed_after_timeout")
                break
            swiped = True
        if attempt == 7:
            raise RuntimeError("unsecured keyguard stayed visible after dismissal")
        time.sleep(.5)
    events.append("unsecured_keyguard_dismissed")
    return True


def verify_collection_slot(adb_path, serial, slot, events):
    requested = [event.split(":", 1)[1] for event in events if event.startswith("clone_user_requested:")]
    if slot == "app1" and not requested:
        # Owner-only models have no clone chooser. Persist the same foreground
        # proof instead of making downstream audits infer it from call paths.
        current = focus(adb_path, serial)
        if not re.search(r"\bu0\s+com\.xingin\.xhs/", current):
            raise RuntimeError("Xiaohongshu foreground owner user does not match the requested slot")
        if "clone_slot_selected:app1" not in events:
            events.append("clone_slot_selected:app1")
    if requested:
        current = focus(adb_path, serial)
        if len(requested) != 1 or not re.search(r"\bu" + re.escape(requested[0]) + r"\s+com\.xingin\.xhs/", current):
            raise RuntimeError("Xiaohongshu foreground clone user does not match the requested slot")
        if "clone_slot_selected:" + slot not in events:
            events.append("clone_slot_selected:" + slot)
    if slot == "app2" and "clone_slot_selected:app2" not in events:
        raise RuntimeError("Xiaohongshu clone slot could not be proven")


def select_miui_clone(adb_path, serial, root, current, slot, guard, events):
    """MIUI gives both items the same text; use the observed slot container and icon."""
    if (not re.search(r"\bandroid/com\.android\.internal\.app\.ResolverActivity(?:[}\s]|$)", current)
            or not any(n.get("package") == "android" and n.get("resource-id") == "miui:id/alertTitle"
                       and n.get("text") == "请选择要使用的应用" for n in live_nodes(root))):
        return False
    choices = [n for n in live_nodes(root) if n.get("package") == "android"
               and n.get("resource-id") == "android.miui:id/" + slot
               and n.get("class") == "android.widget.LinearLayout"
               and n.get("clickable") == "true" and n.get("enabled") == "true"]
    if len(choices) != 1 or not label(choices[0], "小红书"):
        raise RuntimeError("MIUI Xiaohongshu clone slot container is not uniquely proven")
    icon = "小红书" if slot == "app1" else "双开小红书"
    if len([n for n in live_nodes(choices[0]) if n.get("package") == "android"
            and n.get("class") == "android.widget.ImageView" and n.get("content-desc") == icon]) != 1:
        raise RuntimeError("MIUI Xiaohongshu clone icon does not match the requested slot")
    x1, y1, x2, y2 = bounds(choices[0])
    guard()
    adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
    time.sleep(0.5)
    requested = "clone_user_requested:" + ("0" if slot == "app1" else "999")
    if requested not in events:
        events.append(requested)
    if "clone_slot_selected:" + slot not in events:
        events.append("clone_slot_selected:" + slot)
    events.append("miui_clone_container_selected:" + slot)
    return True


def select_oppo_clone(adb_path, serial, root, current, slot, guard, events):
    package = "com.android.intentresolver"
    if not re.search(r"\bcom\.android\.intentresolver/com\.android\.intentresolver\.ChooserActivityLauncher(?:[}\s]|$)", current):
        return False
    remember = [n for n in live_nodes(root) if n.get("package") == package
                and n.get("resource-id") == package + ":id/button_always_multiapp"
                and n.get("class") == "android.widget.CheckBox"]
    if len(remember) != 1 or remember[0].get("checked") != "false":
        raise RuntimeError("OPPO clone one-time selection is not proven")
    value = "小红书" if slot == "app1" else "小红书(分身)"
    labels = [n for n in label(root, value) if n.get("package") == package
              and n.get("resource-id") == "android:id/text1" and n.get("enabled") == "true"]
    parents = {child: parent for parent in root.iter() for child in parent}
    rows = [parents.get(n) for n in labels]
    if (len(rows) != 1 or rows[0] is None or rows[0].get("package") != package
            or rows[0].get("resource-id") != package + ":id/resolver_item_layout"
            or rows[0].get("class") != "android.widget.LinearLayout"
            or rows[0].get("clickable") != "true" or rows[0].get("enabled") != "true"
            or rows[0] not in live_nodes(root)):
        raise RuntimeError("OPPO Xiaohongshu clone slot item is not uniquely proven")
    x1, y1, x2, y2 = bounds(rows[0])
    guard()
    adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
    time.sleep(0.5)
    for event in ("clone_user_requested:" + ("0" if slot == "app1" else "999"), "clone_slot_selected:" + slot):
        if event not in events:
            events.append(event)
    events.append("oppo_clone_item_selected:" + slot)
    return True


def select_honor_owner(adb_path, serial, root, current, slot, guard, events):
    """188's observed chooser has an owner icon at left and a badged clone at right.

    Restrict selection to this exact two-item layout; verify u0 before any
    Creator Center navigation. A changed OEM order fails without reading data.
    """
    package = "com.hihonor.android.internal.app"
    if (slot != "app1" or not re.search(r"\bcom\.hihonor\.android\.internal\.app/com\.hihonor\.android\.internal\.app\.HwChooserActivity(?:[}\s]|$)", current)
            or not any(n.get("package") == package and n.get("resource-id") == "android:id/alertTitle"
                       and n.get("text") == "使用以下方式打开" for n in live_nodes(root))):
        return False
    profiles = [n for n in live_nodes(root) if n.get("package") == package
                and n.get("resource-id") == package + ":id/normal_profile_layout"]
    grids = [n for n in profiles[0].iter("node") if n.get("class") == "android.widget.GridView" and n in live_nodes(root)] if len(profiles) == 1 else []
    rows = list(grids[0]) if len(grids) == 1 else []
    if (len(rows) != 2 or any(n.get("package") != package or n.get("class") != "android.widget.LinearLayout"
                            or n.get("enabled") != "true" or n not in live_nodes(root)
                            or len([c for c in n.iter("node") if c.get("package") == package
                                    and c.get("resource-id") == "android:id/text1" and c.get("text") == "小红书"]) != 1
                            or len([c for c in n.iter("node") if c.get("package") == package
                                    and c.get("class") == "android.widget.ImageView" and c in live_nodes(root)]) != 1 for n in rows)):
        raise RuntimeError("Honor owner selector layout is not uniquely proven")
    rows.sort(key=lambda n: bounds(n)[0])
    left, right, grid = bounds(rows[0]), bounds(rows[1]), bounds(grids[0])
    if left[0] != grid[0] or left[2] != right[0] or right[2] != grid[2] or explicit_clone_user(adb_path, serial) != "128":
        raise RuntimeError("Honor owner selector profile/layout is not proven")
    guard()
    adb(adb_path, serial, "shell", "input", "tap", str((left[0]+left[2])//2), str((left[1]+left[3])//2), timeout=7)
    time.sleep(0.5)
    if "clone_user_requested:0" not in events:
        events.append("clone_user_requested:0")
    events.append("honor_owner_item_selected")
    return True


def vivo_startup_launcher(window_dump):
    """Prove the physical display's idle owner launcher, never a virtual display."""
    sections = re.split(r"(?m)^[ \t]*Display: mDisplayId=", window_dump)[1:]
    physical = [part for part in sections if re.match(r"0(?:[ \t]|$)", part)]
    if len(physical) != 1 or default_display_state(window_dump) not in (
            ("true", "true", "true"), ("true", "false", "false")):
        return False
    current = re.findall(r"(?m)^\s*mCurrentFocus=(.+)$", physical[0])
    focused = re.findall(r"(?m)^\s*mFocusedApp=(.+)$", physical[0])
    launcher = r"\bu0\s+com\.bbk\.launcher2/(?:com\.bbk\.launcher2\.Launcher|\.Launcher)(?:[}\s]|$)"
    if (len(current) != 1 or len(focused) != 1 or not re.search(launcher, focused[0])
            or (current[0].strip() != "null" and not re.search(launcher, current[0]))):
        return False
    if window_dump.count("KeyguardServiceDelegate") != 1:
        return False
    delegate = window_dump.split("KeyguardServiceDelegate", 1)[1].split("KeyguardStateMonitor", 1)[0]
    return (re.findall(r"(?m)^\s*showing=(true|false)\s*$", delegate) == ["false"]
            and re.findall(r"(?m)^\s*secure=(true|false)\s*$", delegate) == ["false"])


def vivo_startup_surface(window_dump, expected_user):
    """Classify only the unlocked physical screen after our one startup retry."""
    if expected_user not in ("0", "999"):
        return "unproven"
    sections = re.split(r"(?m)^[ \t]*Display: mDisplayId=", window_dump)[1:]
    physical = [part for part in sections if re.match(r"0(?:[ \t]|$)", part)]
    if len(physical) != 1 or window_dump.count("KeyguardServiceDelegate") != 1:
        return "unproven"
    delegate = window_dump.split("KeyguardServiceDelegate", 1)[1].split("KeyguardStateMonitor", 1)[0]
    if (re.findall(r"(?m)^\s*showing=(true|false)\s*$", delegate) != ["false"]
            or re.findall(r"(?m)^\s*secure=(true|false)\s*$", delegate) != ["false"]):
        return "unproven"
    current = re.findall(r"(?m)^\s*mCurrentFocus=(.+)$", physical[0])
    focused = re.findall(r"(?m)^\s*mFocusedApp=(.+)$", physical[0])
    if len(current) != 1 or len(focused) != 1:
        return "unproven"
    target = r"\bu" + expected_user + r"\s+com\.xingin\.xhs/[A-Za-z0-9_.$]+(?:[}\s]|$)"
    selector = (r"\bu0\s+com\.android\.intentresolver/(?:com\.android\.intentresolver\."
                r"|\.)DoubleAppResolverActivity(?:[}\s]|$)")
    launcher = r"\bu0\s+com\.bbk\.launcher2/(?:com\.bbk\.launcher2\.Launcher|\.Launcher)(?:[}\s]|$)"
    state = default_display_state(window_dump)
    if state == ("true", "true", "true"):
        if re.search(target, current[0]) and re.search(target, focused[0]):
            return "target"
        if re.search(selector, current[0]) and re.search(selector, focused[0]):
            return "selector"
    if state in (("true", "true", "true"), ("true", "true", "false"), ("true", "false", "false")):
        if (current[0].strip() == "null" and any(re.search(pattern, focused[0]) for pattern in (launcher, target, selector))
                or re.search(launcher, current[0]) and re.search(launcher, focused[0])):
            return "pending"
    return "unproven"


def capture_vivo_startup_retry(adb_path, serial, slot, clone_user, guard, events):
    # am start -W may return at the OEM selector, or before input focus exists.
    # Ten-second polling budget; individual ADB reads have their own timeout.
    # Never send another launch/key while waiting.
    expected_user = "0" if slot == "app1" else clone_user
    deadline = time.monotonic() + 10
    for _ in range(20):
        guard()
        surface = vivo_startup_surface(adb(adb_path, serial, "shell", "dumpsys", "window", timeout=8), expected_user)
        if surface == "unproven":
            raise RuntimeError("Xiaohongshu startup retry surface is unproven; no further input")
        if surface in ("target", "selector"):
            if slot == "app2" and explicit_clone_user(adb_path, serial) != clone_user:
                raise RuntimeError("Xiaohongshu startup retry clone profile changed")
            guard()
            events.append("startup_elements_retry_" + surface + "_ready")
            try:
                root = navigation_capture(adb_path, serial, guard, events)
            except (RuntimeError, subprocess.TimeoutExpired) as error:
                raise RuntimeError("Xiaohongshu startup retry native read failed after " + surface + ": " + str(error)) from error
            guard()
            after = vivo_startup_surface(adb(adb_path, serial, "shell", "dumpsys", "window", timeout=8), expected_user)
            if after != surface:
                raise RuntimeError("Xiaohongshu startup retry surface changed during native read")
            events.append("startup_elements_retry_recovered")
            return root
        if time.monotonic() >= deadline:
            break
        time.sleep(.5)
    raise RuntimeError("Xiaohongshu startup retry foreground remained pending; no additional launch")


def retry_startup_elements(adb_path, serial, slot, clone_user, activity, guard, events):
    """One startup-only recovery after native export failed; no scanning replay."""
    marker = "startup_elements_retry_attempted"
    if ({e.split(":", 1)[1] for e in events if e.startswith("collection_slot_requested:")} != {slot}
            or marker in events or "xhs_cold_started" not in events
            or any(e.startswith("collection_scan_as_of:") for e in events)
            or not re.fullmatch(r"com\.xingin\.xhs/[A-Za-z0-9_.$]+", activity)):
        return None
    guard()
    current = focus(adb_path, serial)
    expected_user = "0" if slot == "app1" else clone_user
    if expected_user not in ("0", "128", "999"):
        return None
    if re.search(r"\bu" + expected_user + r"\s+com\.xingin\.xhs/", current):
        # The app became foreground while the previous export was failing.
        assert_requested_foreground(current, events)
        events.append(marker)
        time.sleep(.8)
        guard()
        assert_requested_foreground(focus(adb_path, serial), events)
        return navigation_capture(adb_path, serial, guard, events)
    if adb(adb_path, serial, "shell", "getprop", "ro.product.manufacturer").strip().upper() != "VIVO":
        return None
    if not vivo_startup_launcher(adb(adb_path, serial, "shell", "dumpsys", "window", timeout=8)):
        return None
    if slot == "app2" and explicit_clone_user(adb_path, serial) != clone_user:
        raise RuntimeError("Xiaohongshu startup retry clone profile changed")
    guard()
    if not vivo_startup_launcher(adb(adb_path, serial, "shell", "dumpsys", "window", timeout=8)):
        raise RuntimeError("Xiaohongshu startup retry foreground changed")
    events.append(marker)
    guard()
    adb(adb_path, serial, "shell", "input", "keyevent", "224", timeout=7)
    time.sleep(.7)
    guard()
    if not vivo_startup_launcher(adb(adb_path, serial, "shell", "dumpsys", "window", timeout=8)):
        raise RuntimeError("Xiaohongshu startup retry foreground changed")
    user_args = (("--user", "0") if slot == "app1" else
                 ("--user", clone_user) if clone_user else ())
    guard()
    adb(adb_path, serial, "shell", "am", "start", "-W", *user_args, "-n", activity, timeout=20)
    return capture_vivo_startup_retry(adb_path, serial, slot, clone_user, guard, events)


def xhs_launch_activity(resolved, events):
    """Never launch an unrelated/resolver component returned by OEM resolution."""
    activities=set(re.findall(r"(?m)^\s*(com\.xingin\.xhs/[\w.$]+)\s*$", resolved))
    if len(activities)>1:
        raise RuntimeError("Xiaohongshu launcher activity is not uniquely proven")
    if activities:
        events.append("xhs_launcher_component:validated_owned_package")
        return next(iter(activities))
    events.append("xhs_launcher_component:fixed_owned_fallback")
    return XHS_PACKAGE+"/.index.v2.IndexActivityV2"


def close_startup_control_center(adb_path, serial, root, current, slot, guard, events):
    """Collapse the observed Vivo control center over our XHS launch once."""
    requested = {e.split(":", 1)[1] for e in events if e.startswith("collection_slot_requested:")}
    if requested != {slot} or slot not in ("app1", "app2") or "xhs_cold_started" not in events:
        return False
    if slot == "app2" and "clone_user_requested:999" not in events:
        return False
    window_pattern = r"mCurrentFocus=Window\{[^\n}]*\bu0 NotificationShade(?:[}\s]|$)"
    if not re.search(window_pattern, current):
        return False
    marker = "startup_control_center_back"
    if marker in events:
        raise ElementListReadError("startup control center recurred after Back")

    def state():
        guard()
        dump = adb(adb_path, serial, "shell", "dumpsys", "window", timeout=8)
        windows = re.findall(r"mCurrentFocus=Window\{[^\n}]+\}", dump)
        owners = re.findall(r"(?m)^\s*mFocusedApp=ActivityRecord\{[^\n]+", dump)
        return windows, owners

    before = state()
    windows = re.findall(r"mCurrentFocus=Window\{[^\n}]+\}", current)
    user = "0" if slot == "app1" else "999"
    target = r"\bu" + user + r" com\.xingin\.xhs/[\w.$]+(?:[}\s]|$)"
    chooser = r"\bu0 com\.android\.intentresolver/(?:com\.android\.intentresolver)?\.DoubleAppResolverActivity(?:[}\s]|$)"
    if (len(windows) != 1 or before[0] != windows or len(before[1]) != 1
            or not (re.search(target, before[1][0]) or re.search(chooser, before[1][0]))):
        return False
    guard()
    nodes = live_nodes(capture(adb_path, serial))
    packages = {"com.android.systemui", "com.vivo.systemuiplugin"}
    required = ("qs_focus_content_container", "vivo_volume_tile_slider", "vivo_brightness_slider_summary")
    if (not nodes or any(n.get("package") not in packages for n in nodes)
            or any(len([n for n in nodes if n.get("resource-id") == "com.vivo.systemuiplugin:id/" + rid
                        and n.get("enabled") == "true"]) != 1 for rid in required)):
        return False
    if state() != before:
        raise ElementListReadError("startup control center changed before Back")
    guard()
    events.append(marker)
    adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
    for _ in range(6):
        time.sleep(.5)
        guard()
        after = focus(adb_path, serial)
        active = re.findall(r"mCurrentFocus=Window\{[^\n}]+\}", after)
        if len(active) == 1 and (re.search(target, active[0]) or re.search(chooser, active[0])):
            return True
        if active and active != windows:
            raise ElementListReadError("startup control center Back opened an unexpected foreground")
    raise ElementListReadError("startup control center stayed open after Back")


def wake_for_startup(adb_path, serial, slot, guard, events):
    """One wake command; an owner already awake and unlocked needs no replay."""
    try:
        adb(adb_path, serial, "shell", "input", "keyevent", "224", timeout=7)
    except subprocess.TimeoutExpired:
        # 141's timed-out wake left display0 lit, unlocked and on the same
        # owner XHS window. Verify that exact completion state, read-only.
        if slot != "app1":
            raise
        guard()
        window = adb(adb_path, serial, "shell", "dumpsys", "window", timeout=8)
        # dumpsys window can prepend a full historical LAST ANR snapshot.
        # The last exact policy header starts the current state, not history.
        window = current_window_dump(window)
        after = window.partition("KeyguardServiceDelegate")[2].partition("KeyguardStateMonitor")[0]
        if (default_display_state(window) != ("true", "true", "true")
                or any(re.findall(r"^\s*" + key + r"=(true|false)\s*$", after, re.MULTILINE) != ["false"]
                       for key in ("showing", "secure", "occluded", "inputRestricted"))):
            raise
        focused = re.findall(r"mCurrentFocus=Window\{[^\n}]+\}", window)
        if len(focused) != 1:
            raise
        target_anr = re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+Application Not Responding: com\.xingin\.xhs(?:[}\s]|$)",focused[0])
        if target_anr:
            # No UI input is repeated. The existing explicit user-0 cold start
            # below will stop only XHS and clear its own unresponsive task.
            events.append("startup_target_anr_window_proven")
        else:
            assert_requested_foreground(focused[0], events)
        guard()
        events.append("startup_wake_completed_after_timeout")


def start_xhs(adb_path, serial, slot, guard, events):
    """Cold-start the app and choose only the caller's explicit clone slot."""
    guard()
    marker = "collection_slot_requested:" + slot
    if marker not in events:events.append(marker)
    wake_for_startup(adb_path, serial, slot, guard, events)
    # Vivo reports the old unlocked state briefly while its screen wakes.
    # Inspect the settled lock before the generic asynchronous dismissal.
    time.sleep(.7)
    dismiss_unsecured_keyguard(adb_path, serial, guard, events)
    adb(adb_path, serial, "shell", "wm", "dismiss-keyguard", timeout=7)
    if f"package:{XHS_PACKAGE}" not in adb(adb_path, serial, "shell", "pm", "list", "packages", XHS_PACKAGE):
        raise RuntimeError("Xiaohongshu is not installed on this phone")
    clone_user = explicit_clone_user(adb_path, serial) if slot == "app2" else None
    # The owner slot is an explicit Android user too. Do not ask an OEM's
    # default-user resolver to choose between the owner and its clone.
    user_args = (("--user", "0") if slot == "app1" else
                 ("--user", clone_user) if clone_user else ())
    resolved = adb(adb_path, serial, "shell", "cmd", "package", "resolve-activity", "--brief", *user_args, XHS_PACKAGE)
    activity = xhs_launch_activity(resolved, events)
    guard()
    adb(adb_path, serial, "shell", "am", "force-stop", *user_args, XHS_PACKAGE, timeout=8)
    events.append("xhs_cold_started")
    guard()
    adb(adb_path, serial, "shell", "am", "start", "-W", *user_args, "-n", activity, timeout=20)
    if clone_user and "clone_user_requested:" + clone_user not in events:
        events.append("clone_user_requested:" + clone_user)
    time.sleep(0.7)
    try:
        root = navigation_capture(adb_path, serial, guard, events)
    except RuntimeError as error:
        if str(error) != "UIAutomator did not return an XML hierarchy":
            raise
        root = retry_startup_elements(adb_path, serial, slot, clone_user, activity, guard, events)
        if root is None:
            raise
    for _ in range(5):
        current = focus(adb_path, serial)
        if close_startup_control_center(adb_path, serial, root, current, slot, guard, events):
            root = navigation_capture(adb_path, serial, guard, events)
            continue
        if any(marker in current for marker in ("com.bbk.updater", "VivoUsbDialog", "UsbDetailsActivity")):
            if recover_known_overlay(adb_path, serial, root, guard, events):
                root = navigation_capture(adb_path, serial, guard, events)
                continue
        if any(marker in current for marker in ("DoubleAppResolverActivity", "com.android.intentresolver",
                                                "ResolverActivity", "HwChooserActivity")):
            if (select_miui_clone(adb_path, serial, root, current, slot, guard, events)
                    or select_oppo_clone(adb_path, serial, root, current, slot, guard, events)
                    or select_honor_owner(adb_path, serial, root, current, slot, guard, events)):
                return navigation_capture(adb_path, serial, guard, events)
            labels = ("小红书",) if slot == "app1" else ("Ⅱ·小红书", "II·小红书", "II ·小红书", "Ⅱ ·小红书")
            for value in labels:
                if label(root, value):
                    tap_label(adb_path, serial, root, value, guard)
                    events.append("clone_slot_selected:" + slot)
                    return navigation_capture(adb_path, serial, guard, events)
            if recover_known_overlay(adb_path, serial, root, guard, events):
                root = navigation_capture(adb_path, serial, guard, events)
                continue
            time.sleep(0.5)
            root = navigation_capture(adb_path, serial, guard, events)
            continue
        if slot == "app2" and not clone_user:
            raise RuntimeError("Xiaohongshu clone slot could not be proven")
        return root
    raise RuntimeError("Xiaohongshu clone slot could not be proven")


def close_notification_card(adb_path, serial, root, current, guard, events, read_guard):
    """Only the observed XHS message card's unique native close image."""
    if not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu\d+\s+com\.xingin\.xhs/(?:com\.xingin\.authorization\.NotificationAuthorizationTranslucentActivity|\.authorization\.NotificationAuthorizationTranslucentActivity)[}\s]", current):
        return False
    assert_requested_foreground(current, events)
    nodes = live_nodes(root)
    parents = {child: parent for parent in root.iter() for child in parent}
    copy = "打开通知，有热门笔记和互动消息第一时间通知你"
    if not all(len([n for n in nodes if n.get("package") == XHS_PACKAGE and n.get("text") == text]) == 1
               for text in ("消息提醒", copy, "确认")):
        return False
    candidates = []
    for n in nodes:
        panel = parents.get(n)
        if (n.get("package") != XHS_PACKAGE or n.get("class") != "android.widget.ImageView"
                or n.get("resource-id") != XHS_PACKAGE + ":id/0_resource_name_obfuscated"
                or n.get("clickable") != "true" or n.get("enabled") != "true"
                or panel is None or panel.get("class") != "android.widget.FrameLayout"
                or panel.get("package") != XHS_PACKAGE or not bounds(panel)):
            continue
        x1,y1,x2,y2 = bounds(n);a,b,c,d = bounds(panel)
        if (a <= x1 < x2 <= c and b <= y1 < y2 <= b+(d-b)*.15
                and x1 >= a+(c-a)*.8 and x2-x1 <= (c-a)*.15
                and all(label(panel, text) for text in ("消息提醒", copy, "确认"))):
            candidates.append(n)
    if len(candidates) != 1:
        raise ElementListReadError("notification card close element is not uniquely proven")
    marker = "notification_card_close_selected"
    if marker in events:
        raise ElementListReadError("notification card recurred after native close")
    guard()
    if focus(adb_path, serial) != current:
        raise ElementListReadError("notification card foreground changed before close")
    x1,y1,x2,y2 = bounds(candidates[0])
    events.append(marker)
    adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
    for _ in range(8):
        read_guard();time.sleep(.4)
        fresh = navigation_capture(adb_path, serial, read_guard, events)
        assert_requested_foreground(focus(adb_path, serial), events)
        if not label(fresh, copy):
            return True
    raise ElementListReadError("notification card remained after native close")


def recover_known_overlay(adb_path, serial, root, guard, events, read_guard=None):
    """Use only exact, previously evidenced QR/publish dismissal paths."""
    read_guard = read_guard or guard
    current = focus(adb_path, serial)
    nodes = list(root.iter("node"))
    parents = {child: parent for parent in root.iter() for child in parent}
    values = [(node.get("text") or "").strip() for node in nodes]

    # 141's observed MIUI ANR dialog: allow one non-destructive wait for
    # this exact XHS user. Never press aerr_close or repeat a failed action.
    anr = re.search(r"mCurrentFocus=Window\{[^\n}]*\bu(\d+)\s+Application Not Responding: com\.xingin\.xhs[}\s]", current)
    if anr and label(root, "小红书没有响应"):
        slots = {e.split(":", 1)[1] for e in events if e.startswith("collection_slot_requested:")}
        users = {e.split(":", 1)[1] for e in events if e.startswith("clone_user_requested:")}
        expected = "0" if slots == {"app1"} else next(iter(users)) if slots == {"app2"} and len(users) == 1 else None
        if expected != anr.group(1):
            raise RuntimeError("XHS ANR dialog user does not match the requested slot")
        if "xhs_anr_wait_selected" in events:
            raise RuntimeError("XHS remains unresponsive after one wait; collection stopped")
        live = live_nodes(root)
        titles = [n for n in live if n.get("resource-id") == "miui:id/alertTitle" and n.get("text") == "小红书没有响应"]
        waits = [n for n in live if n.get("resource-id") == "android:id/aerr_wait" and n.get("text") == "等待"
                 and n.get("class") == "android.widget.Button" and n.get("clickable") == "true" and n.get("enabled") == "true"]
        closes = [n for n in live if n.get("resource-id") == "android:id/aerr_close" and n.get("text") == "确定"]
        if (len(titles) != 1 or len(waits) != 1 or len(closes) != 1
                or any(n.get("package") != "android" for n in live)
                or parents.get(waits[0]) is None or parents.get(waits[0]) is not parents.get(closes[0])):
            raise RuntimeError("XHS ANR wait element is not uniquely proven")
        guard()
        if focus(adb_path, serial) != current:
            raise RuntimeError("XHS ANR foreground changed before wait")
        events.append("xhs_anr_wait_selected")
        x1, y1, x2, y2 = bounds(waits[0])
        adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
        time.sleep(1)
        assert_requested_foreground(focus(adb_path, serial), events)
        return True

    def press_back():
        guard()
        adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
        time.sleep(0.4)

    honor_push = "com.hihonor.android.pushagent"
    honor_title = "是否允许“小红书”发送通知？"
    honor_focus = r"mCurrentFocus=Window\{[^\n}]*\bu0\s+com\.hihonor\.android\.pushagent/com\.hihonor\.android\.pushagent\.activity\.NotificationDialogForOverMagic6Activity(?:[}\s]|$)"
    if re.search(honor_focus, current) and label(root, honor_title):
        def decline(tree):
            nodes = live_nodes(tree)
            def exact(rid, text, cls):
                return [n for n in nodes if n.get("package") == honor_push and n.get("resource-id") == rid
                        and n.get("text") == text and n.get("class") == cls and n.get("enabled") == "true"]
            titles = exact(honor_push+":id/tvTitle", honor_title, "android.widget.TextView")
            messages = exact("android:id/message", "通知可能包括锁屏、铃声等。可前往“设置”中更改。", "android.widget.TextView")
            deny = exact("android:id/button2", "禁止", "android.widget.Button")
            allow = exact("android:id/button1", "允许", "android.widget.Button")
            parents_ = {child: parent for parent in tree.iter() for child in parent}
            if (len(titles) != 1 or len(messages) != 1 or len(deny) != 1 or len(allow) != 1
                    or any(n.get("package") != honor_push for n in nodes)
                    or deny[0].get("clickable") != "true" or allow[0].get("clickable") != "true"
                    or parents_.get(deny[0]) is None or parents_.get(deny[0]) is not parents_.get(allow[0])):
                raise ElementListReadError("Honor notification decline elements are unproven")
            return deny[0]
        target = decline(root)
        if any(e in events for e in ("honor_notification_back", "honor_notification_denied")):
            raise ElementListReadError("Honor notification repeated after bounded recovery")
        guard()
        if not re.search(honor_focus, focus(adb_path, serial)):
            raise ElementListReadError("Honor notification foreground changed before decline")
        x1, y1, x2, y2 = bounds(target)
        adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
        time.sleep(.4)
        after = navigation_capture(adb_path, serial, read_guard, events)
        if label(after, honor_title):
            raise ElementListReadError("Honor notification remained after decline")
        assert_requested_foreground(focus(adb_path, serial), events)
        events.append("honor_notification_denied")
        return True

    if ("NotificationAuthorizationTranslucentActivity" in current or
            ("com.vivo.pushservice" in current and "type=2038" in current)):
        if "creator_late_notification_retry" in events:
            raise ElementListReadError("notification overlay recurred after bounded navigation recovery")
        if close_notification_card(adb_path, serial, root, current, guard, events, read_guard):
            return True
        press_back()
        for _ in range(8):
            read_guard()
            if "NotificationAuthorizationTranslucentActivity" not in focus(adb_path, serial):
                break
            time.sleep(.4)
        else:
            raise RuntimeError("notification overlay stayed open after Back")
        events.append("notification_prompt_back")
        return True

    vivo_title = "确定允许“小红书”发送通知吗？"
    if (re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+com\.vivo\.pushservice[}\s]", current)
            and any(n.get("package") == "com.vivo.pushservice" for n in label(root, vivo_title))):
        declines = [n for n in live_nodes(root) if n.get("package") == "com.vivo.pushservice"
                    and n.get("resource-id") == "android:id/button2"
                    and n.get("class") == "android.widget.Button" and n.get("clickable") == "true"
                    and n.get("enabled") == "true"
                    and any(c.get("text") == "取消" for c in n.iter("node"))]
        if len(declines) != 1:
            raise RuntimeError("Vivo notification safe cancel action is not proven")
        guard()
        box = bounds(declines[0])
        adb(adb_path, serial, "shell", "input", "tap", str((box[0]+box[2])//2), str((box[1]+box[3])//2), timeout=7)
        time.sleep(.5)
        if label(navigation_capture(adb_path, serial, guard, events), vivo_title):
            raise RuntimeError("Vivo notification prompt stayed open after cancelling")
        events.append("vivo_notification_cancelled")
        return True

    notification_copy = "打开通知，有热门笔记和互动消息第一时间通知你"
    prompts = [n for n in label(root, notification_copy) if n.get("package") == XHS_PACKAGE]
    if (len(prompts) == 1 and re.search(r"com\.xingin\.xhs/com\.xingin\.xhs\.index\.v2\.IndexActivityV2(?:[}\s]|$)", current)):
        body = parents.get(prompts[0])
        panel = parents.get(body) if body is not None else None
        children = list(panel) if panel is not None else []
        contents = list(body) if body is not None else []
        if (len(children) != 2 or len(contents) != 3 or children[0] is not body
                or contents[1] is not prompts[0] or contents[2].get("text") != "确认"
                or any(n.get("package") != XHS_PACKAGE for n in children + contents)):
            raise RuntimeError("index notification close layout is not proven")
        close = children[1]
        box, panel_box = bounds(close), bounds(panel)
        if (close not in live_nodes(root) or panel not in live_nodes(root)
                or close.get("class") != "android.widget.ImageView"
                or close.get("resource-id") != XHS_PACKAGE + ":id/0_resource_name_obfuscated"
                or close.get("clickable") != "true" or close.get("enabled") != "true"
                or box[2] != panel_box[2] or box[1] != panel_box[1]
                or box[0] < panel_box[0] + (panel_box[2]-panel_box[0]) * .75):
            raise RuntimeError("index notification close element is not proven")
        guard()
        adb(adb_path, serial, "shell", "input", "tap", str((box[0]+box[2])//2), str((box[1]+box[3])//2), timeout=7)
        time.sleep(.5)
        if label(navigation_capture(adb_path, serial, guard, events), notification_copy):
            raise RuntimeError("index notification stayed open after close")
        events.append("index_notification_close_selected")
        return True

    permission_package = "com.android.permissioncontroller"
    notification_title = "“Ⅱ·小红书”请求向您发送通知"
    if (re.search(r"\bu999\s+com\.android\.permissioncontroller/com\.android\.permissioncontroller\.permission\.ui\.GrantPermissionsActivity(?:[}\s]|$)", current)
            and any(n.get("package") == permission_package and n.get("resource-id") == permission_package + ":id/permission_message"
                    and n.get("text") == notification_title for n in live_nodes(root))):
        press_back()
        refreshed = navigation_capture(adb_path, serial, guard, events)
        if not label(refreshed, notification_title):
            events.append("vivo_clone_notification_back")
            return True
        buttons = [n for n in live_nodes(refreshed) if n.get("package") == permission_package
                   and n.get("resource-id") == permission_package + ":id/permission_deny_and_dont_ask_again_button"
                   and n.get("text") == "禁止且不再询问" and n.get("class") == "android.widget.Button"
                   and n.get("clickable") == "true" and n.get("enabled") == "true"]
        if len(buttons) != 1 or not re.search(r"\bu999\s+com\.android\.permissioncontroller/", focus(adb_path, serial)):
            raise RuntimeError("Vivo clone notification safe decline action not proven")
        x1, y1, x2, y2 = bounds(buttons[0])
        guard()
        adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
        time.sleep(0.4)
        if label(navigation_capture(adb_path, serial, guard, events), notification_title):
            raise RuntimeError("Vivo clone notification prompt stayed open after declining")
        events.append("vivo_clone_notification_denied")
        return True

    if (re.search(r"\bcom\.oplus\.notificationmanager(?:[}/\s]|$)", current)
            and any(node.get("package") == "com.oplus.notificationmanager"
                    and (node.get("text") or "").strip() == "允许“小红书”发送通知吗？"
                    for node in live_nodes(root))):
        press_back()
        refreshed = navigation_capture(adb_path, serial, guard, events)
        if any(node.get("package") == "com.oplus.notificationmanager"
               and (node.get("text") or "").strip() == "允许“小红书”发送通知吗？"
               for node in live_nodes(refreshed)):
            # These fleet dialogs ignore Back; decline only the observed XHS request.
            buttons = [node for node in live_nodes(refreshed)
                       if node.get("package") == "com.oplus.notificationmanager"
                       and node.get("resource-id") == "android:id/button2"
                       and node.get("class") == "android.widget.Button"
                       and (node.get("text") or "").strip() == "拒绝"
                       and node.get("clickable") == "true" and node.get("enabled") == "true"]
            if (not re.search(r"\bcom\.oplus\.notificationmanager(?:[}/\s]|$)", focus(adb_path, serial))
                    or len(buttons) != 1):
                raise RuntimeError("OPPO notification safe decline action not proven")
            x1, y1, x2, y2 = bounds(buttons[0])
            guard()
            adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
            time.sleep(0.4)
            closed = navigation_capture(adb_path, serial, guard, events)
            if any(node.get("package") == "com.oplus.notificationmanager"
                   and (node.get("text") or "").strip() == "允许“小红书”发送通知吗？"
                   for node in live_nodes(closed)):
                raise RuntimeError("OPPO notification prompt stayed open after declining")
            events.append("oppo_notification_prompt_denied")
            return True
        events.append("oppo_notification_prompt_back")
        return True

    heytap_package = "com.heytap.mcs"
    heytap_title = "允许“小红书”向你发送消息？"
    if (re.search(r"\bcom\.heytap\.mcs/com\.heytap\.mcs\.addition\.notifi\.NotifiPermissionActivity(?:[}\s]|$)", current)
            and any(node.get("package") == heytap_package and node.get("text") == heytap_title
                    and node.get("resource-id") == heytap_package + ":id/notification_permission_txt_title"
                    for node in live_nodes(root))):
        press_back()
        refreshed = navigation_capture(adb_path, serial, guard, events)
        if not any(node.get("package") == heytap_package and node.get("text") == heytap_title for node in live_nodes(refreshed)):
            events.append("heytap_notification_prompt_back")
            return True
        buttons = [node for node in live_nodes(refreshed) if node.get("package") == heytap_package
                   and node.get("resource-id") == heytap_package + ":id/notification_permission_btn_close"
                   and node.get("text") == "禁止" and node.get("clickable") == "true" and node.get("enabled") == "true"]
        if len(buttons) != 1 or "com.heytap.mcs/com.heytap.mcs.addition.notifi.NotifiPermissionActivity" not in focus(adb_path, serial):
            raise RuntimeError("HeyTap notification safe decline action not proven")
        x1, y1, x2, y2 = bounds(buttons[0])
        guard()
        adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
        time.sleep(0.4)
        closed = navigation_capture(adb_path, serial, guard, events)
        if any(node.get("package") == heytap_package and node.get("text") == heytap_title for node in live_nodes(closed)):
            raise RuntimeError("HeyTap notification prompt stayed open after declining")
        events.append("heytap_notification_prompt_denied")
        return True

    if (re.search(r"com\.xingin\.xhs/com\.xingin\.update\.UpdateDialogActivity(?:[}\s]|$)", current)
            and label(root, "免流量升级") and label(root, "立即安装")):
        later = [node for node in label(root, "稍后再说") if node.get("package") == XHS_PACKAGE
                 and node.get("class") == "android.widget.Button" and node.get("clickable") == "true"
                 and node.get("enabled") == "true"]
        if len(later) != 1:
            raise RuntimeError("Xiaohongshu update safe defer action not proven")
        tap_label(adb_path, serial, root, "稍后再说", guard)
        if "UpdateDialogActivity" in focus(adb_path, serial):
            raise RuntimeError("Xiaohongshu update stayed open after defer")
        events.append("xhs_update_deferred")
        return True

    if "com.bbk.updater" in current or any(node.get("package") == "com.bbk.updater" for node in nodes):
        if label(root, "智慧升级"):
            smart = [n for n in live_nodes(root) if n.get("package") == "com.bbk.updater"
                     and n.get("resource-id") == "com.bbk.updater:id/alertTitle" and n.get("text") == "智慧升级"]
            body = [n for n in live_nodes(root) if n.get("package") == "com.bbk.updater"
                    and n.get("resource-id") == "com.bbk.updater:id/message_main"
                    and n.get("text") == "建议开启智慧升级。开启后，将通过 WLAN 自动下载升级包，并在夜间 01:00 - 05:00 设备闲置时自动安装，无需等待和手动操作。"]
            buttons = [n for n in live_nodes(root) if n.get("package") == "com.bbk.updater"
                       and n.get("resource-id") == "android:id/button2"
                       and n.get("class") == "android.widget.LinearLayout"
                       and n.get("clickable") == "true" and n.get("enabled") == "true"
                       and len([c for c in n if c.get("resource-id") == "com.bbk.updater:id/vbutton_title"
                                and c.get("text") == "取消"]) == 1]
            if ("com.bbk.updater" not in current or len(smart) != 1 or len(body) != 1 or len(buttons) != 1
                    or "vivo_smart_upgrade_cancelled" in events):
                raise ElementListReadError("Vivo smart upgrade safe cancel is not proven")
            guard()
            if focus(adb_path, serial) != current:
                raise ElementListReadError("Vivo smart upgrade foreground changed")
            x1,y1,x2,y2 = bounds(buttons[0]);events.append("vivo_smart_upgrade_cancelled")
            adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
            time.sleep(.5)
            if label(navigation_capture(adb_path, serial, guard, events), "智慧升级"):
                raise ElementListReadError("Vivo smart upgrade remained after cancel")
            return True
        title = [node for node in nodes if node.get("package") == "com.bbk.updater"
                 and (node.get("text") or "").strip() == "系统升级"]
        buttons = []
        for node in nodes:
            if node.get("package") != "com.bbk.updater" or (node.get("text") or "").strip() != "稍后提醒":
                continue
            button = parents.get(node)
            if (button is not None and button.get("package") == "com.bbk.updater"
                    and button.get("resource-id") == "android:id/button2"
                    and button.get("clickable") == "true" and button.get("enabled") == "true"
                    and bounds(button)):
                buttons.append(button)
        if "com.bbk.updater" not in current or len(title) != 1 or len(buttons) != 1:
            raise RuntimeError("Vivo update overlay safe defer action not proven")
        x1, y1, x2, y2 = bounds(buttons[0])
        guard()
        adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
        time.sleep(0.4)
        if "com.bbk.updater" in focus(adb_path, serial):
            refreshed = navigation_capture(adb_path, serial, guard, events)
            if not label(refreshed, "智慧升级"):
                raise RuntimeError("Vivo update overlay stayed open after defer")
        events.append("vivo_update_deferred")
        return True

    honor_package = "com.hihonor.ouc"
    honor_focus = bool(re.search(r"\bcom\.hihonor\.ouc(?:[}/\s]|$)", current))
    def decline_honor_download(snapshot, foreground):
        if not label(snapshot, "开启 WLAN 自动下载"):
            return False
        live = live_nodes(snapshot)
        title = [n for n in live if n.get("package") == honor_package
                 and n.get("resource-id") == "android:id/alertTitle" and n.get("text") == "开启 WLAN 自动下载"]
        message = [n for n in live if n.get("package") == honor_package
                   and n.get("resource-id") == "android:id/message" and n.get("text") == "有软件更新时，自动下载安装包。"]
        cancel = [n for n in live if n.get("package") == honor_package
                  and n.get("resource-id") == "android:id/button3" and n.get("text") == "取消"
                  and n.get("class") == "android.widget.Button" and n.get("clickable") == "true" and n.get("enabled") == "true"]
        enable = [n for n in live if n.get("package") == honor_package
                  and n.get("resource-id") == "android:id/button1" and n.get("text") == "开启"]
        if (not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+com\.hihonor\.ouc(?:[}/\s]|$)", foreground)
                or len(title) != 1 or len(message) != 1 or len(cancel) != 1 or len(enable) != 1
                or any(n.get("package") != honor_package for n in live)
                or "honor_auto_download_cancelled" in events):
            raise ElementListReadError("Honor automatic download cancel element is not uniquely proven")
        guard()
        if focus(adb_path, serial) != foreground:
            raise ElementListReadError("Honor automatic download foreground changed before cancel")
        x1,y1,x2,y2 = bounds(cancel[0])
        adb(adb_path,serial,"shell","input","tap",str((x1+x2)//2),str((y1+y2)//2),timeout=7)
        time.sleep(.4)
        if label(navigation_capture(adb_path,serial,read_guard,events),"开启 WLAN 自动下载"):
            raise ElementListReadError("Honor automatic download prompt stayed open after cancel")
        events.append("honor_auto_download_cancelled")
        return True
    if honor_focus or any(node.get("package") == honor_package for node in nodes):
        if decline_honor_download(root, current):
            return True
        titles = [node for node in live_nodes(root) if node.get("package") == honor_package
                  and (node.get("text") or "").strip() == "软件更新"]
        installs = [node for node in live_nodes(root) if node.get("package") == honor_package
                    and (node.get("text") or "").strip() == "下载并安装"]
        buttons = [node for node in live_nodes(root) if node.get("package") == honor_package
                   and (node.get("text") or "").strip() == "稍后"
                   and node.get("clickable") == "true" and node.get("enabled") == "true"]
        if not honor_focus or len(titles) != 1 or len(installs) != 1 or len(buttons) != 1:
            raise RuntimeError("Honor update overlay safe defer action not proven")
        x1, y1, x2, y2 = bounds(buttons[0])
        guard()
        adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
        time.sleep(0.4)
        after = focus(adb_path, serial)
        if re.search(r"\bcom\.hihonor\.ouc(?:[}/\s]|$)", after):
            refreshed = navigation_capture(adb_path, serial, read_guard, events)
            if not decline_honor_download(refreshed, after):
                raise RuntimeError("Honor update overlay stayed open after defer")
        events.append("honor_update_deferred")
        return True

    # 176 uses OriginOS framework UI and puts Cancel in a button child.
    # This is only the observed USB mode selector; never authorize debugging.
    usb_package = "com.vivo.frameworkui"
    visible = live_nodes(root)
    if any(n.get("package") == usb_package for n in visible):
        titles = [n for n in visible if n.get("resource-id") == usb_package + ":id/alertTitle"
                  and n.get("text") == "USB 已连接"]
        buttons = [n for n in visible if n.get("resource-id") == "android:id/button2"
                   and n.get("package") == usb_package and n.get("class") == "android.widget.Button"
                   and n.get("content-desc") == "取消" and n.get("clickable") == "true"
                   and n.get("enabled") == "true"
                   and len([c for c in n.iter("node") if c in visible
                            and c.get("resource-id") == usb_package + ":id/vbutton_title"
                            and c.get("text") == "取消"]) == 1]
        panels = [n for n in visible if n.get("resource-id") == usb_package + ":id/parentPanel"]
        values = {(n.get("text") or "").strip() for n in visible if (n.get("text") or "").strip()}
        if (not ("VivoUsbDialog" in current or re.search(r"\bcom\.vivo\.frameworkui[}/\s]", current))
                or any(n.get("package") != usb_package for n in visible)
                or values != {"USB 已连接", "仅充电", "传输照片", "管理文件", "连接车辆", "取消"}
                or len(titles) != 1 or len(buttons) != 1 or len(panels) != 1
                or titles[0] not in panels[0].iter("node") or buttons[0] not in panels[0].iter("node")
                or bounds(buttons[0])[1] <= max(bounds(n)[3] for n in visible if n.get("text") in ("仅充电", "传输照片", "管理文件", "连接车辆"))):
            raise RuntimeError("Vivo USB mode selector safe cancel action not proven")
        x1, y1, x2, y2 = bounds(buttons[0])
        guard()
        adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
        time.sleep(0.4)
        after = navigation_capture(adb_path, serial, guard, events)
        if any(n.get("package") == usb_package for n in live_nodes(after)):
            raise RuntimeError("Vivo USB mode selector stayed open after cancel")
        events.append("vivo_usb_cancelled")
        return True

    if "VivoUsbDialog" in current or any((node.get("text") or "").strip() == "USB 已连接" for node in nodes):
        titles = [node for node in nodes if node.get("package") == "android"
                  and node.get("resource-id") == "android:id/alertTitle"
                  and (node.get("text") or "").strip() == "USB 已连接"]
        buttons = [node for node in nodes if node.get("package") == "android"
                   and node.get("resource-id") == "android:id/button2"
                   and (node.get("text") or "").strip() == "取消"
                   and node.get("clickable") == "true" and node.get("enabled") == "true" and bounds(node)]
        if "VivoUsbDialog" not in current or len(titles) != 1 or len(buttons) != 1:
            raise RuntimeError("Vivo USB overlay safe cancel action not proven")
        x1, y1, x2, y2 = bounds(buttons[0])
        guard()
        adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
        time.sleep(0.4)
        if "VivoUsbDialog" in focus(adb_path, serial):
            raise RuntimeError("Vivo USB overlay stayed open after cancel")
        events.append("vivo_usb_cancelled")
        return True

    # 153/OPPO exposes USB choices in SystemUI, above the clone chooser.
    # Back only dismisses this proven panel; never select a USB mode or grant ADB.
    system_usb_title = [n for n in live_nodes(root)
                        if n.get("package") == "com.android.systemui"
                        and n.get("resource-id") == "com.android.systemui:id/usb_select_title_tv"
                        and n.get("text") == "USB 用于"]
    if system_usb_title:
        live = live_nodes(root)
        choices = [n for n in live if n.get("resource-id") == "com.android.systemui:id/title"]
        expected = {"仅充电", "传输文件 / Android Auto", "传输照片", "USB 网络共享", "MIDI"}
        labels = [" ".join((n.get("text") or "").split()) for n in choices]
        if (len(system_usb_title) != 1 or len(choices) != 5 or set(labels) != expected
                or any(n.get("package") != "com.android.systemui" for n in live)
                or any(n.get("class") != "android.widget.TextView" for n in choices + system_usb_title)
                or not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu\d+\s+com\.android\.systemui[}\s]", current)):
            raise RuntimeError("SystemUI USB mode panel is not uniquely proven")
        if "oppo_systemui_usb_dismissed" in events:
            raise RuntimeError("SystemUI USB mode panel reappeared; collection stopped")
        guard()
        if focus(adb_path, serial) != current:
            raise ElementListReadError("SystemUI USB mode foreground changed before Back")
        adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
        time.sleep(0.4)
        after = navigation_capture(adb_path, serial, guard, events)
        if any(n.get("resource-id") == "com.android.systemui:id/usb_select_title_tv" for n in live_nodes(after)):
            raise RuntimeError("SystemUI USB mode panel stayed open after Back")
        events.append("oppo_systemui_usb_dismissed")
        return True

    huawei_usb_titles = [node for node in live_nodes(root)
                         if node.get("package") == "com.android.settings"
                         and node.get("resource-id") == "android:id/alertTitle"
                         and (node.get("text") or "").strip() == "USB 连接方式"]
    if huawei_usb_titles:
        expected = {"USB 连接方式", "传输照片", "传输文件", "仅充电"}
        buttons = [node for node in live_nodes(root) if node.get("package") == "com.android.settings"
                   and node.get("resource-id") == "android:id/button2"
                   and (node.get("text") or "").strip() == "取消"
                   and node.get("clickable") == "true" and node.get("enabled") == "true"]
        if (not re.search(r"\bcom\.android\.settings(?:[}/\s]|$)", current)
                or not expected.issubset(values) or len(huawei_usb_titles) != 1 or len(buttons) != 1):
            raise RuntimeError("Huawei USB mode overlay safe cancel action not proven")
        x1, y1, x2, y2 = bounds(buttons[0])
        guard()
        adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
        time.sleep(0.4)
        refreshed = navigation_capture(adb_path, serial, guard, events)
        if any(node.get("package") == "com.android.settings"
               and (node.get("text") or "").strip() == "USB 连接方式" for node in live_nodes(refreshed)):
            raise RuntimeError("Huawei USB mode overlay stayed open after cancel")
        events.append("huawei_usb_mode_cancelled")
        return True

    if "com.android.settings/com.android.settings.Settings$UsbDetailsActivity" in current:
        expected = {"USB 用于", "仅限充电", "传输文件", "传输照片"}
        titles = [node for node in nodes if node.get("package") == "com.android.settings"
                  and node.get("resource-id") == "com.android.settings:id/alertTitle"
                  and (node.get("text") or "").strip() == "USB 用于"]
        buttons = [node for node in nodes if node.get("package") == "com.android.settings"
                   and node.get("resource-id") == "android:id/button2"
                   and (node.get("text") or "").strip() == "取消"
                   and node.get("clickable") == "true" and node.get("enabled") == "true" and bounds(node)]
        if not expected.issubset(values) or len(titles) != 1 or len(buttons) != 1:
            raise RuntimeError("Android USB mode overlay safe cancel action not proven")
        x1, y1, x2, y2 = bounds(buttons[0])
        guard()
        adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
        time.sleep(0.4)
        if "UsbDetailsActivity" in focus(adb_path, serial):
            raise RuntimeError("Android USB mode overlay stayed open after cancel")
        events.append("android_usb_mode_cancelled")
        return True

    draft_questions = ("继续编辑图文笔记吗", "继续编辑图文笔记吗?", "继续编辑图文笔记吗？")
    if XHS_PACKAGE in current and any(
        node.get("package") == XHS_PACKAGE and (node.get("text") or "").strip() in draft_questions
        for node in live_nodes(root)
    ):
        buttons = set()
        for node in label(root, "存草稿"):
            if node.get("package") != XHS_PACKAGE or (node.get("text") or "").strip() != "存草稿":
                continue
            button = node
            while button is not None and button.get("clickable") != "true":
                button = parents.get(button)
            if (button is not None and button.get("package") == XHS_PACKAGE
                    and button.get("enabled") == "true" and button in live_nodes(root)):
                buttons.add(button)
        if len(buttons) != 1:
            raise RuntimeError("unfinished draft unique save action not proven")
        x1, y1, x2, y2 = bounds(next(iter(buttons)))
        guard()
        adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
        time.sleep(0.5)
        refreshed = navigation_capture(adb_path, serial, guard, events)
        if any(node.get("package") == XHS_PACKAGE
               and (node.get("text") or "").strip() in draft_questions
               for node in live_nodes(refreshed)):
            raise RuntimeError("unfinished draft prompt stayed open after saving")
        events.append("draft_saved_before_collection")
        return True
    if ("com.xingin.xhs" in current and "解锁成长中心" in values
            and "超多创作者权益等你来看" in values and "立即看看" in values):
        buttons = set()
        for node in label(root, "稍后再看"):
            candidate = node if node.get("clickable") == "true" else parents.get(node)
            if (candidate is not None and candidate in live_nodes(root) and candidate.get("package") == XHS_PACKAGE
                    and candidate.get("clickable") == "true" and candidate.get("enabled") == "true"):
                buttons.add(candidate)
        if len(buttons) != 1:
            raise RuntimeError("growth-center safe defer action not proven")
        x1, y1, x2, y2 = bounds(next(iter(buttons)))
        guard()
        adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
        time.sleep(0.5)
        if label(navigation_capture(adb_path, serial, guard, events), "解锁成长中心"):
            raise RuntimeError("growth-center overlay stayed open after defer")
        events.append("growth_center_deferred")
        return True
    anniversary = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
                   and re.fullmatch(r"嗨👋今天是你加入小红书的\d+周年", n.get("text", ""))]
    if (XHS_PACKAGE in current and len(anniversary) == 1
            and "分享你在小红书遇到的有趣故事吧🎈" in values and "去发布" in values):
        press_back()
        if label(navigation_capture(adb_path, serial, guard, events), anniversary[0].get("text")):
            raise RuntimeError("anniversary sheet stayed open after Back")
        events.append("anniversary_sheet_back")
        return True
    # 140's milestone sheet exposes the publish CTA with zero bounds, while
    # the observed close icon and its exact five-child parent remain visible.
    milestone = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
                 and (n.get("text") == "恭喜你🎉单篇笔记阅读超过1万啦"
                      or re.fullmatch(r"恭喜你🎉累计获得\d+个赞和收藏啦", n.get("text", "")))]
    panel = parents.get(milestone[0]) if len(milestone) == 1 else None
    children = list(panel) if panel is not None else []
    if XHS_PACKAGE in current and len(milestone) == 1 and len(children) == 5:
        subtitle = ("发笔记记录一下此刻吧！✌" if "单篇笔记阅读" in milestone[0].get("text", "")
                    else ("发笔记感谢一下大家的喜爱❤️", "发笔记让更多人看到你的精彩分享 🙌",
                          "分享喜悦，获得更多人的关注💗", "去记录在小红书留下的每一步👣", "发笔记被更多人看见👀"))
        if (children[1] is not milestone[0] or children[2].get("text") not in ((subtitle,) if isinstance(subtitle, str) else subtitle)
                or children[4].get("text") != "去发布"
                or any(n.get("package") != XHS_PACKAGE for n in children)):
            raise RuntimeError("reading milestone close layout is not proven")
        close = children[0]
        box, title_box, panel_box = bounds(close), bounds(milestone[0]), bounds(panel)
        if (close not in live_nodes(root) or panel not in live_nodes(root)
                or close.get("class") != "android.widget.ImageView"
                or close.get("resource-id") != XHS_PACKAGE + ":id/0_resource_name_obfuscated"
                or close.get("clickable") != "true" or close.get("enabled") != "true"
                or box[2] != panel_box[2] or box[1] != panel_box[1]
                or box[0] < panel_box[2] * .85 or box[3] >= title_box[1]):
            raise RuntimeError("reading milestone close element is not proven")
        guard()
        adb(adb_path, serial, "shell", "input", "tap", str((box[0]+box[2])//2), str((box[1]+box[3])//2), timeout=7)
        time.sleep(.5)
        if label(navigation_capture(adb_path, serial, guard, events), milestone[0].get("text")):
            raise RuntimeError("reading milestone stayed open after close")
        events.append("milestone_close_selected")
        return True
    if ("com.xingin.xhs" in current and "去发布" in values
            and sum(value.startswith("恭喜你") for value in values) == 1):
        press_back()
        events.append("celebration_back")
        return True
    if "com.xingin.xhs" in current and any(value in values for value in (
        "搜索我的笔记/收藏/赞过", "搜索我的笔记、收藏或赞过"
    )) and label(root, "取消"):
        tap_label(adb_path, serial, root, "取消", guard)
        events.append("profile_search_cancelled")
        return True
    return False


def creator_list(root):
    require_element_tree(root)
    if label(root, "数据中心") and label(root, "作品分析") and label(root, "全部笔记"):
        return True
    # Some WebViews scroll their header off-screen but retain the same
    # data-center WebView and exact tab/filter fields in its hierarchy.
    views = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
             and n.get("class") == "android.webkit.WebView" and n.get("text") == "数据中心"]
    if len(views) == 1 and all(any(n.get("package") == XHS_PACKAGE
                                     and n.get("class") in ("android.widget.TextView", "android.view.View")
                                     and n.get("text") == value
                                     for n in views[0].iter("node")) for value in ("作品分析", "全部笔记")):
        return True
    # 141 omits the selected tab's label while exposing the actual note rows.
    # Require the unique data-center view, fixed filter/scope, other three tabs,
    # and structured complete rows; an overview/loading shell is insufficient.
    if len(views) != 1:return False
    view = views[0]
    height = bounds(view)[3]
    for value in ("账号概览", "粉丝数据", "收入数据", "全部笔记"):
        matches = [n for n in label(view,value) if n.get("package") == XHS_PACKAGE
                   and bounds(n)[3] < height*.28]
        if len(matches) != 1:return False
    scopes = [n for n in live_nodes(view) if n.get("package") == XHS_PACKAGE
              and n.get("text","").startswith("仅统计") and bounds(n)[3] < height*.28]
    return len(scopes) == 1 and bool(structured_note_cards(view))


def creator_filter_panel(root):
    """Require the filter's observed header/section/close geometry, not note titles."""
    if not creator_list(root):return False
    nodes = live_nodes(root)
    width = max((bounds(n)[2] for n in nodes),default=0)
    height = max((bounds(n)[3] for n in nodes),default=0)
    boxes = []
    for text in ("数据中心","作品分析","全部笔记","笔记类型","发布时间","排序方式","收起"):
        matches = [n for n in label(root,text) if n.get("package") == XHS_PACKAGE
                   and n.get("class") in ("android.widget.TextView","android.view.View")
                   and not any(child is not n and (child.get("text") or "").strip() == text for child in n.iter("node"))]
        if len(matches) != 1:return False
        boxes.append(bounds(matches[0]))
    center,works,all_notes,kind,published,order,close = boxes
    return (width > 0 and center[3] < works[1] < works[3] < all_notes[1] < all_notes[3] < kind[1]
            and kind[3] < published[1] < published[3] < order[1] < order[3] < close[1] < height*.9
            and all(b[0] < width*.25 for b in (all_notes,kind,published,order)) and close[0] > width*.6)


def creator_overview_entry(root):
    return bool(label(root, "创作中心") and label(root, "近 7 日数据")
                and len([n for n in label(root, "观看") if n.get("package") == XHS_PACKAGE
                         and n.get("class") == "android.widget.TextView"]) == 1)


def creator_data_center_button(root):
    """Exact RN header link after data permission activation, not '-' metrics."""
    if not creator_overview_entry(root) or label(root,'开通数据权限'):
        return None
    nodes=live_nodes(root)
    links=[n for n in nodes if n.get('text')=='数据中心' and n.get('class')=='android.widget.TextView']
    if len(links)!=1:return None
    leaf=links[0];parents={child:parent for parent in root.iter() for child in parent}
    parent=leaf
    while parent is not None:
        if parent.get('package')!=XHS_PACKAGE or parent.get('enabled')!='true':return None
        if parent.get('clickable')=='true':break
        parent=parents.get(parent)
    if parent is None or parent not in nodes:return None
    lb,pb=bounds(leaf),bounds(parent)
    if not lb or not pb or not(pb[0]<=lb[0]<lb[2]<=pb[2] and pb[1]<=lb[1]<lb[3]<=pb[3]):return None
    return lb


def creator_overview_metric_placeholder(root):
    parents={child:parent for parent in root.iter() for child in parent}
    placeholder=False
    watching=[n for n in live_nodes(root) if n.get('package')==XHS_PACKAGE
              and n.get('class')=='android.widget.TextView' and n.get('text')=='观看']
    if len(watching)==1:
        parent=parents.get(watching[0])
        while parent is not None and parent.get('package')==XHS_PACKAGE:
            if parent.get('content-desc') in ('观看, -, -','观看，-，-'):
                placeholder=True;break
            parent=parents.get(parent)
    return placeholder


def tap_creator_overview(adb_path,serial,root,guard,events):
    if creator_overview_metric_placeholder(root):
        raise ElementListReadError('Creator Center metric data is unavailable; latest-notes entrance required')
    tap_label(adb_path,serial,root,'观看',guard)


def scroll_creator_home_for_latest(adb_path,serial,root,guard,events,attempt=0):
    """A bounded fallback to the original latest-notes/More entrance."""
    used=sum(e.startswith('creator_home_latest_scroll:') for e in events)
    if attempt not in (0,1) or not label(root,'创作中心') or label(root,'开通数据权限'):
        return False
    scrolls=[n for n in live_nodes(root) if n.get('package')==XHS_PACKAGE
             and n.get('class')=='android.widget.ScrollView' and n.get('content-desc')=='创作中心滚动区'
             and n.get('scrollable')=='true' and n.get('enabled')=='true']
    if len(scrolls)!=1:return False
    x1,y1,x2,y2=bounds(scrolls[0])
    if x2-x1<200 or y2-y1<400:return False
    guard();current=focus(adb_path,serial);assert_requested_foreground(current,events)
    if not re.search(r'com\.xingin\.xhs/com\.xingin\.reactnative\.ui\.XhsReactActivity(?:[}\s]|$)',current):return False
    events.append('creator_home_latest_scroll:'+str(used+1))
    adb(adb_path,serial,'shell','input','swipe',str((x1+x2)//2),str(y1+int((y2-y1)*.8)),
        str((x1+x2)//2),str(y1+int((y2-y1)*.3)),'400',timeout=8)
    time.sleep(.7)
    return True


def creator_more_label(root):
    return next((value for value in ("更多", "更多笔记") if label(root, value)), "")


def allow_warned_creator_data_entry(root, events):
    """A status badge alone is not a data-access denial. Use only a proven existing entry."""
    if not label(root, "账号异常") or not label(root, "创作中心"):
        return False
    value = ("观看" if creator_overview_entry(root) else creator_more_label(root)
             if label(root, "最新笔记") else "")
    if not value:return False
    parents = {child:parent for parent in root.iter() for child in parent}
    actions = set()
    for node in label(root,value):
        if node.get("package") != XHS_PACKAGE or node.get("enabled") != "true":continue
        parent = node
        while parent is not None and parent.get("clickable") != "true":parent=parents.get(parent)
        if (parent is not None and parent.get("package") == XHS_PACKAGE
                and parent.get("enabled") == "true" and parent in live_nodes(root)):
            actions.add(id(parent))
    if len(actions) != 1 and creator_data_center_button(root) is None:return False
    marker="creator_account_status_abnormal_observed"
    if marker not in events:events.append(marker)
    return True


def works_overview_still_open(root, tab_box):
    """Prove the observed account overview survived the timed-out tab tap."""
    if not data_center_tab_header(root):
        return False
    nodes = live_nodes(root)
    if any(n.get("package") != XHS_PACKAGE or n.get("class") in (
            "android.widget.ProgressBar", "android.app.Dialog") for n in nodes):
        return False
    if any(label(root, value) for value in (
            "全部笔记", "开通数据权限", "账号异常", "个人信息保护提示", "服务器出错")):
        return False
    view, = [n for n in nodes if n.get("class") == "android.webkit.WebView" and n.get("text") == "数据中心"]
    tabs = label(view, "作品分析")
    return (len(tabs) == 1 and bounds(tabs[0]) == tab_box
            and tabs[0].get("class") == "android.view.View"
            and all(tabs[0].get(key) == "true" for key in ("enabled", "clickable", "visible-to-user"))
            and all(len(matches := label(view, value)) == 1 and bounds(matches[0])[1] >= tab_box[3]
                    for value in ("账号诊断", "观看数据")))


def open_works_tab(adb_path, serial, root, guard, events, expected_foreground=None, deadline=None):
    """The observed data-center WebView marks its tab label non-clickable."""
    if not (label(root, "数据中心") and label(root, "账号概览") and not label(root, "全部笔记")):
        return False
    if not re.search(r"com\.xingin\.xhs/com\.xingin\.xywebview\.activity\.WebViewActivityV2(?:[}\s]|$)", focus(adb_path, serial)):
        return False
    if expected_foreground is not None and focus(adb_path, serial) != expected_foreground:
        raise ElementListReadError("data-center tab foreground changed")
    parents = {child: parent for parent in root.iter() for child in parent}
    tabs = [n for n in label(root, "作品分析") if n.get("package") == XHS_PACKAGE
            and (n.get("class") == "android.widget.TextView"
                 or (n.get("class") == "android.view.View" and n.get("clickable") == "true"))
            and n.get("enabled") == "true"]
    if len(tabs) != 1:
        raise RuntimeError("data-center works tab is not unique")
    row = parents.get(tabs[0])
    if row is not None and not label(row, "账号概览"):
        row = parents.get(row)
    if row is None or not label(row, "账号概览") or not label(row, "粉丝数据") or not label(row, "收入数据"):
        raise RuntimeError("data-center works tab header is not proven")
    views = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
             and n.get("class") == "android.webkit.WebView" and n.get("text") == "数据中心"]
    row_height = bounds(row)[3] - bounds(row)[1] if bounds(row) else None
    if len(views) == 1 and row is views[0]:
        # 144 exposes the four tab labels directly under the full WebView.
        # Prove the actual header row instead of using the whole page height.
        flat_tabs = []
        for title in ("账号概览", "作品分析", "粉丝数据", "收入数据"):
            matches = [n for n in row if n.get("package") == XHS_PACKAGE
                       and n.get("class") == "android.widget.TextView"
                       and n.get("text") == title and n.get("enabled") == "true"
                       and n in live_nodes(root)]
            if len(matches) != 1:
                raise RuntimeError("flat data-center tab header is not uniquely proven")
            flat_tabs.append(matches[0])
        boxes = [bounds(n) for n in flat_tabs]
        if (flat_tabs[1] is not tabs[0]
                or max(b[1] for b in boxes)-min(b[1] for b in boxes) > 6
                or max(b[3] for b in boxes)-min(b[3] for b in boxes) > 6
                or not all(left[2] < right[0] for left,right in zip(boxes,boxes[1:]))):
            raise RuntimeError("flat data-center tab row geometry is not proven")
        row_height = max(b[3] for b in boxes)-min(b[1] for b in boxes)
    if (len(views) != 1 or not bounds(row) or bounds(tabs[0])[3] > bounds(views[0])[3] * 0.25
            or row_height > bounds(views[0])[3] * 0.20):
        raise RuntimeError("data-center works tab is outside the header")
    x1, y1, x2, y2 = bounds(tabs[0])
    guard()
    if expected_foreground is not None and focus(adb_path, serial) != expected_foreground:
        raise ElementListReadError("data-center tab foreground changed before tap")
    tap = ("shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2))
    try:
        adb(adb_path, serial, *tap, timeout=7)
    except subprocess.TimeoutExpired:
        timeout_marker = "data_center_works_tab_tap_timeout"
        reset_marker = "data_center_works_tab_post_reset_timeout_readback"
        prior_timeout = timeout_marker in events
        reset_readback = (prior_timeout
                          and "data_center_works_tab_ready_after_timeout" in events
                          and "creator_overview_reopened" in events
                          and reset_marker not in events)
        if expected_foreground is None or deadline is None or (prior_timeout and not reset_readback):
            raise
        # 141 completed its first timed-out tap, then the required newest-list
        # reset made another distinct tap. Permit readback once at this reset;
        # never spend another tap retry or infer success from the command error.
        events.append(reset_marker if reset_readback else timeout_marker)
        assert_requested_foreground(expected_foreground, events)
        for _ in range(2):
            guard()
            if time.monotonic() >= deadline or focus(adb_path, serial) != expected_foreground:
                raise
            fresh = native_window_capture(adb_path, serial, expected_foreground, guard, events)
            if focus(adb_path, serial) != expected_foreground:
                raise
            if creator_list(fresh):
                events.append("data_center_works_tab_ready_after_timeout")
                return True
            if not works_overview_still_open(fresh, (x1, y1, x2, y2)):
                raise
        if reset_readback:
            raise
        guard()
        if focus(adb_path, serial) != expected_foreground or deadline - time.monotonic() < 7:
            raise
        events.append("data_center_works_tab_retry_after_timeout")
        adb(adb_path, serial, *tap, timeout=7)
    time.sleep(0.5)
    events.append("data_center_works_tab_selected")
    return True


def xhs_chat_activity(current):
    return bool(re.search(
        r"com\.xingin\.xhs/(?:com\.xingin\.im\.ui\.activity\.ChatActivity|"
        r"\.im\.ui\.activity\.ChatActivity|com\.xingin\.im\.ui\.message\.msgcenter\.MsgCenterActivity|"
        r"com\.xingin\.dot_agent_page\.DotsAgentPageActivity)(?:[}\s]|$)", current))


def close_restored_ai_page(adb_path, serial, root, current, guard, events):
    """The observed AI introduction ignores Back; its close icon has a parent."""
    if (not re.search(r"com\.xingin\.xhs/com\.xingin\.dot_agent_page\.DotsAgentPageActivity(?:[}\s]|$)", current)
            or not label(root, "聊聊新话题") or not any(n.get("package") == XHS_PACKAGE
                and n.get("text") == "内容由AI生成" for n in root.iter("node"))):
        return False
    nodes = live_nodes(root)
    width = max((bounds(n)[2] for n in nodes), default=0)
    height = max((bounds(n)[3] for n in nodes), default=0)
    candidates = []
    for n in nodes:
        if (n.get("package") != XHS_PACKAGE or n.get("class") != "android.widget.LinearLayout"
                or n.get("clickable") != "true" or n.get("enabled") != "true"):
            continue
        box = bounds(n)
        icons = [c for c in n if c.get("package") == XHS_PACKAGE and c.get("class") == "android.widget.ImageView"
                 and c.get("resource-id") == XHS_PACKAGE + ":id/0_resource_name_obfuscated" and c in nodes]
        if (box[0] == 0 and box[2] <= width * 0.20 and box[3] <= height * 0.15
                and len(icons) == 1 and len(list(n)) == 1):
            candidates.append(n)
    if len(candidates) != 1:
        raise RuntimeError("restored AI page close element is not uniquely proven")
    x1, y1, x2, y2 = bounds(candidates[0])
    guard()
    adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
    time.sleep(0.5)
    if "com.xingin.dot_agent_page.DotsAgentPageActivity" in focus(adb_path, serial):
        raise RuntimeError("restored AI page stayed open after close")
    events.append("restored_ai_close_selected")
    return True




def native_index_navigation(action, adb_path, serial, guard, events):
    from xhs_native_navigation import perform
    # An update may appear between the caller's tree and native selection.
    # Retry only a proven pre-action rejection, never an unknown click outcome.
    for attempt in range(2):
        current = focus(adb_path, serial)
        assert_requested_foreground(current, events)
        update = bool(re.search(r"com\.xingin\.xhs/com\.xingin\.update\.UpdateDialogActivity(?:[}\s]|$)", current))
        if update and attempt == 0:
            root = navigation_capture(adb_path, serial, guard, events)
            if not recover_known_overlay(adb_path, serial, root, guard, events):
                raise ElementListReadError("native navigation update dismissal is unproven")
            events.append("native_navigation_update_before_action")
            continue
        if not re.search(r"com\.xingin\.xhs/(?:com\.xingin\.xhs\.index\.v2\.IndexActivityV2|\.index\.v2\.IndexActivityV2)(?:[}\s]|$)", current):
            raise ElementListReadError("native navigation requires the requested XHS index page")
        assert_no_poco(adb_path, serial)
        try:
            perform(action, adb_path, serial, adb_process, lambda: focus(adb_path, serial), guard, current)
        except RuntimeError as error:
            preaction = str(error) in ("native navigation foreground changed before staging",
                "native navigation foreground changed before action",
                "native navigation command failed: native_navigation_unproven:IllegalStateException:own profile menu unproven",
                        "native navigation command failed: native_navigation_unproven:IllegalStateException:profile query is ambiguous")
            preaction = preaction or (action == "profile" and str(error) ==
                "native navigation command failed: native_navigation_unproven:IllegalStateException:missing native child")
            rejected_menu = action == "menu" and str(error) == "native navigation command failed: native_navigation_unproven:IllegalStateException:native action rejected"
            if attempt or not (preaction or rejected_menu):
                raise
            fresh = focus(adb_path, serial)
            assert_requested_foreground(fresh, events)
            if not re.search(r"com\.xingin\.xhs/com\.xingin\.update\.UpdateDialogActivity(?:[}\s]|$)", fresh):
                raise
            root = navigation_capture(adb_path, serial, guard, events)
            if not recover_known_overlay(adb_path, serial, root, guard, events):
                raise
            if rejected_menu:
                # A rejected action may have taken effect. Before a new menu
                # action prove it has NOT opened the drawer and that the exact
                # own-profile precondition is back, using fresh native nodes.
                after = navigation_capture(adb_path, serial, guard, events)
                assert_requested_foreground(focus(adb_path, serial), events)
                selected = [n for n in live_nodes(after) if n.get("package") == XHS_PACKAGE
                            and n.get("content-desc") == "我" and n.get("selected") == "true"]
                if len(selected) != 1 or not label(after, "菜单") or label(after, "我的草稿") or label(after, "创作者中心"):
                    raise ElementListReadError("native rejected menu postcondition is unproven; action not repeated")
            events.append("native_navigation_update_before_action")
            continue
        events.append("native_accessibility_action:" + action)
        return
    raise ElementListReadError("native navigation update recovery exhausted")


def tap_index_menu(adb_path, serial, root, guard, events):
    # Vivo's live XML menu coordinates opened a different surface (93).
    # Use the exact native node action on the proven own-profile page.
    guard()
    if adb(adb_path, serial, "shell", "getprop", "ro.product.manufacturer", timeout=8).strip().upper() != "VIVO":
        return tap_label(adb_path, serial, root, "菜单", guard)
    native_index_navigation("menu", adb_path, serial, guard, events)
    fresh = navigation_capture(adb_path, serial, guard, events)
    foreground = focus(adb_path, serial)
    assert_requested_foreground(foreground, events)
    # 113 displayed the already-supported update dialog immediately after
    # the native action. Defer it once, then prove the drawer.
    if (re.search(r"com\.xingin\.xhs/com\.xingin\.update\.UpdateDialogActivity(?:[}\s]|$)", foreground)
            and label(fresh, "免流量升级") and label(fresh, "立即安装")
            and recover_known_overlay(adb_path, serial, fresh, guard, events)):
        fresh = navigation_capture(adb_path, serial, guard, events)
        assert_requested_foreground(focus(adb_path, serial), events)
    elif re.search(r"com\.xingin\.xhs/(?:com\.xingin\.authorization\.NotificationAuthorizationTranslucentActivity|"
                   r"\.authorization\.NotificationAuthorizationTranslucentActivity)(?:[}\s]|$)", foreground):
        # 121/app2: the known notification prompt can arrive after the menu
        # action. Close it once; do not replay the menu or accept a hidden drawer.
        def notification_guard():
            guard()
            current = focus(adb_path, serial)
            assert_requested_foreground(current, events)
            if current != foreground:
                raise ElementListReadError("menu notification foreground changed before Back")
        if not recover_known_overlay(adb_path, serial, fresh, notification_guard, events, read_guard=guard):
            raise ElementListReadError("menu notification recovery was not proven")
        fresh = navigation_capture(adb_path, serial, guard, events)
        assert_requested_foreground(focus(adb_path, serial), events)
    if not (label(fresh, "我的草稿") and (label(fresh, "创作者中心") or label(fresh, "创作中心"))):
        raise ElementListReadError("native menu did not expose the Creator Center drawer")


def select_zero_bounds_profile(adb_path, serial, root, current, guard, events):
    """Select only the proven native own-profile node; never infer coordinates."""
    if not re.search(r"com\.xingin\.xhs/com\.xingin\.xhs\.index\.v2\.IndexActivityV2(?:[}\s]|$)", current):
        return None
    if not all(label(root, value) for value in ("关注", "发现", "搜索")):
        return None
    targets = [n for n in root.iter("node") if n.get("package") == XHS_PACKAGE
               and n.get("class") == "android.view.ViewGroup" and n.get("content-desc") == "我"
               and n.get("clickable") == "true" and n.get("enabled") == "true"
               and n.get("selected") == "false" and n.get("bounds") == "[0,0][0,0]"]
    if len(targets) != 1:
        return None
    parents = {child: parent for parent in root.iter() for child in parent}
    row = parents.get(targets[0])
    children = list(row) if row is not None else []
    captions = [n.get("content-desc", "").split("，", 1)[0] for n in children]
    if (captions != ["首页", "市集", "发布", "消息", "我"] or any(n.get("package") != XHS_PACKAGE
            or n.get("clickable") != "true" or n.get("enabled") != "true"
            or n.get("bounds") != "[0,0][0,0]" for n in children)):
        raise RuntimeError("zero-bounds profile footer is not uniquely proven")
    if children[0].get("selected") != "true":
        raise RuntimeError("zero-bounds profile footer is not on the verified home tab")
    guard()
    native_index_navigation("profile", adb_path, serial, guard, events)
    for attempt in range(4):
        fresh = navigation_capture(adb_path, serial, guard, events)
        foreground = focus(adb_path, serial)
        assert_requested_foreground(foreground, events)
        if not re.search(r"com\.xingin\.xhs/(?:com\.xingin\.xhs\.index\.v2\.IndexActivityV2|\.index\.v2\.IndexActivityV2)(?:[}\s]|$)", foreground):
            raise ElementListReadError("native profile readback left the index page")
        if len([n for n in fresh.iter("node") if n.get("package") == XHS_PACKAGE
                and n.get("content-desc") == "我" and n.get("selected") == "true"]) == 1:
            return fresh
        if attempt < 3:
            guard()
            time.sleep(0.5)
    raise ElementListReadError("native profile action did not select the own-profile tab")


def refresh_creator_server_error(adb_path, serial, root, guard, events, attempts):
    current = focus(adb_path, serial)
    if (not re.search(r"com\.xingin\.xhs/com\.xingin\.reactnative\.ui\.XhsReactActivity(?:[}\s]|$)", current)
            or not label(root, "服务器出错")
            or not label(root, "工程薯正在努力抢修，你还可以:")):
        return False
    if attempts >= 1:
        raise RuntimeError("Xiaohongshu Creator Center reported server error after one refresh")
    buttons = [n for n in label(root, "刷新试试") if n.get("package") == XHS_PACKAGE
               and n.get("class") == "android.widget.Button" and n.get("clickable") == "true"
               and n.get("enabled") == "true"]
    if len(buttons) != 1 or not label(root, "返回上一页"):
        raise RuntimeError("Creator Center server-error refresh action is not proven")
    tap_label(adb_path, serial, root, "刷新试试", guard)
    events.append("creator_server_error_refreshed_once")
    return True


def recover_vivo_store_update(adb_path, serial, root, slot, current, guard, events):
    """Dismiss only165's observed Vivo update page and verify the original slot."""
    package = "com.bbk.appstore"
    if ("xhs_cold_started" not in events
            or {e.split(":", 1)[1] for e in events if e.startswith("collection_slot_requested:")} != {slot}
            or not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+com\.bbk\.appstore/com\.bbk\.appstore\.ui\.manage\.ManageUpdateActivity(?:[}\s]|$)", current)):
        return False
    nodes = live_nodes(root)
    title = [n for n in nodes if n.get("package") == package and n.get("text") == "应用更新"
             and n.get("resource-id") == package + ":id/originui_vtoolbar_normal_title_rom14_0"]
    back = [n for n in nodes if n.get("package") == package and n.get("content-desc") == "返回"
            and n.get("resource-id") == package + ":id/originui_vtoolbar_navigation_view_btn_rom14_0"
            and n.get("class") == "android.widget.ImageButton"
            and n.get("clickable") == "true" and n.get("enabled") == "true"]
    if len(title) != 1 or len(back) != 1 or not any(
            n.get("package") == package and n.get("text") == "点击“更新”会下载并安装最新版本" for n in nodes):
        return False
    if "vivo_store_update_back" in events:
        raise RuntimeError("Vivo application update page repeated; collection stopped")
    guard()
    if adb(adb_path, serial, "shell", "getprop", "ro.product.manufacturer").strip().upper() != "VIVO":
        return False
    if focus(adb_path, serial) != current:
        raise RuntimeError("Vivo application update foreground changed")
    guard()
    adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
    time.sleep(.5)
    assert_requested_foreground(focus(adb_path, serial), events)
    events.append("vivo_store_update_back")
    return True


def resume_vivo_update_entry(adb_path, serial, current, guard, events):
    """Only a known OEM update surface before a scan; never install or scan over it."""
    slots = {e.split(":", 1)[1] for e in events if e.startswith("collection_slot_requested:")}
    if ("xhs_cold_started" not in events or len(slots) != 1
            or any(e.startswith("collection_scan_as_of:") for e in events)
            or not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+com\.bbk\.appstore/com\.bbk\.appstore\.ui\.manage\.ManageUpdateActivity(?:[}\s]|$)", current)):
        return None
    guard()
    fresh = capture(adb_path, serial)  # Stock XML for this exact foreign activity.
    if focus(adb_path, serial) != current:
        raise ElementListReadError("Vivo update surface changed during fresh element read")
    if not recover_vivo_store_update(adb_path, serial, fresh, next(iter(slots)), current, guard, events):
        return None
    root = navigation_capture(adb_path, serial, guard, events)
    assert_requested_foreground(focus(adb_path, serial), events)
    events.append("vivo_store_update_entry_resumed")
    return root


def recover_vivo_store_detail(adb_path, serial, root, slot, current, guard, events):
    """Leave the observed startup advertisement's store page; never install."""
    package = "com.bbk.appstore"
    if ("xhs_cold_started" not in events
            or {e.split(":", 1)[1] for e in events if e.startswith("collection_slot_requested:")} != {slot}
            or not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+com\.bbk\.appstore/com\.bbk\.appstore\.ui\.details\.AppDetailActivity(?:[}\s]|$)", current)):
        return False
    nodes = live_nodes(root)
    exact = lambda key, text: [n for n in nodes if n.get("package") == package
                               and n.get("resource-id") == package+":id/"+key and n.get("text") == text]
    backs = [n for n in nodes if n.get("package") == package
             and n.get("resource-id") == package+":id/originui_vtoolbar_navigation_view_btn_rom14_0"
             and n.get("content-desc") == "返回" and n.get("class") == "android.widget.ImageButton"
             and n.get("enabled") == "true" and n.get("clickable") == "true"]
    if len(exact("package_detail_title", "丰巢")) != 1 or len(backs) != 1:
        return False
    if "vivo_store_detail_back" in events:
        raise ElementListReadError("Vivo startup store redirect repeated")
    guard()
    if adb(adb_path, serial, "shell", "getprop", "ro.product.manufacturer").strip().upper() != "VIVO":
        return False
    guard()
    if focus(adb_path, serial) != current:
        raise ElementListReadError("Vivo startup store foreground changed")
    adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
    time.sleep(.5)
    assert_requested_foreground(focus(adb_path, serial), events)
    events.append("vivo_store_detail_back")
    return True


def recover_vivo_browser_permission_redirect(adb_path,serial,root,slot,current,guard,events):
    """Leave the observed browser permission surface; never press its buttons."""
    package="com.android.permissioncontroller"
    if ("xhs_cold_started" not in events or {e.split(":",1)[1] for e in events if e.startswith("collection_slot_requested:")}!={slot}
            or not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+com\.android\.permissioncontroller/com\.android\.permissioncontroller\.permission\.ui\.GrantPermissionsActivity[}\s]",current)):
        return False
    requested={e.split(":",1)[1] for e in events if e.startswith("clone_user_requested:")}
    user="0" if slot=="app1" and requested<={"0"} else "999" if slot=="app2" and requested=={"999"} else None
    if user is None:return False
    nodes=live_nodes(root)
    expected={"permission_message":"“浏览器”请求访问您的位置信息",
              "detail_message":"用于天气、资讯功能，同时部分第三方网页（如导航网站）可能会获取位置信息，第三方网页获取位置信息时，会再次征求您的同意。",
              "permission_allow_foreground_only_button":"使用应用时允许",
              "permission_allow_one_time_button":"本次使用时允许","permission_deny_button":"禁止"}
    if any(len([n for n in nodes if n.get("package")==package and n.get("resource-id")==package+":id/"+key
                and n.get("text")==text and n.get("enabled")=="true"])!=1 for key,text in expected.items()):return False
    if "vivo_browser_permission_reopened" in events:raise RuntimeError("browser permission redirect repeated; collection stopped")
    guard()
    if adb(adb_path,serial,"shell","getprop","ro.product.manufacturer").strip().upper()!="VIVO":return False
    guard()
    if focus(adb_path,serial)!=current:raise RuntimeError("browser permission foreground changed")
    adb(adb_path,serial,"shell","input","keyevent","3",timeout=7)
    time.sleep(.4)
    if focus(adb_path,serial)==current:raise RuntimeError("browser permission stayed foreground after Home")
    guard();events.append("vivo_browser_permission_reopened")
    adb(adb_path,serial,"shell","am","start","-W","--user",user,"-n",XHS_PACKAGE+"/.index.v2.IndexActivityV2",timeout=20)
    time.sleep(.7);assert_requested_foreground(focus(adb_path,serial),events)
    return True


def recover_vivo_browser_redirect(adb_path, serial, slot, current, guard, events, root=None):
    # 43's owner app cold-start was followed by a Vivo browser activity. Leave
    # that page intact and attempt the known XHS owner activity exactly once.
    browser_activity = re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+com\.vivo\.browser/com\.vivo\.browser\.BrowserActivity[}\s]", current)
    welcome = False
    if root is not None and re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+com\.vivo\.browser/[\w.$]+[}\s]", current):
        nodes = live_nodes(root)
        def exact(field, text):
            return len([n for n in nodes if n.get("package") == "com.vivo.browser"
                        and n.get("resource-id") == "com.vivo.browser:id/" + field
                        and n.get("text") == text and n.get("class") == "android.widget.TextView"]) == 1
        welcome = (all(n.get("package") == "com.vivo.browser" for n in nodes)
                   and exact("alertTitle", "欢迎使用 vivo 浏览器")
                   and exact("vbutton_title", "同意") and exact("vbutton_title", "不同意")
                   and len([n for n in nodes if n.get("resource-id") == "com.vivo.browser:id/privacyState"
                            and n.get("text", "").startswith("感谢您信任并使用vivo浏览器，本应用将在获得您的明确授权后，")]) == 1)
    if (slot != "app1" or "collection_slot_requested:app1" not in events or "xhs_cold_started" not in events
            or not (browser_activity or welcome)):
        return False
    if welcome and focus(adb_path, serial) != current:
        raise RuntimeError("browser first-use foreground changed")
    if "vivo_browser_redirect_reopened" in events:
        raise RuntimeError("Xiaohongshu redirected to Vivo browser again; collection stopped")
    guard()
    adb(adb_path,serial,"shell","input","keyevent","3",timeout=7)
    guard()
    events.append("vivo_browser_redirect_reopened")
    adb(adb_path,serial,"shell","am","start","-W","--user","0","-n",XHS_PACKAGE+"/.index.v2.IndexActivityV2",timeout=20)
    time.sleep(.7)
    restored = focus(adb_path,serial)
    if re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+com\.android\.intentresolver/com\.android\.intentresolver\.DoubleAppResolverActivity[}\s]",restored):
        # 43 returns to the existing Vivo chooser after this explicit owner
        # relaunch. Recapture it and let the normal element-based selector run.
        if "clone_user_requested:0" not in events:events.append("clone_user_requested:0")
        events.append("vivo_browser_redirect_returned_to_resolver")
        return True
    if not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+com\.xingin\.xhs/",restored):
        raise RuntimeError("Xiaohongshu owner foreground was not restored after browser redirect")
    return True


def blank_works_loading(root):
    """An empty content-sized WebView, with or without its central spinner."""
    nodes = live_nodes(root)
    if not nodes or any(n.get("package") != XHS_PACKAGE or n.get("text", "").strip()
                        or n.get("content-desc", "").strip() for n in nodes):
        return False
    width = max(bounds(n)[2] for n in nodes)
    height = max(bounds(n)[3] for n in nodes)
    content = [n for n in nodes if n.get("resource-id") == "android:id/content"
               and n.get("class") == "android.widget.FrameLayout" and n.get("enabled") == "true"]
    if len(content) > 1:
        return False
    if content:
        area = bounds(content[0])
        if not area or area[0:3] != (0, 0, width) or not 0 < area[3] <= height:
            return False
        height = area[3]
    views = [n for n in nodes if n.get("class") == "android.webkit.WebView"
             and n.get("enabled") == "true" and bounds(n) == (0, 0, width, height)
             and not list(n)]
    spinners = [bounds(n) for n in nodes if n.get("class") == "android.widget.ImageView"
                and n.get("clickable") == "false" and n.get("enabled") == "true"]
    if len(views) != 1 or len(spinners) > 1:return False
    if not spinners:
        containers = {"android.widget.FrameLayout", "android.widget.LinearLayout",
                      "android.view.ViewGroup", "android.webkit.WebView", "android.view.View"}
        return bool(content) and all(n.get("class") in containers for n in nodes)
    x1,y1,x2,y2 = spinners[0]
    return (width*.05 <= x2-x1 <= width*.12 and height*.02 <= y2-y1 <= height*.08
            and width*.45 <= (x1+x2)/2 <= width*.55
            and height*.45 <= (y1+y2)/2 <= height*.58)


def reopen_blank_more(adb_path, serial, root, guard, events):
    """Leave the proven stalled More route once and use the existing overview."""
    if not blank_works_loading(root):raise RuntimeError("stalled works loading layout is not proven")
    current = focus(adb_path, serial)
    assert_requested_foreground(current, events)
    if not works_webview_activity(current):raise RuntimeError("stalled works WebView foreground is not proven")
    guard()
    if focus(adb_path, serial) != current:raise RuntimeError("stalled works foreground changed")
    adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
    time.sleep(.5)
    center = navigation_capture(adb_path, serial, guard, events)
    if not (creator_overview_entry(center) and label(center, "最新笔记") and creator_more_label(center)):
        raise RuntimeError("stalled works page could not return to proven Creator Center")
    assert_requested_foreground(focus(adb_path, serial), events)
    tap_label(adb_path, serial, center, "观看", guard)
    events.append("works_blank_more_reopened_via_overview")
    return navigation_capture(adb_path, serial, guard, events)


def recover_inaccessible_more(adb_path, serial, current, guard, events):
    """One pre-scan retry through the proven overview when More loses nodes."""
    if data_center_reopen_count(events) >= DATA_CENTER_MAX_REOPENS:
        raise ElementListReadError("data-center loading retry budget exhausted")
    guard()
    if not works_webview_activity(current) or focus(adb_path, serial) != current:
        raise ElementListReadError("inaccessible works foreground changed")
    events.append("works_native_more_recovery_attempted")
    adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
    center = capture(adb_path, serial)
    assert_requested_foreground(focus(adb_path, serial), events)
    require_creator_service_available(center)
    if label(center, "账号异常") and not allow_warned_creator_data_entry(center, events):
        raise RuntimeError("creator account shows abnormal status; collection skipped")
    if not (label(center, "创作中心") and label(center, "最新笔记")
            and creator_more_label(center) and creator_overview_entry(center)):
        raise ElementListReadError("inaccessible More did not return to proven Creator Center")
    tap_label(adb_path, serial, center, "观看", guard)
    overview = navigation_capture(adb_path, serial, guard, events)
    root = wait_data_center_loading(adb_path, serial, overview, guard, events)
    events.append("works_native_more_reopened_via_overview")
    return root


def require_creator_service_available(root):
    # 132/app2: a complete error page, not an empty note list. The user asks
    # to skip server errors; do not press either offered navigation action.
    if (not creator_list(root)
            and label(root, "工程薯正在努力抢修，你还可以:")
            and label(root, "返回上一页") and label(root, "刷新试试")
            and all(n.get("package") == XHS_PACKAGE for n in live_nodes(root))):
        raise RuntimeError("Creator Center service is unavailable; collection skipped")


def blank_creator_center_loading(root, current):
    """Observed RN skeleton, not a permission/login page or an empty post list."""
    require_element_tree(root)
    if not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu\d+\s+com\.xingin\.xhs/com\.xingin\.reactnative\.ui\.XhsReactActivity(?:[}\s]|$)", current):
        return False
    nodes=live_nodes(root)
    words={n.get(k,'').strip() for n in nodes for k in ('text','content-desc') if n.get(k,'').strip()}
    return (bool(nodes) and all(n.get('package')==XHS_PACKAGE for n in nodes)
            and words=={'创作中心','创作中心滚动区'}
            and len([n for n in nodes if n.get('content-desc')=='创作中心'
                     and n.get('class')=='android.view.ViewGroup'])==1
            and len([n for n in nodes if n.get('content-desc')=='创作中心滚动区'
                     and n.get('class')=='android.widget.ScrollView'])==1)


def wait_creator_center_loading(adb_path, serial, root, guard, events, budget=45):
    """Wait, then reopen the proven drawer once; never infer zero or logout."""
    deadline=time.monotonic()+budget
    while True:
        guard()
        current=focus(adb_path,serial)
        assert_requested_foreground(current,events)
        if not blank_creator_center_loading(root,current):return root
        if time.monotonic()>=deadline:break
        time.sleep(min(1,max(0,deadline-time.monotonic())))
        root=navigation_capture(adb_path,serial,guard,events)
    if 'creator_center_blank_reopened' in events:
        raise ElementListReadError('Creator Center loading remained empty after bounded wait and reopen')
    guard()
    current=focus(adb_path,serial)
    assert_requested_foreground(current,events)
    if not blank_creator_center_loading(root,current):return root
    adb(adb_path,serial,'shell','input','keyevent','4',timeout=7)
    fresh=navigation_capture(adb_path,serial,guard,events)
    assert_requested_foreground(focus(adb_path,serial),events)
    if not (label(fresh,'我的草稿') and label(fresh,'创作者中心')):
        raise ElementListReadError('Creator Center loading Back did not return to the proven drawer')
    events.append('creator_center_blank_reopened')
    return fresh


def creator_navigation_state(root):
    """Bounded diagnostics: UI landmarks only, never account or note text."""
    names = ("我", "菜单", "已选定笔记", "我的草稿", "创作者中心", "创作中心",
             "最新笔记", "更多", "更多笔记", "近 7 日数据", "观看", "数据中心",
             "作品分析", "全部笔记", "开通数据权限", "账号异常")
    present = [name for name in names if label(root, name)]
    profile = label(root, "我")
    selected = sorted(set(n.get("selected", "unknown") for n in profile))
    return "/".join(present) + ";profile_selected=" + ",".join(selected)


def ensure_creator_list(adb_path, serial, root, slot, guard, events, _notification_retry=False):
    recoveries = 0
    more_attempts = 0
    overview_opened = "creator_overview_reopened" in events
    overview_attempts = 0
    home_scrolls = 0
    chat_backs = 0
    server_refreshes = 0
    states = []
    for _ in range(6 if _notification_retry else 14):
        states.append(creator_navigation_state(root))
        if wake_if_asleep(adb_path, serial, guard, events):
            root = navigation_capture(adb_path, serial, guard, events)
        if ("collection_slot_requested:app1" in events
                or any(event.startswith("clone_user_requested:") for event in events)):
            current = focus(adb_path, serial)
            if re.search(r"\bu\d+\s+com\.xingin\.xhs/", current):
                verify_collection_slot(adb_path, serial, slot, events)
            resumed = resume_vivo_update_entry(adb_path, serial, current, guard, events)
            if resumed is not None:
                root = resumed
                continue
        require_creator_service_available(root)
        if creator_filter_panel(root):
            tap_filter_label(adb_path,serial,root,"收起",guard)
            events.append("works_filter_panel_collapsed")
            root = navigation_capture(adb_path,serial,guard,events)
            continue
        if creator_list(root):
            return root
        # Creator Center also labels its overview entry “数据中心”. Keep the
        # proven native home on the existing entry/overlay/account checks below.
        if ((label(root, "数据中心") and not creator_overview_entry(root)
                and not (overview_attempts and label(root,"创作中心")))
                or ((more_attempts or overview_opened) and blank_works_loading(root))):
            return wait_data_center_loading(adb_path, serial, root, guard, events)
        if (label(root, "个人信息保护提示") and any(n.get("package") == XHS_PACKAGE
                and n.get("text", "").startswith("欢迎使用小红书！") for n in root.iter("node"))
                and label(root, "同意") and label(root, "不同意")):
            raise RuntimeError("Xiaohongshu first-use privacy agreement requires manual acceptance")
        if label(root, "服务器出错") and refresh_creator_server_error(adb_path, serial, root, guard, events, server_refreshes):
            server_refreshes += 1
            time.sleep(1)
            root = navigation_capture(adb_path, serial, guard, events)
            continue
        if label(root, "账号异常") and label(root, "创作中心"):
            # 107 exposes these labels underneath the known growth offer.
            # Reclassify a fresh page only after its proven safe dismissal.
            if (recoveries < 3 and label(root, "解锁成长中心")
                    and recover_known_overlay(adb_path, serial, root, guard, events)):
                recoveries += 1
                root = navigation_capture(adb_path, serial, guard, events)
                continue
            if not allow_warned_creator_data_entry(root,events):
                if (overview_attempts and 'creator_account_status_abnormal_observed' in events
                        and scroll_creator_home_for_latest(adb_path,serial,root,guard,events,home_scrolls)):
                    home_scrolls+=1
                    root=navigation_capture(adb_path,serial,guard,events)
                    continue
                raise RuntimeError("creator account shows abnormal status; collection skipped")
        if recoveries < 3 and recover_known_overlay(adb_path, serial, root, guard, events):
            recoveries += 1
            root = navigation_capture(adb_path, serial, guard, events)
            continue
        current = focus(adb_path, serial)
        if blank_creator_center_loading(root,current):
            root=wait_creator_center_loading(adb_path,serial,root,guard,events)
            continue
        if recover_vivo_store_detail(adb_path,serial,root,slot,current,guard,events):
            root = navigation_capture(adb_path,serial,guard,events)
            continue
        if recover_vivo_store_update(adb_path,serial,root,slot,current,guard,events):
            root = navigation_capture(adb_path,serial,guard,events)
            continue
        if recover_vivo_browser_permission_redirect(adb_path,serial,root,slot,current,guard,events):
            root=navigation_capture(adb_path,serial,guard,events)
            continue
        if recover_vivo_browser_redirect(adb_path,serial,slot,current,guard,events,root):
            root = navigation_capture(adb_path,serial,guard,events)
            continue
        if login_activity(current) or (re.search(r"mCurrentFocus=Window\{[^\n}]*\bu\d+\s+com\.xingin\.xhs/", current)
                                       and login_element_evidence(root, current, events)):
            root = confirm_logged_out(adb_path, serial, root, guard, events)
            continue
        if (XHS_PACKAGE in current and label(root, "创作中心") and label(root, "开通数据权限")
                and not label(root, "最新笔记")):
            raise RuntimeError("Creator Center data permission is not enabled")
        if any(marker in current for marker in ("DoubleAppResolverActivity", "com.android.intentresolver",
                                                "ResolverActivity", "HwChooserActivity")):
            if (select_miui_clone(adb_path, serial, root, current, slot, guard, events)
                    or select_oppo_clone(adb_path, serial, root, current, slot, guard, events)
                    or select_honor_owner(adb_path, serial, root, current, slot, guard, events)):
                root = navigation_capture(adb_path, serial, guard, events)
                continue
            labels = ("小红书",) if slot == "app1" else ("Ⅱ·小红书", "II·小红书", "II ·小红书", "Ⅱ ·小红书")
            target = next((value for value in labels if label(root, value)), None)
            if target:
                tap_label(adb_path, serial, root, target, guard)
                events.append("clone_slot_selected:" + slot)
        elif xhs_chat_activity(current):
            if any(node.get("package") == XHS_PACKAGE and "EditText" in node.get("class", "")
                   and (node.get("text") or "").strip() not in ("", "请友善发言...")
                   and not ((node.get("text") or "").strip() in ("发消息…", "发消息或按住说话...")
                            and node.get("focused") == "false")
                   for node in live_nodes(root)):
                raise RuntimeError("restored chat has unsent text; collection stopped")
            if close_restored_ai_page(adb_path, serial, root, current, guard, events):
                root = navigation_capture(adb_path, serial, guard, events)
                continue
            if chat_backs >= 2:
                raise RuntimeError("restored Xiaohongshu chat page did not close")
            guard()
            adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
            chat_backs += 1
            events.append("restored_chat_back")
        elif label(root, "笔记分析详情"):
            guard()
            adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
        elif (overview_attempts or creator_overview_metric_placeholder(root)) and label(root, "创作中心") and label(root,"最新笔记") and creator_more_label(root):
            if more_attempts>=2:
                raise ElementListReadError('Creator Center More entrance did not open after two proven attempts')
            tap_label(adb_path,serial,root,creator_more_label(root),guard)
            events.append('creator_more_selected');more_attempts+=1
            time.sleep(.7)
        elif overview_attempts and label(root,'创作中心'):
            if scroll_creator_home_for_latest(adb_path,serial,root,guard,events,home_scrolls):
                home_scrolls += 1
                root=navigation_capture(adb_path,serial,guard,events)
                continue
            raise ElementListReadError('Creator Center data entrance stayed on home; latest-notes entrance not proven')
        elif creator_overview_entry(root):
            if creator_overview_metric_placeholder(root):
                overview_attempts+=1
                events.append('creator_placeholder_requires_latest_entry')
                if scroll_creator_home_for_latest(adb_path,serial,root,guard,events,home_scrolls):
                    home_scrolls+=1
                    root=navigation_capture(adb_path,serial,guard,events)
                    continue
                raise ElementListReadError('Creator Center placeholder metric has no proven works entrance')
            tap_creator_overview(adb_path, serial, root, guard, events)
            overview_attempts += 1
            overview_opened = True
            events.append("creator_overview_selected" if label(root, "最新笔记")
                          else "creator_overview_opened_without_latest_notes")
            time.sleep(0.8)
        elif label(root, "创作中心") and label(root, "最新笔记") and creator_more_label(root):
            if more_attempts >= 2 and label(root, "账号异常"):
                raise RuntimeError("creator account abnormal; More did not open works analysis")
            tap_label(adb_path, serial, root, creator_more_label(root), guard)
            events.append("creator_more_selected")
            more_attempts += 1
            time.sleep(1)
        elif label(root, "创作者中心") and label(root, "我的草稿"):
            tap_label(adb_path, serial, root, "创作者中心", guard)
        elif label(root, "我的草稿") and any(
            node.get("package") == XHS_PACKAGE and node.get("class") == "android.widget.Button"
            and node.get("clickable") == "true" and node.get("enabled") == "true"
            and ((node.get("text") or "").strip() == "创作中心"
                 or (node.get("content-desc") or "").strip() == "创作中心")
            for node in live_nodes(root)
        ):
            tap_label(adb_path, serial, root, "创作中心", guard)
            events.append("creator_drawer_alias_selected")
        elif label(root, "创作中心"):
            time.sleep(0.5)
        elif label(root, "菜单") and label(root, "已选定笔记"):
            tap_index_menu(adb_path, serial, root, guard, events)
        elif label(root, "我") and any(n.get("package") == XHS_PACKAGE for n in live_nodes(root)):
            screen_bottom = max((bounds(n)[3] for n in live_nodes(root)), default=0)
            if any(bounds(n)[1] > screen_bottom * 0.75 for n in label(root, "我")):
                tap_label(adb_path, serial, root, "我", guard)
        elif any(n.get("package") == XHS_PACKAGE and n.get("content-desc") == "我"
                 and n.get("selected") == "false" and n.get("bounds") == "[0,0][0,0]"
                 for n in root.iter("node")):
            refreshed = select_zero_bounds_profile(adb_path, serial, root, current, guard, events)
            if refreshed is None:
                raise RuntimeError("profile tab is inaccessible outside the verified index page")
            root = refreshed
            continue
        elif re.search(r"com\.xingin\.xhs/(?:com\.xingin\.xhs\.index\.v2\.IndexActivityV2|"
                       r"\.index\.v2\.IndexActivityV2)(?:[}\s]|$)", current) and len([
            node for node in label(root, "菜单") if node.get("package") == XHS_PACKAGE
            and node.get("clickable") == "true" and node.get("enabled") == "true"
        ]) == 1:
            tap_index_menu(adb_path, serial, root, guard, events)
            events.append("index_menu_opened_without_bottom_tab")
        else:
            time.sleep(0.5)
        root = navigation_capture(adb_path, serial, guard, events)
    if data_center_tab_header(root):
        root = wait_data_center_loading(adb_path, serial, root, guard, events, require_content=True)
        events.append("works_tab_completed_at_navigation_limit")
        return root
    # The last capture is not processed by the exhausted loop. A late XHS
    # notification activity must get its own bounded dismissal/readback, even
    # when earlier unrelated overlays consumed the generic recovery budget.
    current = focus(adb_path, serial)
    notification = re.search(
        r"mCurrentFocus=Window\{[^\n}]*\bu\d+\s+com\.xingin\.xhs/(?:"
        r"com\.xingin\.authorization\.NotificationAuthorizationTranslucentActivity|"
        r"\.authorization\.NotificationAuthorizationTranslucentActivity)(?:[}\s]|$)", current)
    if notification and not _notification_retry:
        assert_requested_foreground(current, events)
        def notification_guard():
            guard()
            fresh = focus(adb_path, serial)
            assert_requested_foreground(fresh, events)
            if fresh != current:
                raise ElementListReadError("late notification foreground changed before Back")
        if recover_known_overlay(adb_path, serial, root, notification_guard, events, read_guard=guard):
            events.append("creator_late_notification_retry")
            guard()
            assert_requested_foreground(focus(adb_path, serial), events)
            root = navigation_capture(adb_path, serial, guard, events)
            return ensure_creator_list(adb_path, serial, root, slot, guard, events, _notification_retry=True)
    raise ElementListReadError("could not prove the Creator Center works-analysis path from UI elements; states="
                               + json.dumps(states[-4:] + [creator_navigation_state(root)], ensure_ascii=False))


def reopen_creator_list(adb_path, serial, root, guard, events, slot="app1"):
    """Discard a WebView's restored scroll position before scanning newest first."""
    if not creator_list(root):
        raise RuntimeError("works-analysis list is not open for reset")
    guard()
    adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
    time.sleep(0.4)
    root = navigation_capture(adb_path, serial, guard, events)
    if creator_overview_entry(root):
        tap_label(adb_path, serial, root, "观看", guard)
        events.append("creator_overview_reopened")
        root = navigation_capture(adb_path, serial, guard, events)
        root = ensure_creator_list(adb_path, serial, root, slot, guard, events)
        events.append("list_reopened_at_newest")
        return root
    elif label(root, "创作中心") and label(root, "最新笔记") and creator_more_label(root):
        tap_label(adb_path, serial, root, creator_more_label(root), guard)
    else:
        raise RuntimeError("could not prove list returned to Creator Center")
    events.append("list_reopened_at_newest")
    return navigation_capture(adb_path, serial, guard, events)


def is_note_status(text):
    return text.startswith("笔记状态") or text in (
        "笔记审核中",
        "该篇笔记已不可被他人查看",
        "该篇笔记已不被推荐给未关注用户",
        "该笔记已被限制推荐和搜索展示，但广告投放和蒲公英流量不受影响。",
    )


def note_cards(root):
    require_element_tree(root)
    cards = structured_note_cards(root)
    if not cards:cards = flat_webview_cards(root)
    views = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
             and n.get("class") == "android.webkit.WebView" and n.get("text") == "数据中心"]
    filters = label(root,"全部笔记")
    if len(views) == len(filters) == 1:
        top,bottom = bounds(filters[0])[3],bounds(views[0])[3]
        cards = [(n,item) for n,item in cards if top <= bounds(n)[1] < bounds(n)[3] <= bottom]
    return cards


def structured_note_cards(root):
    cards = []
    nodes = live_nodes(root)
    visible = set(nodes)
    for node in nodes:
        box = bounds(node)
        if box[2]-box[0] < 400 or not 140 <= box[3]-box[1] <= 320:
            continue
        children = [n for n in node.iter("node") if n in visible]
        texts = [(n.get("text") or "").strip() for n in children]
        if not any(is_note_status(t) for t in texts):
            continue
        title = next(((n.get("text") or "").strip() for n in children
                      if bounds(n)[0] >= box[0] + (box[2]-box[0])*0.20
                      and bounds(n)[1] < box[1] + (box[3]-box[1])*0.38
                      and 1 <= len((n.get("text") or "").strip()) <= MAX_NATIVE_TITLE_CHARS
                      and not re.fullmatch(r"[0-9a-f]{32,64}", (n.get("text") or "").strip())
                      and not is_note_status(n.get("text") or "")), None)
        date = next((t for t in texts if DATE.fullmatch(t)), None)
        if not title or not date:
            continue
        status = next((t for t in texts if is_note_status(t)), None)
        numbers = sorted((bounds(n)[0], count(n.get("text"))) for n in children
                         if count(n.get("text")) is not None and bounds(n)[1] >= box[1] + (box[3]-box[1])*0.58)
        values = [value for _, value in numbers]
        if len(values) != 3:
            continue
        item = {"title": title, "published_at_raw": date, "status_raw": status,
                             "list_view_count": values[0] if len(values) > 0 else None,
                             "list_like_count": values[1] if len(values) > 1 else None,
                             "list_comment_count": values[2] if len(values) > 2 else None}
        cover = element_cover_fingerprint(node, visible)
        if cover:
            item["element_cover_sha256"] = cover
        cards.append((node, item))
    return cards


def element_cover_fingerprint(row, visible):
    """Hash only the native cover element's opaque text, never image pixels.

    This is an in-task identity aid, not a note ID. Rotating/missing resource
    labels must fail the existing seam/two-pass checks, not merge two posts.
    """
    x1, y1, x2, y2 = bounds(row)
    covers = [n for n in row.iter("node") if n in visible and n.get("package") == XHS_PACKAGE
              and n.get("class") == "android.widget.Image" and bounds(n)
              and x1 <= bounds(n)[0] < bounds(n)[2] <= x1 + (x2-x1)*.25
              and y1 <= bounds(n)[1] < bounds(n)[3] <= y2
              and bounds(n)[3]-bounds(n)[1] >= (y2-y1)*.45]
    if len(covers) != 1:
        return None
    value = (covers[0].get("text") or "").strip()
    if not 1 <= len(value) <= 16384:
        return None
    return hashlib.sha256(("xhs-cover-element-v1\0" + value).encode("utf-8")).hexdigest()


def note_identity(note, normalized_date=False):
    identity = (note["title"], note["published_date" if normalized_date else "published_at_raw"])
    cover = note.get("element_cover_sha256")
    return identity + (cover,) if cover else identity


def flat_webview_cards(root):
    """Huawei WebView can expose card fields as direct siblings without rows."""
    if not creator_list(root):
        return []
    webviews = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
                and n.get("class") == "android.webkit.WebView" and n.get("text") == "数据中心"]
    if len(webviews) != 1:
        return []
    visible = set(live_nodes(root))
    groups = []
    for node in webviews[0]:
        text = (node.get("text") or "").strip()
        if DATE.fullmatch(text):
            groups.append([node])
        elif groups and text:
            # 144 exposes the end marker directly after six native fields.
            # Only a same-package footer below the whole row is excluded;
            # a note title reading "到底了" remains the second field.
            if (text == "到底了" and len(groups[-1]) == 6
                    and node in visible and node.get("package") == XHS_PACKAGE
                    and node.get("class") == "android.widget.TextView"
                    and all(bounds(n) for n in groups[-1])
                    and bounds(node)[1] >= max(bounds(n)[3] for n in groups[-1])):
                continue
            groups[-1].append(node)
    cards = []
    for group in groups:
        if len(group) != 6 or any(n not in visible or n.get("package") != XHS_PACKAGE
                                  or n.get("class") != "android.widget.TextView" for n in group):
            continue
        date, title, status, *metrics = group
        title_text = (title.get("text") or "").strip()
        status_text = (status.get("text") or "").strip()
        values = [count(n.get("text")) for n in metrics]
        if (not 1 <= len(title_text) <= MAX_NATIVE_TITLE_CHARS or DATE.fullmatch(title_text) or count(title_text) is not None
                or not is_note_status(status_text)
                or any(v is None for v in values)):
            continue
        db, tb, sb = bounds(date), bounds(title), bounds(status)
        mb = [bounds(n) for n in metrics]
        # Prove the same card geometry: date at left, title/status above a
        # single left-to-right metric row, all within one observed row height.
        if (not db[2] < tb[0] or not tb[3] <= sb[1] < sb[3] <= min(b[1] for b in mb)
                or not all(db[1] < b[3] and b[1] < db[3] for b in mb)
                or max(b[1] for b in mb)-min(b[1] for b in mb) > 6
                or not mb[0][2] < mb[1][0] < mb[1][2] < mb[2][0]
                or not 140 <= max(db[3], *(b[3] for b in mb))-tb[1] <= 320):
            continue
        proxy = ET.Element("node", {"bounds": f"[{db[0]},{tb[1]}][{tb[2]},{max(db[3], *(b[3] for b in mb))}]"})
        cards.append((proxy, {"title": title_text, "published_at_raw": date.get("text"), "status_raw": status_text,
                              "list_view_count": values[0], "list_like_count": values[1], "list_comment_count": values[2]}))
    return cards


def proven_list_terminal(root):
    """A footer must be outside note rows; a matching note title proves nothing."""
    views = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
             and n.get("class") == "android.webkit.WebView" and n.get("text") == "数据中心"]
    if len(views) != 1:
        return False, False
    view = views[0]
    raw = structured_note_cards(root) or flat_webview_cards(root)
    nodes = live_nodes(view)
    filters = label(view, "全部笔记")
    top = bounds(filters[0])[3] if len(filters) == 1 else bounds(view)[1]
    bottom = bounds(view)[3]
    markers = {}
    for value in ("暂无笔记", "到底了"):
        matches = [n for n in nodes if n.get("text") == value and n.get("package") == XHS_PACKAGE
                   and n.get("class") == "android.widget.TextView"
                   and top <= bounds(n)[1] < bounds(n)[3] <= bottom
                   and not any(bounds(row)[1] <= bounds(n)[1] < bounds(row)[3] for row, _ in raw)]
        markers[value] = len(matches) == 1 and (not raw or bounds(matches[0])[1] >= max(bounds(row)[3] for row, _ in raw))
    empty = (markers["暂无笔记"] or proven_display_empty_state(view)) and not raw and not any(
        is_note_status(n.get("text", "")) or DATE.fullmatch(n.get("text", "")) for n in nodes)
    return bool(empty), bool(markers["到底了"] and raw)


def proven_display_empty_state(view):
    """The observed full works-page empty state, never a loading/error shell.

    This means no notes are displayed by this data page, not a guarantee that
    the service has no hidden or restricted posts. Both independent scans still
    have to reach this exact terminal state.
    """
    nodes = live_nodes(view)
    def unique(text, classes):
        matches = [n for n in nodes if n.get("text") == text]
        return matches[0] if (len(matches) == 1 and matches[0].get("package") == XHS_PACKAGE
            and matches[0].get("class") in classes and matches[0].get("enabled") == "true") else None
    text_classes = ("android.view.View", "android.widget.TextView")
    message = unique("暂无可展示的笔记", text_classes)
    publish = unique("去发布", ("android.widget.Button",))
    filter_ = unique("全部笔记", text_classes)
    scope = unique("仅统计近半年内笔记", text_classes)
    if any(n is None for n in (message, publish, filter_, scope)):
        return False
    if len({node.get("class") for node in (message, filter_, scope)}) != 1:
        return False
    if (publish.get("clickable") != "true" or not data_center_tab_header(view)
            or any(n.get("text") in ("账号异常", "开通数据权限", "服务器开小差了") for n in nodes)):
        return False
    boxes = [bounds(n) for n in (view, filter_, scope, message, publish)]
    vb, fb, sb, mb, pb = boxes
    return (all(boxes) and vb[1] <= fb[1] < fb[3] < mb[1] < mb[3] < pb[1] < pb[3] <= vb[3]
        and sb[3] < mb[1] and vb[0] <= mb[0] < mb[2] <= vb[2]
        and vb[0] <= pb[0] < pb[2] <= vb[2])


def element_page_signature(root, allow_duplicate_rows=False):
    """Prove complete visible element rows, excluding only clipped edge rows."""
    require_element_tree(root)
    if not creator_list(root) or creator_filter_panel(root):return None
    cards = note_cards(root)
    if not cards:
        empty, bottom = proven_list_terminal(root)
        return ((), empty, bottom) if empty else None
    # Window-aware callers retain every row, then reject ambiguous identities
    # inside the requested window. Other callers keep the strict default.
    identities = [note_identity(item) for _, item in cards]
    if not allow_duplicate_rows and len(set(identities)) != len(identities):
        raise ElementListReadError("visible element rows have ambiguous duplicate title/date")
    views = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
             and n.get("class") == "android.webkit.WebView" and n.get("text") == "数据中心"]
    filters = label(root,"全部笔记")
    if len(views) == len(filters) == 1:
        top,bottom = bounds(filters[0])[3],bounds(views[0])[3]
        statuses = [n for n in live_nodes(views[0]) if is_note_status(n.get("text",""))]
        # Native row spacing rounds independently (94: actual top312,
        # filter314, median estimate314). A fully parsed raw row proves its
        # own clipping more accurately than another row's estimated margins.
        visible = set(live_nodes(root))
        raw_complete = structured_note_cards(root) or flat_webview_cards(root)
        clipped_rows = [bounds(row) for row,_ in raw_complete
                        if (bounds(row)[1] < top or bounds(row)[3] > bottom)
                        and all(n.get("package") == XHS_PACKAGE for n in row.iter("node") if n in visible)]
        gaps = []
        for row,item in cards:
            if any(n.get("package") != XHS_PACKAGE for n in row.iter("node")
                   if n in visible):
                raise ElementListReadError("element row contains another package")
            box = bounds(row)
            matches = [n for n in statuses if box[1] <= bounds(n)[1] < bounds(n)[3] <= box[3]]
            if len(matches) != 1:raise ElementListReadError("element row status is missing or ambiguous")
            sb = bounds(matches[0]);gaps.append((sb[1]-box[1],box[3]-sb[3]))
        title_gap = sorted(g[0] for g in gaps)[len(gaps)//2]
        metric_gap = sorted(g[1] for g in gaps)[len(gaps)//2]
        for status in statuses:
            sb = bounds(status)
            if any(bounds(row)[1] <= sb[1] < sb[3] <= bounds(row)[3] for row,_ in cards):continue
            if any(box[1] <= sb[1] < sb[3] <= box[3] for box in clipped_rows):continue
            if sb[1]-title_gap < top or sb[3]+metric_gap > bottom:continue
            raise ElementListReadError("a fully visible element row has incomplete title/date/metrics")
        # A missing status also makes the parser drop a row. Use the native
        #left date column as a second anchor, with margins from complete rows.
        width = bounds(views[0])[2] - bounds(views[0])[0]
        dates = [n for n in live_nodes(views[0]) if n.get("package") == XHS_PACKAGE
                 and DATE.fullmatch(n.get("text", ""))
                 and bounds(n)[0] < bounds(views[0])[0] + width*.25]
        margins = [(bounds(date)[1]-bounds(row)[1], bounds(row)[3]-bounds(date)[3])
                   for row,_ in cards for date in dates
                   if bounds(row)[1] <= bounds(date)[1] < bounds(date)[3] <= bounds(row)[3]]
        if margins:
            before = sorted(x[0] for x in margins)[len(margins)//2]
            after = sorted(x[1] for x in margins)[len(margins)//2]
            for date in dates:
                box = bounds(date)
                if any(bounds(row)[1] <= box[1] < box[3] <= bounds(row)[3] for row,_ in cards):continue
                if any(row[1] <= box[1] < box[3] <= row[3] for row in clipped_rows):continue
                if box[1]-before < top or box[3]+after > bottom:continue
                raise ElementListReadError("a fully visible dated element row has incomplete status/title/metrics")
    return (tuple(note_identity(v) + (v["status_raw"],v["list_view_count"],v["list_like_count"],v["list_comment_count"]) for _,v in cards),
            *proven_list_terminal(root))


def verify_newest_element_position(root):
    cards = note_cards(root)
    filters = label(root,"全部笔记")
    views = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
             and n.get("class") == "android.webkit.WebView" and n.get("text") == "数据中心"]
    if cards and not len(filters) == len(views) == 1:
        raise ElementListReadError("newest list position requires a unique native header")
    if cards:
        top = bounds(filters[0])[3];width = bounds(views[0])[2]-bounds(views[0])[0]
        raw = structured_note_cards(root)
        if (any(bounds(n)[1] < top for n,_ in raw)
                or not top <= bounds(cards[0][0])[1] <= top+width*.12):
            raise ElementListReadError("newest list position is not proven by elements")


def verify_element_overlap(previous_root, root):
    previous = [note_identity(v) for _,v in note_cards(previous_root)]
    raw = structured_note_cards(root) or flat_webview_cards(root)
    full = {note_identity(v) for _,v in note_cards(root)}
    # Known clipped rows may anchor the seam; unknown clipped rows are not data.
    current = [note_identity(v) for _,v in raw
               if note_identity(v) in set(previous) | full]
    common = [identity for identity in current if identity in previous]
    if previous and not common:
        raise ElementListReadError("element page continuity is unproven after scroll")
    if not previous:
        return
    start = previous.index(common[0])
    if (previous[start:start+len(common)] != common
            or current[:len(common)] != common
            or (len(current) > len(common) and previous[start:] != common)):
        raise ElementListReadError("ordered element overlap has a gap, reorder or backward jump")


def verify_history_extension(history, root, as_of, cutoff, terminal=False):
    """Do not silently deduplicate a distant repeat or accept a missing known tail."""
    full = [note_identity(v) for _,v in note_cards(root)
            if cutoff <= published_date(v["published_at_raw"], as_of) <= as_of]
    novel = [identity for identity in full if identity not in history]
    if not history:
        return
    raw = structured_note_cards(root) or flat_webview_cards(root)
    observed = [note_identity(v) for _,v in raw
                if note_identity(v) in history or note_identity(v) in full]
    common = [identity for identity in observed if identity in history]
    dates = [published_date(identity[1], as_of) for identity in observed]
    if (not common or common != history[history.index(common[0]):history.index(common[0])+len(common)]
            or ((novel or terminal) and common != history[-len(common):])
            or observed[:len(common)] != common
            or any(later > earlier for earlier, later in zip(dates, dates[1:]))):
        raise ElementListReadError("ordered collection history has an ambiguous repeat or missing tail")


def prove_native_list_start(adb_path, serial, root, guard, events):
    """Require a freshly read, unchanged leading row after a bounded upward check."""
    for _ in range(3):
        guard()
        signature = element_page_signature(root, allow_duplicate_rows=True)
        if signature is None:
            raise ElementListReadError("native list start is not loaded")
        verify_newest_element_position(root)
        if not note_cards(root):
            if not signature[1]:
                raise ElementListReadError("empty list start is not proven")
            events.append("list_top_confirmed_empty_elements")
            return root
        first = note_cards(root)[0]
        anchor = (note_identity(first[1]), bounds(first[0]))
        swipe(adb_path, serial, root, guard, events, reverse=True)
        following = refresh_scrolled_webview(adb_path, serial,
            navigation_capture(adb_path, serial, guard, events), guard, events, root)
        following = wait_creator_content(adb_path, serial, following, guard, events)
        verify_newest_element_position(following)
        cards = note_cards(following)
        if cards and anchor == (note_identity(cards[0][1]), bounds(cards[0][0])):
            events.append("list_top_confirmed_by_reverse_scroll")
            return following
        root = following
    raise ElementListReadError("native newest row did not stabilize after upward checks")


def data_center_reopen_count(events):
    return sum(e.startswith("data_center_loading_reopen:")
               or e == "works_native_more_recovery_attempted" for e in events)


def reopen_loading_data_center(adb_path, serial, root, guard, events):
    """Retry only a proven data page, before scanning, with a task-wide budget."""
    if any(e.startswith("collection_scan_as_of:") for e in events):
        raise ElementListReadError("cannot reopen the data center during list scanning")
    if data_center_reopen_count(events) >= DATA_CENTER_MAX_REOPENS:
        raise ElementListReadError("data-center loading retry budget exhausted")
    if not (label(root, "数据中心") or blank_works_loading(root)):
        raise ElementListReadError("data-center loading page is not proven for retry")
    guard()
    current = focus(adb_path, serial)
    assert_requested_foreground(current, events)
    if not works_webview_activity(current):
        raise ElementListReadError("data-center loading foreground changed before retry")
    require_creator_service_available(root)
    if not creator_list(root) and label(root, "账号异常"):
        raise RuntimeError("creator account shows abnormal status; collection skipped")
    guard()
    if focus(adb_path, serial) != current:
        raise ElementListReadError("data-center loading foreground changed before Back")
    events.append("data_center_loading_reopen:" + str(data_center_reopen_count(events) + 1))
    adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
    center = navigation_capture(adb_path, serial, guard, events)
    guard()
    assert_requested_foreground(focus(adb_path, serial), events)
    require_creator_service_available(center)
    if label(center, "账号异常") and not allow_warned_creator_data_entry(center, events):
        raise RuntimeError("creator account shows abnormal status; collection skipped")
    more = creator_more_label(center)
    if label(center, "创作中心") and label(center, "最新笔记") and more:
        entry = "观看" if blank_works_loading(root) and creator_overview_entry(center) else more
    elif creator_overview_entry(center):
        entry = "观看"
    else:
        raise ElementListReadError("loading retry did not return to proven Creator Center")
    if entry == "观看":
        if creator_overview_metric_placeholder(center) and label(center,'最新笔记') and creator_more_label(center):
            tap_label(adb_path,serial,center,creator_more_label(center),guard)
            return navigation_capture(adb_path,serial,guard,events)
        tap_creator_overview(adb_path,serial,center,guard,events)
    else:
        tap_label(adb_path, serial, center, entry, guard)
    return navigation_capture(adb_path, serial, guard, events)


def wait_data_center_loading(adb_path, serial, root, guard, events, require_content=False):
    """Time-based reads; only proven entry recovery can spend the shared budget.

    A running native read keeps its own bounded timeout. The 45-second budget
    stops starting further reads; it is not a hard timeout for subprocess cleanup.
    """
    marker = "data_center_loading_active"
    if marker in events:
        raise ElementListReadError("nested data-center loading recovery is forbidden")
    phase = "content" if require_content else "entry"
    events.append(marker)
    try:
        while True:
            deadline = time.monotonic() + DATA_CENTER_LOAD_SECONDS
            previous = None
            selected = False
            for _ in range(int(DATA_CENTER_LOAD_SECONDS / DATA_CENTER_POLL_SECONDS) + 2):
                guard()
                require_creator_service_available(root)
                if not creator_list(root) and label(root, "账号异常"):
                    raise RuntimeError("creator account shows abnormal status; collection skipped")
                if wake_if_asleep(adb_path, serial, guard, events):
                    root = navigation_capture(adb_path, serial, guard, events)
                    previous = None
                    require_creator_service_available(root)
                    if not creator_list(root) and label(root, "账号异常"):
                        raise RuntimeError("creator account shows abnormal status; collection skipped")
                current = focus(adb_path, serial)
                resumed = resume_vivo_update_entry(adb_path, serial, current, guard, events)
                if resumed is not None:
                    # The one proven Back can return to native Creator Center.
                    # Leave this loading frame while the existing navigation
                    # resumes; its once-per-task marker forbids another Back.
                    events.remove(marker)
                    try:
                        slot = next(e.split(":", 1)[1] for e in events if e.startswith("collection_slot_requested:"))
                        return ensure_creator_list(adb_path, serial, resumed, slot, guard, events)
                    finally:
                        events.append(marker)
                assert_requested_foreground(current, events)
                if login_activity(current):
                    confirm_logged_out(adb_path, serial, navigation_capture(adb_path, serial, guard, events), guard, events)
                if not works_webview_activity(current):
                    raise ElementListReadError("data-center loading foreground changed")
                if creator_list(root):
                    if not require_content:
                        events.append("data_center_loading_ready:" + phase)
                        return root
                    try:
                        signature = element_page_signature(root, allow_duplicate_rows=True)
                    except ElementListReadError:
                        signature = None
                    if signature is not None and signature == previous:
                        events.append("data_center_loading_ready:" + phase)
                        return root
                    previous = signature
                else:
                    previous = None
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                if (not creator_list(root) and not selected and data_center_tab_header(root)
                        and not any(e.startswith("collection_scan_as_of:") for e in events)):
                    selected = open_works_tab(adb_path, serial, root, guard, events,
                                              expected_foreground=current, deadline=deadline)
                    if selected:
                        root = navigation_capture(adb_path, serial, guard, events)
                        continue
                guard()
                time.sleep(min(DATA_CENTER_POLL_SECONDS, remaining))
                if time.monotonic() >= deadline:
                    break
                root = navigation_capture(adb_path, serial, guard, events)
            events.append("data_center_load_timeout:" + phase)
            if (any(e.startswith("collection_scan_as_of:") for e in events)
                    or data_center_reopen_count(events) >= DATA_CENTER_MAX_REOPENS):
                raise ElementListReadError("data-center loading timed out; UI elements stayed incomplete or unstable")
            root = reopen_loading_data_center(adb_path, serial, root, guard, events)
    finally:
        events.remove(marker)


def wait_creator_content(adb_path, serial, root, guard, events):
    return wait_data_center_loading(adb_path, serial, root, guard, events, require_content=True)


def swipe(adb_path, serial, root, guard, events, reverse=False):
    containers = [n for n in live_nodes(root) if n.get("scrollable") == "true"]
    if (not containers and creator_list(root) and note_cards(root)
            and re.search(r"com\.xingin\.xhs/com\.xingin\.xywebview\.activity\.WebViewActivityV2(?:[}\s]|$)", focus(adb_path, serial))):
        containers = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
                      and n.get("class") == "android.webkit.WebView" and n.get("text") == "数据中心"]
        if len(containers) != 1:
            containers = []
        else:
            events.append("works_webview_scroll_flag_fallback")
    if not containers:
        raise RuntimeError("works-analysis scroll container not found")
    container = max(containers, key=lambda n: (bounds(n)[2]-bounds(n)[0]) * (bounds(n)[3]-bounds(n)[1]))
    x1, y1, x2, y2 = bounds(container)
    x = x1 + (x2-x1) * 3 // 4
    start_y = y1 + (y2-y1) * 4 // 5
    cards = note_cards(root)
    if not cards:
        raise ElementListReadError("cannot size a continuous scroll without complete native rows")
    rows = sorted((bounds(row) for row,_ in cards), key=lambda box: box[1])
    height = sorted(box[3]-box[1] for box in rows)[len(rows)//2]
    # A WebView may expose only part of the loaded list. Keep overlap within
    # the rows actually read, including when just one complete row remains.
    step = int(min((y2-y1)*.25, height*2,
                   max(height*.5, (rows[-1][1]-rows[0][1])*.5)))
    # With four or more complete rows, retain the last two visible
    # row starts as overlap and advance at most three median row heights.
    # Thin/clipped subsets keep the original smaller step. Actual post-scroll
    # continuity still requires fresh complete elements before accepting data.
    # Observed47/141 native boxes overlap2-5px at row edges. Allow only
    # this tiny rounding envelope; substantial/nested row overlap stays slow.
    edge_tolerance = min(8, height*.03)
    if ("collection_verification_pass" not in events and not reverse
            and len(rows) >= 4 and all(a[3] <= b[1] + edge_tolerance for a, b in zip(rows, rows[1:]))):
        step = int(min((y2-y1)*.40, height*3, rows[-2][1]-rows[0][1]))
    if step <= 0:
        raise ElementListReadError("native row geometry cannot prove a scroll distance")
    end_y = max(y1+1, start_y-step)
    if reverse:
        start_y = y1 + (y2-y1) // 3
        end_y = min(y2-1, start_y+step)
    wake_if_asleep(adb_path, serial, guard, events)
    guard()
    adb(adb_path, serial, "shell", "input", "swipe", str(x), str(start_y), str(x), str(end_y), "550", timeout=8)
    time.sleep(0.4)


def tap_filter_label(adb_path, serial, root, value, guard):
    """Tap a unique XHS WebView label whose parent may be nonclickable."""
    matches = [node for node in label(root, value)
               if (node.get("text") or "").strip() == value
               and node.get("package") == XHS_PACKAGE]
    if len(matches) != 1:
        raise RuntimeError(f"works-analysis filter label is not unique: {value}")
    x1, y1, x2, y2 = bounds(matches[0])
    guard()
    adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
    time.sleep(0.5)




def refresh_scrolled_webview(adb_path, serial, root, guard, events, previous_root=None):
    """Refresh a stale WebView accessibility tree without changing filters."""
    require_element_tree(root)
    if previous_root is not None and not creator_filter_panel(root) and creator_list(root) and note_cards(root):
        previous = [note_identity(n[1]) for n in note_cards(previous_root)]
        current_cards = [note_identity(n[1]) for n in note_cards(root)]
        # Clipping can remove old rows without exposing new content (47).
        # Require a genuinely new native identity before skipping the refresh.
        if (previous and set(current_cards) - set(previous)
                and re.search(r"com\.xingin\.xhs/com\.xingin\.xywebview\.activity\.WebViewActivityV2(?:[}\s]|$)", focus(adb_path, serial))):
            guard()
            events.append("works_list_updated_without_filter_toggle")
            return root
    if (not creator_filter_panel(root) and creator_list(root) and not label(root, "全部笔记") and note_cards(root)
            and re.search(r"com\.xingin\.xhs/com\.xingin\.xywebview\.activity\.WebViewActivityV2(?:[}\s]|$)", focus(adb_path, serial))):
        guard()
        events.append("works_list_offscreen_header_verified")
        return root
    if not creator_list(root) or not label(root, "全部笔记"):
        raise RuntimeError("works-analysis filter entry is not proven")
    wake_if_asleep(adb_path, serial, guard, events)
    if creator_filter_panel(root):
        expanded=root
    else:
        tap_filter_label(adb_path, serial, root, "全部笔记", guard)
        expanded = navigation_capture(adb_path, serial, guard, events)
    for _ in range(3):
        if creator_filter_panel(expanded):break
        guard()
        time.sleep(.5)
        expanded = navigation_capture(adb_path,serial,guard,events)
    if not creator_filter_panel(expanded):
        raise ElementListReadError("works-analysis filter panel elements are not proven")
    tap_filter_label(adb_path, serial, expanded, "收起", guard)
    refreshed = navigation_capture(adb_path, serial, guard, events)
    for _ in range(3):
        if not creator_filter_panel(refreshed) and creator_list(refreshed):break
        guard()
        time.sleep(.5)
        refreshed = navigation_capture(adb_path,serial,guard,events)
    if creator_filter_panel(refreshed) or label(refreshed,"排序方式") or not creator_list(refreshed):
        raise ElementListReadError("works-analysis filter panel closure is not proven by elements")
    events.append("webview_accessibility_refreshed")
    return refreshed


def capture_element_pair(adb_path, serial, guard, events):
    from xhs_native_window import read
    current = focus(adb_path, serial)
    assert_requested_foreground(current, events)
    assert_no_poco(adb_path, serial)
    try:
        return read(adb_path, serial, adb_process, lambda: focus(adb_path, serial), guard, current, pair=True)
    finally:
        guard()
        after = focus(adb_path, serial)
        assert_requested_foreground(after, events)
        if login_activity(after):
            raise ElementListReadError("native pair left works list for unconfirmed login state")
        if not works_webview_activity(after):
            raise ElementListReadError("native pair foreground changed")


def stable_pair_signature(trees):
    signatures = []
    for root in trees:
        require_creator_service_available(root)
        try:
            signature = element_page_signature(root, allow_duplicate_rows=True)
        except ElementListReadError:
            return None
        if signature is None:
            return None
        signatures.append(signature)
    return signatures[0] if len(signatures) == 2 and signatures[0] == signatures[1] else None


def probe_element_pair(adb_path, serial, root, guard, events):
    """Enable only after two fresh native trees agree with the proven stock page."""
    from xhs_native_window import NativePairUnavailable
    guard()
    sdk = adb(adb_path, serial, "shell", "getprop", "ro.build.version.sdk", timeout=8).strip()
    if not sdk.isdigit() or int(sdk) < 24:
        events.append("native_pair_sdk_unsupported")
        return False
    try:
        trees = capture_element_pair(adb_path, serial, guard, events)
    except NativePairUnavailable:
        events.append("native_pair_probe_unavailable")
        return False
    signature = stable_pair_signature(trees)
    if signature is not None and signature == element_page_signature(root, allow_duplicate_rows=True):
        events.append("native_pair_elements_enabled")
        return True
    events.append("native_pair_probe_mismatch")
    return False


def read_scrolled_content(adb_path, serial, previous_root, guard, events, fast_pair):
    """Keep continuity and two-snapshot checks; use the old path on unproven progress."""
    if "collection_verification_pass" in events:
        guard()
        current_focus = focus(adb_path, serial)
        assert_requested_foreground(current_focus, events)
        if not works_webview_activity(current_focus):
            raise ElementListReadError("verification foreground is not the works list")
        root = navigation_capture(adb_path, serial, guard, events)
        guard()
        if focus(adb_path, serial) != current_focus:
            raise ElementListReadError("verification foreground changed during read")
        require_creator_service_available(root)
        try:
            signature = element_page_signature(root, allow_duplicate_rows=True)
        except ElementListReadError:
            signature = None
        previous = {note_identity(v) for _, v in note_cards(previous_root)}
        current = {note_identity(v) for _, v in note_cards(root)}
        # The primary scan already double-read every row. This independent
        # audit reads each newly exposed page once; the complete ordered audit
        # still has to match that primary scan before any result is complete.
        if signature is not None and current - previous:
            try:
                verify_element_overlap(previous_root, root)
            except ElementListReadError:
                # A single asynchronous WebView export can expose a transient
                # seam. Stay at this position and require stable fresh elements.
                # Never issue another swipe or accept a genuine gap/reorder.
                events.append("verification_overlap_stability_retry")
                guard()
                if focus(adb_path, serial) != current_focus:
                    raise ElementListReadError("verification foreground changed before seam reread")
                root = navigation_capture(adb_path, serial, guard, events)
                root = wait_creator_content(adb_path, serial, root, guard, events)
                guard()
                if focus(adb_path, serial) != current_focus:
                    raise ElementListReadError("verification foreground changed during seam reread")
                verify_element_overlap(previous_root, root)
                events.append("verification_page_stability_fallback")
            events.append("verification_fresh_page_accepted")
            return root, False, False
        # Both stock UIAutomator and the fallback native reader produce fresh
        # element XML through navigation_capture; neither is a cached file.
        # A stale/partial tree is not evidence. Reuse this first read only as
        # input to the existing refresh and two-fresh-read stability path.
        events.append("verification_page_stability_fallback")
        root = refresh_scrolled_webview(adb_path, serial, root, guard, events, previous_root)
        return wait_creator_content(adb_path, serial, root, guard, events), False, False
    if fast_pair:
        from xhs_native_window import NativePairUnavailable
        try:
            trees = capture_element_pair(adb_path, serial, guard, events)
        except NativePairUnavailable:
            fast_pair = False
            events.append("native_pair_disabled_after_rejection")
        else:
            signature = stable_pair_signature(trees)
            previous = {note_identity(v) for _, v in note_cards(previous_root)}
            current = {note_identity(v) for _, v in note_cards(trees[1])}
            # Unchanged/clipped old content still requires the proven refresh path.
            if signature is not None and current - previous:
                verify_element_overlap(previous_root, trees[0])
                verify_element_overlap(previous_root, trees[1])
                return trees[1], True, fast_pair
            # Do not repeatedly pay for two rejected reads on a slow/stale OEM.
            # The established refresh/loading path remains authoritative here.
            fast_pair = False
            events.append("native_pair_disabled_after_unstable_or_stale_page")
    root = refresh_scrolled_webview(adb_path, serial, navigation_capture(adb_path, serial, guard, events), guard, events, previous_root)
    root = wait_creator_content(adb_path, serial, root, guard, events)
    return root, False, fast_pair


def verification_entry(args, guard, events):
    """Reuse only a freshly proven same-slot list from the completed primary scan."""
    prior = getattr(args, "verified_entry_events", ())
    if {e for e in prior if e.startswith("collection_slot_requested:")} != {"collection_slot_requested:" + args.app_slot}:
        return None
    carried = [e for e in prior if e.startswith(("collection_slot_requested:", "clone_user_requested:"))
               or e in {"native_window_elements_enabled", "xhs_cold_started", "vivo_store_update_back"}]
    guard()
    current = focus(args.adb, args.serial)
    assert_requested_foreground(current, carried)
    if not works_webview_activity(current):
        return None
    verify_collection_slot(args.adb, args.serial, args.app_slot, carried)
    assert_no_poco(args.adb, args.serial)
    root = navigation_capture(args.adb, args.serial, guard, carried)
    guard()
    if focus(args.adb, args.serial) != current:
        raise ElementListReadError("verification entry foreground changed")
    require_creator_service_available(root)
    require_element_tree(root)
    if not creator_list(root) or creator_filter_panel(root):
        return None
    events.extend(carried)
    events.append("verification_existing_list_reused")
    return root


def enter_creator_with_slot_retry(args, root, guard, events, expected_identity=None):
    """One explicit same-slot re-entry before scanning, never read the other user.

    OEM task restoration can return an existing task from the other profile.
    Account/login/permissions and all unrelated failures retain their errors.
    """
    try:
        if expected_identity is not None:
            root=prove_profile_identity(args,root,guard,events,expected_identity)
        return ensure_creator_list(args.adb,args.serial,root,args.app_slot,guard,events)
    except RuntimeError as error:
        mismatches={"Xiaohongshu foreground user does not match the requested slot",
                    "Xiaohongshu foreground clone user does not match the requested slot",
                    "Xiaohongshu foreground owner user does not match the requested slot"}
        if (str(error) not in mismatches or getattr(args,'used_slot_entry_retry',False)
                or any(e.startswith('collection_scan_as_of:') for e in events)):
            raise
        guard()
        args.used_slot_entry_retry=True
        events.append('entry_slot_mismatch_reopen_attempted')
        root=start_xhs(args.adb,args.serial,args.app_slot,guard,events)
        if expected_identity is not None:
            root=prove_profile_identity(args,root,guard,events,expected_identity)
        root=ensure_creator_list(args.adb,args.serial,root,args.app_slot,guard,events)
        verify_collection_slot(args.adb,args.serial,args.app_slot,events)
        events.append('entry_slot_mismatch_recovered')
        return root


def profile_header_identity(root, current, events):
    """Read a public ID only from a proven own-profile header, never a post."""
    assert_requested_foreground(current, events)
    if not re.search(r"com\.xingin\.xhs/(?:com\.xingin\.xhs\.index\.v2\.IndexActivityV2|"
                     r"\.index\.v2\.IndexActivityV2)(?:[}\s]|$)", current):
        raise ElementListReadError("account identity unproven: profile activity required")
    own = [n for n in root.iter("node") if n.get("package") == XHS_PACKAGE
           and n.get("class") == "android.view.ViewGroup" and n.get("content-desc") == "我"
           and n.get("selected") == "true" and n.get("enabled") == "true"
           and n.get("visible-to-user") != "false"]
    if len(own) != 1:
        raise ElementListReadError("account identity unproven: own profile selection required")
    nodes = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
             and n.get("enabled") == "true" and n.get("visible-to-user") != "false"
             and n.get("class") == "android.widget.TextView"]
    tabs = [[n for n in nodes if n.get("text") == text] for text in ("笔记", "收藏")]
    if any(len(v) != 1 for v in tabs):
        raise ElementListReadError("account identity unproven: profile tabs ambiguous")
    a, b = [bounds(v[0]) for v in tabs]
    if abs(a[1]-b[1]) > max(a[3]-a[1], b[3]-b[1]) / 2 or a[2] >= b[0]:
        raise ElementListReadError("account identity unproven: profile tab row invalid")
    parents = {n: parent for parent in root.iter() for n in parent}
    candidates = []
    for n in nodes:
        match = re.fullmatch(r"小红书号\s*[:：]\s*([A-Za-z0-9_-]{3,64})", n.get("text", "").strip())
        if not match or bounds(n)[3] >= min(a[1], b[1]):
            continue
        parent = parents.get(n)
        if (parent is None or parent.get("package") != XHS_PACKAGE
                or parent.get("class") != "android.widget.LinearLayout"
                or parent.get("enabled") != "true" or parent.get("visible-to-user") == "false"
                or n.get("clickable") != "true"):
            raise ElementListReadError("account identity unproven: header roles invalid")
        pb, nb = bounds(parent), bounds(n)
        copies = [c for c in parent if c.get("package") == XHS_PACKAGE
                  and c.get("class") == "android.widget.ImageView" and c.get("enabled") == "true"
                  and c.get("visible-to-user") != "false" and bounds(c)]
        if pb and (len(list(parent)) > 3 or sum(c.get("class") == "android.widget.ImageView" for c in parent) > 1):
            # Captured25: ID/copy | IP-location/arrow share the header row.
            # Accept only this exact companion sequence, never any extra icon.
            row = list(parent)
            roles = ("android.widget.TextView", "android.widget.ImageView", "android.widget.TextView",
                     "android.widget.TextView", "android.widget.ImageView")
            exact = (len(row) == 5 and row[0] is n and all(c.get("class") == role
                     and c.get("package") == XHS_PACKAGE and c.get("enabled") == "true"
                     and c.get("visible-to-user") != "false" and bounds(c) for c, role in zip(row, roles))
                     and row[1] in copies and row[4] in copies
                     and row[1].get("clickable") == "true" and row[2].get("clickable") == "false"
                     and row[3].get("clickable") == "true" and row[4].get("clickable") == "false"
                     and row[2].get("text") == "|"
                     and re.fullmatch(r"IP属地[:：]\S{1,24}", row[3].get("text", "")))
            if exact:
                boxes = [bounds(c) for c in row]
                exact = (all(pb[0] <= b[0] < b[2] <= pb[2] and pb[1] <= b[1] < b[3] <= pb[3]
                             and abs(b[1]-nb[1]) <= max(b[3]-b[1], nb[3]-nb[1])/2 for b in boxes)
                         and all(a[2] <= b[0] for a,b in zip(boxes,boxes[1:])))
            copies = [row[1]] if exact else []
        if (not pb or len(copies) != 1 or not (pb[0] <= nb[0] < nb[2] <= pb[2]
                and pb[1] <= nb[1] < nb[3] <= pb[3])):
            raise ElementListReadError("account identity unproven: header geometry invalid")
        cb = bounds(copies[0])
        if not (nb[2] <= cb[0] < cb[2] <= pb[2] and pb[1] <= cb[1] < cb[3] <= pb[3]):
            raise ElementListReadError("account identity unproven: copy role geometry invalid")
        candidates.append(match.group(1))
    if len(candidates) != 1:
        raise ElementListReadError("account identity unproven: header ID not unique")
    return candidates[0]


def profile_edit_entry(root, current, events):
    """Only a proven own profile whose header genuinely omits the public ID."""
    try:
        profile_header_identity(root, current, events)
    except ElementListReadError as error:
        if str(error) != "account identity unproven: header ID not unique":
            raise
    else:
        raise ElementListReadError("account identity unproven: editor fallback is unnecessary")
    if any(re.fullmatch(r"小红书号\s*[:：]\s*[A-Za-z0-9_-]{3,64}", n.get("text", "").strip())
           for n in live_nodes(root)):
        raise ElementListReadError("account identity unproven: ambiguous visible header cannot use editor fallback")
    nodes = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
             and n.get("class") == "android.widget.TextView" and n.get("text") == "编辑主页"
             and n.get("enabled") == "true" and n.get("visible-to-user") != "false"]
    if len(nodes) != 1:
        raise ElementListReadError("account identity unproven: own editor entry not unique")
    parents = {n: parent for parent in root.iter() for n in parent}
    node = nodes[0]; parent = parents.get(node); b = bounds(node)
    if (parent is None or parent.get("package") != XHS_PACKAGE
            or parent.get("class") != "android.widget.LinearLayout" or parent.get("enabled") != "true"
            or parent.get("clickable") != "true" or parent.get("visible-to-user") == "false"):
        raise ElementListReadError("account identity unproven: own editor entry roles invalid")
    pb = bounds(parent)
    tab_top = min(bounds(n)[1] for n in live_nodes(root) if n.get("package") == XHS_PACKAGE and n.get("text") in ("笔记", "收藏"))
    if not pb or not (pb[0] <= b[0] < b[2] <= pb[2] and pb[1] <= b[1] < b[3] <= pb[3] < tab_top):
        raise ElementListReadError("account identity unproven: own editor entry geometry invalid")
    return b, pb


def profile_editor_identity(root, current, events):
    """Read an ID row in the editor opened by our own exact profile entry."""
    assert_requested_foreground(current, events)
    if not re.search(r"com\.xingin\.xhs/com\.xingin\.reactnative\.ui\.XhsReactActivity(?:[}\s]|$)", current):
        raise ElementListReadError("account identity unproven: expected profile editor activity")
    nodes = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
             and n.get("enabled") == "true" and n.get("visible-to-user") != "false"]
    if any("EditText" in n.get("class", "") and n.get("focused") == "true" for n in nodes):
        raise ElementListReadError("account identity unproven: an editor input is focused")
    title = [n for n in nodes if n.get("class") == "android.widget.TextView" and n.get("text") == "编辑资料"]
    labels = [n for n in nodes if n.get("class") == "android.widget.TextView" and n.get("text") == "小红书号"]
    if len(title) != 1 or len(labels) != 1 or bounds(title[0])[3] >= bounds(labels[0])[1]:
        raise ElementListReadError("account identity unproven: editor header or ID row ambiguous")
    parents = {n: parent for parent in root.iter() for n in parent}; label_node = labels[0]; row = parents.get(label_node)
    if (row is None or row.get("package") != XHS_PACKAGE or row.get("class") != "android.view.ViewGroup"
            or row.get("enabled") != "true" or row.get("clickable") != "true"
            or row.get("visible-to-user") == "false" or not bounds(row)):
        raise ElementListReadError("account identity unproven: editor ID row roles invalid")
    candidates = [n for n in row if n in nodes and n.get("class") == "android.widget.TextView"
                  and re.fullmatch(r"[A-Za-z0-9_-]{3,64}", n.get("text", ""))]
    if len(candidates) != 1:
        raise ElementListReadError("account identity unproven: editor ID value not unique")
    value_node = candidates[0]; lb, vb, rb = bounds(label_node), bounds(value_node), bounds(row)
    if not (rb[0] <= lb[0] < lb[2] <= vb[0] < vb[2] <= rb[2]
            and rb[1] <= lb[1] < lb[3] <= rb[3] and rb[1] <= vb[1] < vb[3] <= rb[3]
            and abs(lb[1]-vb[1]) <= max(lb[3]-lb[1], vb[3]-vb[1]) / 2):
        raise ElementListReadError("account identity unproven: editor ID value geometry invalid")
    return value_node.get("text")


def identity_proof(args, expected, visible, hashes, method):
    return {"method": method, "serial": args.serial, "app_slot": args.app_slot,
            "configured_id": expected, "visible_public_id": visible, "matches_exactly": visible == expected,
            "sample_count": 2, "sample_xml_sha256": hashes,
            "verified_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "scope": "Visible public ID; not server-side immutable account authentication"}


def settle_identity_transition(args, guard, events, surface):
    """Only read focus while an already-owned editor transition settles.

    A null focus is unproven, not evidence of a different XHS slot. Other
    applications are never relaunched or dismissed by this bounded wait.
    """
    from xhs_native_window import foreground_identity
    activities={"editor":"com.xingin.reactnative.ui.XhsReactActivity",
                "profile":"com.xingin.xhs.index.v2.IndexActivityV2"}
    if surface not in activities:
        raise ValueError("unsupported identity transition")
    for attempt in range(6):
        guard();current=focus(args.adb,args.serial)
        windows=re.findall(r"(?m)^\s*mCurrentFocus=Window\{[^\n}]*\}",current)
        if len(windows)>1:
            raise ElementListReadError("account identity unproven: ambiguous foreground during transition")
        if windows:
            identity=foreground_identity(current)
            if identity is None:
                raise ElementListReadError("account identity unproven: transition interrupted by foreign foreground")
            assert_requested_foreground(current,events)
            if identity[2]==activities[surface]:
                return current
            if identity[2] not in activities.values():
                raise ElementListReadError("account identity unproven: unsupported transitional activity")
        if attempt<5:
            events.append("identity_focus_wait:"+surface+":"+str(attempt+1))
            time.sleep(.4)
    raise ElementListReadError("account identity unproven: requested foreground transition did not settle")


def read_profile_editor_identity(args, root, current, guard, events, expected):
    """Read-only fallback for the observed enterprise header; never type/save."""
    from xhs_native_window import same_foreground
    box = profile_edit_entry(root, current, events)
    guard()
    fresh = native_window_capture(args.adb,args.serial,current,guard,list(events))
    if profile_edit_entry(fresh,current,events) != box or not same_foreground(current,focus(args.adb,args.serial)):
        raise ElementListReadError("account identity unproven: own editor entry changed")
    guard()
    x1,y1,x2,y2 = box[0]
    adb(args.adb,args.serial,"shell","input","tap",str((x1+x2)//2),str((y1+y2)//2),timeout=7)
    events.append("account_identity_editor_opened_read_only")
    values = []; hashes = []; proven_editor = None; returned = None
    try:
        for _ in range(2):
            time.sleep(.5); active = settle_identity_transition(args,guard,events,"editor")
            assert_requested_foreground(active,events)
            proven_editor = None
            editor = native_window_capture(args.adb,args.serial,active,guard,list(events))
            guard()
            if not same_foreground(active,focus(args.adb,args.serial)):
                raise ElementListReadError("account identity unproven: editor foreground changed during read")
            value = profile_editor_identity(editor,active,events)
            proven_editor = active
            values.append(value); hashes.append(hashlib.sha256(ET.tostring(editor,encoding="utf-8")).hexdigest())
        if values[0] != values[1]:
            raise ElementListReadError("account identity unproven: editor ID changed between reads")
        proof = identity_proof(args,expected,values[0],hashes,"own_profile_editor_public_id_two_fresh_native_reads")
    finally:
        if proven_editor is not None:
            guard()
            if not same_foreground(proven_editor,focus(args.adb,args.serial)):
                raise ElementListReadError("account identity unproven: editor changed before Back")
            adb(args.adb,args.serial,"shell","input","keyevent","4",timeout=7)
            time.sleep(.5); active = settle_identity_transition(args,guard,events,"profile")
            assert_requested_foreground(active,events)
            returned = native_window_capture(args.adb,args.serial,active,guard,list(events))
            try:
                visible = profile_header_identity(returned,active,events)
            except ElementListReadError as error:
                if str(error) != "account identity unproven: header ID not unique":raise
                profile_edit_entry(returned,active,events)
            else:
                if values and visible != values[-1]:
                    raise ElementListReadError("account identity unproven: returned profile ID changed")
            events.append("account_identity_editor_returned_to_own_profile")
    args.verified_account_identity = proof
    events.append("account_identity:verified_editor_public_id_two_reads")
    return returned


def requested_account_id(device, slot):
    accounts = [a for a in device.get("xhsAccounts", []) if isinstance(a, dict)
                and a.get("appSlot") == slot and a.get("enabled") is True]
    if len(accounts) != 1 or not re.fullmatch(r"[A-Za-z0-9_-]{3,64}", str(accounts[0].get("xhsId", ""))):
        raise RuntimeError("account identity unproven: unique configured ID required")
    return str(accounts[0]["xhsId"])


def recover_profile_system_dialog(args, current, guard, events):
    """Dismiss an observed owner-profile USB or notification dialog once."""
    if args.app_slot != "app1" or "collection_slot_requested:app1" not in events:
        return None
    specs = {
        "com.android.systemui": (
            "profile_usb_systemui_back",
            (("com.android.systemui:id/usb_select_title_tv", "USB 用于", "TextView"),
             ("com.android.systemui:id/usb_select_list_view", "", "ListView"),
             ("com.android.systemui:id/title", "仅充电", "TextView"),
             ("com.android.systemui:id/title", "传输文件 / Android Auto", "TextView"),
             ("com.android.systemui:id/title", "传输照片", "TextView"))),
        "com.android.settings": (
            "profile_usb_settings_back",
            (("android:id/alertTitle", "USB 连接方式", "TextView"),
             ("android:id/select_dialog_listview", "", "ListView"),
             ("com.android.settings:id/text1", "仅充电", "CheckedTextView"),
             ("com.android.settings:id/text1", "传输文件", "CheckedTextView"),
             ("com.android.settings:id/text1", "传输照片", "CheckedTextView"),
             ("android:id/button2", "取消", "Button"))),
        "com.vivo.pushservice": (
            "profile_vivo_notification_back",
            (("com.vivo.pushservice:id/alertTitle", "确定允许“小红书”发送通知吗？", "TextView"),
             ("com.vivo.pushservice:id/description_title", "通知可能包括：桌面角标、悬浮通知、锁屏通知等，可前往“设置”中进行更改。", "TextView"),
             ("android:id/button1", "", "Button"),
             ("android:id/button2", "", "Button"),
             ("com.vivo.pushservice:id/vbutton_title", "允许", "TextView"),
             ("com.vivo.pushservice:id/vbutton_title", "取消", "TextView"))),
    }
    windows = re.findall(r"mCurrentFocus=Window\{[^\n}]+\}", current)
    if len(windows) != 1:
        return None
    packages = [p for p in specs if re.search(r"\bu0 " + re.escape(p) + r"(?:[}\s]|$)", windows[0])]
    if len(packages) != 1:
        return None
    package = packages[0]
    event, roles = specs[package]
    index = r"\bu0 com\.xingin\.xhs/(?:com\.xingin\.xhs)?\.index\.v2\.IndexActivityV2(?:[}\s]|$)"

    def state():
        guard()
        dump = adb(args.adb, args.serial, "shell", "dumpsys", "window", timeout=8)
        focused = re.findall(r"mCurrentFocus=Window\{[^\n}]+\}", dump)
        owners = re.findall(r"(?m)^\s*mFocusedApp=(?:ActivityRecord|AppWindowToken)\{[^\n]+", dump)
        return focused, owners

    before = state()
    if before[0] != windows or len(before[1]) != 1 or not re.search(index, before[1][0]):
        return None
    if event in events:
        raise ElementListReadError("profile system dialog recurred after Back")
    def dialog_nodes():
        guard()
        nodes = live_nodes(capture(args.adb, args.serial))
        if not nodes or any(n.get("package") != package for n in nodes):
            return []
        for rid, text, kind in roles:
            matches = [n for n in nodes if n.get("resource-id") == rid
                       and " ".join(n.get("text", "").split()) == text
                       and n.get("class") == "android.widget." + kind
                       and n.get("enabled") == "true" and n.get("visible-to-user") != "false"]
            if len(matches) != 1:
                return []
        return nodes

    if not dialog_nodes():
        return None
    if state() != before:
        raise ElementListReadError("profile system dialog changed before Back")
    guard()
    events.append(event)
    adb(args.adb, args.serial, "shell", "input", "keyevent", "4", timeout=7)
    def returned_profile():
        for _ in range(4):
            time.sleep(.5)
            guard()
            resumed = focus(args.adb, args.serial)
            active = re.findall(r"mCurrentFocus=Window\{[^\n}]+\}", resumed)
            if len(active) == 1 and re.search(index, active[0]):
                assert_requested_foreground(resumed, events)
                return navigation_capture(args.adb, args.serial, guard, events)
            if active and active != windows:
                raise ElementListReadError("profile system dialog dismissal opened an unexpected foreground")
        return None

    returned = returned_profile()
    if returned is not None:
        return returned
    if package == "com.android.settings" and state() == before:
        nodes = dialog_nodes()
        cancel = [n for n in nodes if n.get("resource-id") == "android:id/button2"
                  and n.get("text") == "取消" and n.get("clickable") == "true" and bounds(n)]
        if len(cancel) == 1 and state() == before:
            guard()
            x1, y1, x2, y2 = bounds(cancel[0])
            events.append("profile_usb_settings_cancel_after_back")
            adb(args.adb, args.serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
            returned = returned_profile()
            if returned is not None:
                return returned
    raise ElementListReadError("profile system dialog did not close after Back")


def recover_clone_location_prompt(args, current, guard, events):
    """Back out of the proven clone-only location request without choosing a permission."""
    package = "com.android.permissioncontroller"
    activity = r"com\.android\.permissioncontroller/(?:com\.android\.permissioncontroller)?\.permission\.ui\.GrantPermissionsActivity"
    focused = re.fullmatch(r"mCurrentFocus=Window\{[^}\n]+ u999 " + activity + r"(?: [^}\n]*)?\}", current)
    marker = "clone_profile_location_back_once"
    if (args.app_slot != "app2" or "clone_user_requested:999" not in events
            or "collection_slot_requested:app2" not in events or not focused or marker in events):
        return None

    def read_task():
        guard()
        dump = adb(args.adb, args.serial, "shell", "dumpsys", "window", timeout=8)
        windows = [line.strip() for line in dump.splitlines()
                   if "mCurrentFocus=" in line and "mCurrentFocus=null" not in line]
        record = re.findall(r"(?m)^\s*mFocusedApp=ActivityRecord\{[^}\n]+ u999 "
                            + activity + r" t(\d+)(?:[ }\n])", dump)
        tasks = re.findall(r"(?m)^\s*mPreferredTopFocusableRootTask=Task\{[^}\n]+ #(\d+) "
                           r"type=standard A=999\d+:com\.xingin\.xhs\} U=999 displayId=0(?:\s|$)", dump)
        return windows, record, tasks

    before = read_task()
    if before[0] != [current] or len(before[1]) != 1 or before[1] != before[2]:
        return None
    guard()
    fresh = capture(args.adb, args.serial)
    nodes = live_nodes(fresh)
    if not nodes or any(n.get("package") != package for n in nodes):
        return None
    roles = (("permission_message", "“Ⅱ·小红书”请求访问您的位置信息", "android.widget.TextView", "false"),
             ("permission_allow_foreground_only_button", "使用应用时允许", "android.widget.Button", "true"),
             ("permission_allow_one_time_button", "本次使用时允许", "android.widget.Button", "true"),
             ("permission_deny_button", "禁止", "android.widget.Button", "true"))
    for name, value, cls, clickable in roles:
        matches = [n for n in nodes if n.get("resource-id") == package+":id/"+name
                   and n.get("text") == value and n.get("class") == cls and n.get("clickable") == clickable
                   and n.get("enabled") == "true" and n.get("visible-to-user") != "false"]
        if len(matches) != 1:
            return None
    if read_task() != before:
        raise ElementListReadError("clone location prompt changed before Back")
    guard()
    events.append(marker)
    adb(args.adb, args.serial, "shell", "input", "keyevent", "4", timeout=7)
    for _ in range(4):
        time.sleep(.5)
        guard()
        after = focus(args.adb, args.serial)
        if not after or after == current:
            continue
        assert_requested_foreground(after, events)
        if not re.search(r"\bu999 com\.xingin\.xhs/(?:com\.xingin\.xhs)?\.index\.v2\.IndexActivityV2(?:[}\s]|$)", after):
            raise ElementListReadError("clone location Back did not return to profile")
        return native_window_capture(args.adb, args.serial, after, guard, list(events))
    raise ElementListReadError("clone location prompt stayed foreground after Back")


def release_observed_late_poco(args, current, guard, events):
    """142 owner: its recorded next_app preload restarted Poco after cold start."""
    from xhs_native_window import same_foreground
    marker = "profile_late_poco_release_once"
    if ((args.device_name, args.app_slot) != ("142", "app1")
            or "xhs_cold_started" not in events or marker in events):
        return False
    guard()
    assert_requested_foreground(current, events)
    if not re.search(r"com\.xingin\.xhs/(?:com\.xingin\.xhs)?\.index\.v2\.IndexActivityV2(?:[}\s]|$)", current):
        return False
    maker = adb(args.adb,args.serial,"shell","getprop","ro.product.manufacturer",timeout=8).strip().upper()
    model = adb(args.adb,args.serial,"shell","getprop","ro.product.model",timeout=8).strip()
    if (maker, model) != ("OPPO", "PDYM20"):
        return False
    guard()
    if not same_foreground(current, focus(args.adb,args.serial)):
        raise ElementListReadError("account identity unproven: foreground changed before late Poco release")
    events.append(marker)
    release_idle_poco(args.adb,args.serial,guard,events)
    guard()
    if not same_foreground(current, focus(args.adb,args.serial)):
        raise ElementListReadError("account identity unproven: foreground changed after late Poco release")
    return True


def prove_profile_identity(args, root, guard, events, expected):
    """Two fresh native profile reads before data entry. No account changes."""
    from xhs_native_window import same_foreground
    samples = []; hashes = []; selected = False; backs = 0; retries = 0; chat_backs = 0; dialog_reads = 0
    for _ in range(10):
        guard(); current = focus(args.adb, args.serial)
        resumed = resume_vivo_update_entry(args.adb, args.serial, current, guard, events)
        if resumed is not None:
            root = resumed
            continue
        if not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu\d+\s+com\.xingin\.xhs/", current):
            resumed = recover_profile_system_dialog(args, current, guard, events)
            if resumed is not None:
                root = resumed
                samples.clear()
                hashes.clear()
                continue
            resumed = recover_clone_location_prompt(args, current, guard, events)
            if resumed is not None:
                root = resumed
                samples.clear()
                hashes.clear()
                continue
            if (recover_vivo_store_detail(args.adb,args.serial,root,args.app_slot,current,guard,events)
                    or recover_vivo_browser_permission_redirect(args.adb,args.serial,root,args.app_slot,current,guard,events)
                    or recover_vivo_browser_redirect(args.adb,args.serial,args.app_slot,current,guard,events,root)):
                root = navigation_capture(args.adb,args.serial,guard,events)
                continue
            raise ElementListReadError("account identity unproven: unsupported foreground before profile")
        assert_requested_foreground(current, events)
        if login_activity(current) or login_element_evidence(root, current, events):
            confirm_logged_out(args.adb, args.serial, root, guard, events)
        index = re.search(r"com\.xingin\.xhs/(?:com\.xingin\.xhs\.index\.v2\.IndexActivityV2|"
                          r"\.index\.v2\.IndexActivityV2)(?:[}\s]|$)", current)
        if index:
            try:
                # A header proof uses the native reader locally; it must not
                # switch the established stock/fallback reader for every list page.
                fresh = native_window_capture(args.adb, args.serial, current, guard, list(events))
            except RuntimeError as error:
                if (str(error) == "PocoService is active on this phone; collection stopped"
                        and release_observed_late_poco(args,current,guard,events)):
                    samples.clear(); hashes.clear()
                    continue
                root_missing = "native elements command failed: native_elements_unproven:IllegalStateException:native root missing"
                if (selected and isinstance(error, CleanNativeRootUnavailable) and str(error) == root_missing
                        and "identity_native_root_recheck_once" not in events):
                    # This exact normal-exit rejection has returned through the
                    # fixed helper's disconnect and temporary-file cleanup.
                    # Discard all samples; read again once on the same profile
                    # component without repeating the profile action.
                    guard()
                    time.sleep(.5)
                    after = focus(args.adb, args.serial)
                    assert_requested_foreground(after, events)
                    if not same_foreground(current, after):
                        raise ElementListReadError("account identity unproven: profile changed after missing native root") from error
                    samples.clear(); hashes.clear()
                    events.append("identity_native_root_recheck_once")
                    continue
                if retries >= 2 or str(error) not in {
                        "native elements foreground changed before staging", "native elements foreground changed before read",
                        "native elements foreground changed during read"}:
                    raise
                retries += 1; time.sleep(.5); continue
            guard(); after = focus(args.adb, args.serial)
            if not same_foreground(current, after):
                raise ElementListReadError("account identity unproven: profile foreground changed")
            root = fresh
            # The index Activity may expose login controls only in this newer
            # native tree. Confirm two fresh matching trees before classifying
            # logout; missing profile tabs alone remain unproven identity.
            if login_element_evidence(root, after, events):
                root = confirm_logged_out(args.adb, args.serial, root, guard, events)
                continue
            own = [n for n in root.iter("node") if n.get("package") == XHS_PACKAGE
                   and n.get("content-desc") == "我" and n.get("selected") == "true"]
            if len(own) != 1:
                def profile_overlay_guard():
                    guard()
                    if not same_foreground(current, focus(args.adb, args.serial)):
                        raise ElementListReadError("account identity unproven: foreground changed before overlay dismissal")
                if recover_known_overlay(args.adb, args.serial, root, profile_overlay_guard, events):
                    # A newly exposed known sheet can hide the footer after
                    # the profile action. Close only its existing proven path,
                    # then require two new ID reads without replaying that action.
                    samples.clear(); hashes.clear()
                    root = navigation_capture(args.adb, args.serial, guard, events)
                    events.append("identity_fresh_overlay_recovered")
                    continue
                if selected:
                    raise ElementListReadError("account identity unproven: profile selection did not settle")
                native_index_navigation("profile", args.adb, args.serial, guard, events)
                selected = True; time.sleep(.5); continue
            try:
                visible = profile_header_identity(root, current, events)
            except ElementListReadError as error:
                if str(error) != "account identity unproven: header ID not unique":raise
                return read_profile_editor_identity(args,root,current,guard,events,expected)
            samples.append(visible)
            hashes.append(hashlib.sha256(ET.tostring(root, encoding="utf-8")).hexdigest())
            if len(samples) == 2:
                if samples[0] != samples[1]:
                    raise ElementListReadError("account identity unproven: profile ID changed between reads")
                proof = identity_proof(args,expected,visible,hashes,"own_profile_public_id_two_fresh_native_reads")
                args.verified_account_identity = proof
                events.append("account_identity:verified_public_id_two_reads")
                return root
            time.sleep(.5); continue
        known_dialog = re.search(r"com\.xingin\.xhs/(?:com\.xingin\.update\.UpdateDialogActivity|"
                                 r"com\.xingin\.authorization\.NotificationAuthorizationTranslucentActivity|"
                                 r"\.authorization\.NotificationAuthorizationTranslucentActivity)(?:[}\s]|$)", current)
        if known_dialog:
            if dialog_reads >= 2:
                raise ElementListReadError("account identity unproven: known dialog roles did not settle")
            guard(); root = navigation_capture(args.adb,args.serial,guard,events); dialog_reads += 1
            events.append("identity_known_dialog_fresh_read")
            after = focus(args.adb,args.serial); assert_requested_foreground(after,events)
            if not same_foreground(current,after):
                time.sleep(.5); continue
            if recover_known_overlay(args.adb,args.serial,root,guard,events):
                root = navigation_capture(args.adb,args.serial,guard,events)
            else:
                time.sleep(.5)
            continue
        if xhs_chat_activity(current):
            if any(n.get("package") == XHS_PACKAGE and "EditText" in n.get("class", "")
                   and (n.get("text") or "").strip() not in ("", "请友善发言...")
                   and not ((n.get("text") or "").strip() in ("发消息…", "发消息或按住说话...")
                            and n.get("focused") == "false") for n in live_nodes(root)):
                raise RuntimeError("restored chat has unsent text; collection stopped")
            if close_restored_ai_page(args.adb,args.serial,root,current,guard,events):
                root = navigation_capture(args.adb,args.serial,guard,events)
                continue
            if chat_backs >= 2:
                raise ElementListReadError("account identity unproven: restored chat did not close")
            guard()
            if focus(args.adb,args.serial) != current:
                raise ElementListReadError("account identity unproven: restored chat foreground changed")
            adb(args.adb,args.serial,"shell","input","keyevent","4",timeout=7)
            chat_backs += 1; events.append("identity_restored_chat_back")
            root = navigation_capture(args.adb,args.serial,guard,events)
            continue
        known_creator = re.search(r"com\.xingin\.xhs/com\.xingin\.reactnative\.ui\.XhsReactActivity(?:[}\s]|$)", current) and label(root, "创作中心")
        known_data = works_webview_activity(current) and label(root, "数据中心")
        if backs < 2 and (known_creator or known_data):
            guard()
            if focus(args.adb, args.serial) != current:
                raise ElementListReadError("account identity unproven: return surface changed")
            adb(args.adb, args.serial, "shell", "input", "keyevent", "4", timeout=7)
            backs += 1; time.sleep(.5)
        elif not recover_known_overlay(args.adb, args.serial, root, guard, events):
            raise ElementListReadError("account identity unproven: no supported route to own profile")
        root = navigation_capture(args.adb, args.serial, guard, events)
    raise ElementListReadError("account identity unproven: native profile read budget exhausted")


def require_current_account_binding(args, expected):
    device = assert_idle(args.device_cache, args.serial, args.device_name, args.task_id, args.app_slot, args.cancel_file)
    if requested_account_id(device, args.app_slot) != expected:
        raise RuntimeError("account identity unproven: configured binding changed during collection")


def collect_once(args):
    device = assert_idle(args.device_cache, args.serial, args.device_name, args.task_id, args.app_slot, args.cancel_file)
    if adb(args.adb, args.serial, "get-state", timeout=6).strip() != "device":
        raise RuntimeError("target ADB transport is not online")
    guard = lambda: assert_idle(args.device_cache, args.serial, args.device_name, args.task_id, args.app_slot, args.cancel_file)
    accounts = [a for a in device.get("xhsAccounts", []) if isinstance(a, dict)
                and a.get("appSlot") == args.app_slot and a.get("enabled")]
    if not accounts:
        raise RuntimeError("requested Xiaohongshu app slot is not enabled")
    expected_identity = requested_account_id(device, args.app_slot)
    events = ["collection_window_days:" + str(args.days), "collection_reader:ui_elements_only"]
    if getattr(args, "verification_pass", False):
        events.append("collection_verification_pass")
        events.extend(["data_center_loading_reopen:budget_carried"] * getattr(args, "used_loading_reopens", 0))
    else:
        events.extend(["data_center_loading_reopen:budget_carried"] * getattr(args, "prior_loading_reopens", 0))
    entry_started = time.monotonic()
    root = verification_entry(args, guard, events) if getattr(args, "verification_pass", False) else None
    if root is None:
        release_idle_poco(args.adb, args.serial, guard, events)
        root = start_xhs(args.adb, args.serial, args.app_slot, guard, events)
        root = enter_creator_with_slot_retry(args, root, guard, events, expected_identity)
    else:
        proof = getattr(args, "verified_account_identity", {})
        if ((proof.get("serial"), proof.get("app_slot"), proof.get("configured_id"), proof.get("sample_count"))
                != (args.serial, args.app_slot, expected_identity, 2)
                or not re.fullmatch(r"[A-Za-z0-9_-]{3,64}", proof.get("visible_public_id") or "")):
            raise ElementListReadError("account identity unproven: reused list lacks primary identity proof")
        events.append("account_identity:reused_same_slot_list_proof")
    verify_collection_slot(args.adb, args.serial, args.app_slot, events)
    events.append("collection_entry_ms:" + str(round((time.monotonic() - entry_started) * 1000)))
    newest_started = time.monotonic()
    root = wait_creator_content(args.adb, args.serial,
                                reopen_creator_list(args.adb, args.serial, root, guard, events, args.app_slot), guard, events)
    verify_newest_element_position(root)
    root = prove_native_list_start(args.adb, args.serial, root, guard, events)
    events.append("collection_newest_ready_ms:" + str(round((time.monotonic() - newest_started) * 1000)))
    as_of = dt.datetime.now(SHANGHAI).date()
    events.append("collection_scan_as_of:" + as_of.isoformat())
    # Include today as the first calendar date in the requested day count.
    cutoff = as_of - dt.timedelta(days=args.days - 1)
    result = {"schema_version": 3, "source": "xhs_creator_center_works_analysis_list",
              "serial": args.serial, "device_name": args.device_name, "app_slot": args.app_slot,
              "account_bound": True, "account_identity": dict(args.verified_account_identity),
              "captured_at": dt.datetime.now(dt.timezone.utc).isoformat(),
              "window_days": args.days, "window_start_date": cutoff.isoformat(),
              "window_end_date": as_of.isoformat(), "stop_reason": None,
              "list_scope_raw": next((n.get("text") for n in live_nodes(root)
                                      if (n.get("text") or "").startswith("仅统计")), None),
              "notes": [], "scrolls": 0, "complete": False, "recovery_events": events,
              "scan_rounds": [], "warnings": ["creator_account_status_abnormal_observed"]
                  if "creator_account_status_abnormal_observed" in events else []}
    seen = {}
    stagnant = 0
    previous_top_date = None
    date_order_valid = True
    fast_probe_attempted = False
    fast_pair = False
    page_read_ms = 0
    fast_pages = 0
    if not NATIVE_PAIR_PROBE_ENABLED:
        events.append("native_pair_probe_disabled_pending_validation")
    for round_index in range(args.max_scrolls + 1):
        assert_idle(args.device_cache, args.serial, args.device_name, args.task_id, args.app_slot, args.cancel_file)
        assert_no_poco(args.adb, args.serial)
        if not creator_list(root):
            raise RuntimeError("works-analysis list changed unexpectedly")
        require_element_tree(root)
        if element_page_signature(root, allow_duplicate_rows=True) is None:
            raise ElementListReadError("works-analysis element rows are incomplete")
        if ("list_metric_units_are_displayed_approximations" not in result["warnings"]
                and any(COUNT.fullmatch(n.get("text","").strip())
                        and n.get("text","").strip().endswith(("万","亿")) for n in live_nodes(root))):
            result["warnings"].append("list_metric_units_are_displayed_approximations")
        discovered = 0
        cards = note_cards(root)
        card_dates = [published_date(item["published_at_raw"], as_of) for _, item in cards]
        identities = [note_identity(item)
                      for (_, item), date in zip(cards, card_dates) if date >= cutoff]
        if len(set(identities)) != len(identities):
            raise ElementListReadError("visible in-window element rows have ambiguous duplicate title/date")
        if any(later > earlier for earlier, later in zip(card_dates, card_dates[1:])):
            date_order_valid = False
        if card_dates and previous_top_date is not None and card_dates[0] > previous_top_date:
            date_order_valid = False
        if any(date > as_of for date in card_dates):
            date_order_valid = False
        if not date_order_valid:
            result["stop_reason"] = "date_order_unproven"
            break
        if card_dates:
            previous_top_date = card_dates[0]
        empty, bottom = proven_list_terminal(root)
        bottom = bottom or empty
        older_visible = bool(card_dates and min(card_dates) < cutoff)
        try:
            verify_history_extension([note_identity(v) for v in result["notes"]],
                                     root, as_of, cutoff, terminal=older_visible or bottom)
        except ElementListReadError as error:
            events.append("works_elements_scan_stopped:" + str(error))
            result["stop_reason"] = "elements_unproven"
            result["warnings"].append("elements_unproven")
            break
        for _, item in cards:
            identity = note_identity(item)
            if identity in seen:
                saved = seen[identity]
                if saved is not None:
                    for field in ("list_view_count", "list_like_count", "list_comment_count"):
                        if item[field] is not None and saved[field] is None:
                            saved[field] = item[field]
                continue
            discovered += 1
            note_date = published_date(item["published_at_raw"], as_of)
            if note_date >= cutoff:
                item["published_date"] = note_date.isoformat()
                item["note_id"] = None
                result["notes"].append(item)
                seen[identity] = item
            else:
                seen[identity] = None
        result["scan_rounds"].append({"round": round_index, "visible_cards": len(cards),
                                      "new_cards": discovered, "end_marker": bottom,
                                      "older_than_window_visible": older_visible,
                                      "top_date": card_dates[0].isoformat() if card_dates else None})
        if older_visible and date_order_valid:
            result["complete"] = True
            result["stop_reason"] = "older_than_window_visible"
            break
        if bottom and result["scrolls"] >= args.min_scrolls:
            result["complete"] = True
            result["stop_reason"] = "list_end_visible"
            break
        stagnant = stagnant + 1 if discovered == 0 else 0
        if stagnant >= args.stagnant_rounds:
            result["stop_reason"] = "list_stagnant"
            break
        if round_index >= args.max_scrolls:
            result["stop_reason"] = "scroll_budget_exhausted"
            break
        if not fast_probe_attempted and NATIVE_PAIR_PROBE_ENABLED:
            fast_probe_attempted = True
            probe_started = time.monotonic()
            fast_pair = probe_element_pair(args.adb, args.serial, root, guard, events)
            events.append("native_pair_probe_ms:" + str(round((time.monotonic() - probe_started) * 1000)))
        swipe(args.adb, args.serial, root, guard, events)
        result["scrolls"] += 1
        previous_root = root
        reading_started = time.monotonic()
        try:
            root, used_pair, fast_pair = read_scrolled_content(args.adb, args.serial, previous_root, guard, events, fast_pair)
            fast_pages += int(used_pair)
            verify_element_overlap(previous_root, root)
        except ElementListReadError as error:
            events.append("works_elements_scan_stopped:" + str(error))
            result["stop_reason"] = "elements_unproven"
            result["warnings"].append("elements_unproven")
            break
        finally:
            page_read_ms += round((time.monotonic() - reading_started) * 1000)
    if not result["complete"]:
        result["warnings"].append("recent_window_not_proven")
    if not date_order_valid:
        result["warnings"].append("date_order_unproven")
    if any(any(note[field] is None for field in ("list_view_count", "list_like_count", "list_comment_count"))
           for note in result["notes"]):
        result["warnings"].append("some_list_metrics_not_visible")
    if result["list_scope_raw"]:
        result["warnings"].append("creator_list_limited_to_displayed_time_range")
    if not result["account_bound"]:
        result["warnings"].append("app_slot_has_no_bound_xhs_account")
    events.extend(["scan_page_read_ms:" + str(page_read_ms), "native_pair_fast_pages:" + str(fast_pages)])
    require_current_account_binding(args, expected_identity)
    return result


def verify_duplicate_window_reverse(args, first, boundary_stop):
    """Audit ambiguous-title posts upwards without regenerating image signatures.

    Every newly observed row must occupy its exact place in the primary ordered
    identity list. Reverse seams, the old-date/end boundary and the actual top
    are all proven from fresh elements. Never accept a count-only match.
    """
    guard = lambda: assert_idle(args.device_cache, args.serial, args.device_name,
                               args.task_id, args.app_slot, args.cancel_file)
    as_of = dt.date.fromisoformat(first["window_end_date"])
    cutoff = dt.date.fromisoformat(first["window_start_date"])
    events = ["collection_verification_pass", "collection_verification_reverse_same_list",
              "collection_scan_as_of:" + as_of.isoformat()]
    root = verification_entry(args, guard, events)
    if root is None:
        raise ElementListReadError("duplicate verification requires the same live works list")
    root = wait_creator_content(args.adb, args.serial, root, guard, events)
    expected = [note_identity(n) for n in first["notes"]]
    if not expected or len(set(expected)) != len(expected):
        raise ElementListReadError("duplicate verification primary identities are ambiguous")
    positions = {identity: index for index, identity in enumerate(expected)}
    observed = {}
    second = dict(first, complete=False, notes=[], scrolls=0, recovery_events=events,
                  warnings=[], stop_reason="verification_unproven")
    previous = None
    stagnant = 0
    budget = min(args.max_scrolls * 2 + 3, first["scrolls"] * 2 + 6)
    for step in range(budget + 1):
        guard()
        current = focus(args.adb, args.serial)
        assert_requested_foreground(current, events)
        if not works_webview_activity(current) or not creator_list(root) or creator_filter_panel(root):
            raise ElementListReadError("reverse verification left the works list")
        require_creator_service_available(root)
        if element_page_signature(root, allow_duplicate_rows=True) is None:
            raise ElementListReadError("reverse verification elements are incomplete")
        cards = note_cards(root)
        dates = [published_date(n["published_at_raw"], as_of) for _, n in cards]
        if any(d > as_of for d in dates) or any(b > a for a, b in zip(dates, dates[1:])):
            raise ElementListReadError("reverse verification date order changed")
        if step == 0:
            empty, bottom = proven_list_terminal(root)
            if not ((boundary_stop == "older_than_window_visible" and any(d < cutoff for d in dates))
                    or (boundary_stop == "list_end_visible" and bottom and not empty)):
                raise ElementListReadError("reverse verification lower boundary changed")
        if previous is not None:
            verify_element_overlap(root, previous)
        items = [dict(n, published_date=d.isoformat()) for (_, n), d in zip(cards, dates) if cutoff <= d <= as_of]
        ids = [note_identity(n) for n in items]
        if any(identity not in positions for identity in ids) or len(set(ids)) != len(ids):
            raise ElementListReadError("reverse verification found a new or ambiguous identity")
        indices = [positions[identity] for identity in ids]
        if indices and indices != list(range(indices[0], indices[0] + len(indices))):
            raise ElementListReadError("reverse verification skipped or reordered a post")
        before = len(observed)
        for index, item in zip(indices, items):
            observed.setdefault(index, item)
        if observed and sorted(observed) != list(range(min(observed), len(expected))):
            raise ElementListReadError("reverse verification is missing the known tail")
        stagnant = stagnant + 1 if len(observed) == before and previous is not None else 0
        if len(observed) == len(expected):
            verify_newest_element_position(root)
            root = prove_native_list_start(args.adb, args.serial, root, guard, events)
            top = [note_identity(n) for _, n in note_cards(root)
                   if cutoff <= published_date(n["published_at_raw"], as_of) <= as_of]
            if not top or top != expected[:len(top)]:
                raise ElementListReadError("reverse verification newest identities changed")
            scope = next((n.get("text") for n in live_nodes(root) if (n.get("text") or "").startswith("仅统计")), None)
            if scope != first["list_scope_raw"]:
                raise ElementListReadError("reverse verification list scope changed")
            second.update(complete=True, notes=[observed[i] for i in range(len(expected))], stop_reason=boundary_stop)
            events.append("verification_reverse_completed")
            return second
        if step == budget or stagnant >= 3:
            raise ElementListReadError("reverse verification did not reach every post and the top")
        previous = root
        swipe(args.adb, args.serial, root, guard, events, reverse=True)
        second["scrolls"] += 1
        guard()
        current = focus(args.adb, args.serial)
        assert_requested_foreground(current, events)
        root = navigation_capture(args.adb, args.serial, guard, events)
        guard()
        if focus(args.adb, args.serial) != current:
            raise ElementListReadError("reverse verification foreground changed during read")
        root = refresh_scrolled_webview(args.adb, args.serial, root, guard, events, previous)
        root = wait_creator_content(args.adb, args.serial, root, guard, events)
        events.append("verification_fresh_page_accepted")
    raise ElementListReadError("reverse verification budget exhausted")


def ordered_identity_coverage(previous, current):
    """Every previously observed unique post must be independently reread in order."""
    index = 0
    for identity in current:
        if index < len(previous) and identity == previous[index]:
            index += 1
    return index == len(previous)


def collection_account_key(result):
    proof = result.get("account_identity")
    if proof is None:
        return None
    return tuple(proof[k] for k in ("serial", "app_slot", "configured_id", "visible_public_id"))


def recover_integrity_mismatch(args, first, second):
    # One extra *pair*, never concatenate old notes or choose a count-only match.
    # The CLI enables one attempt; recursion explicitly removes that budget.
    if getattr(args, "integrity_retries", 0) != 1:
        return first
    fields = ("app_slot", "window_start_date", "window_end_date", "list_scope_raw")
    if any(first[k] != second[k] for k in fields):
        return first
    identities = lambda r: [(n["title"], n["published_date"]) for n in r["notes"]]
    observed = [identities(first), identities(second)]
    if any(len(set(values)) != len(values) for values in observed):
        return first  # Rotating cover text cannot prove duplicate identity across reloads.
    retry_args = argparse.Namespace(**vars(args))
    retry_args.integrity_retries = 0
    retry_args.verification_pass = False
    retry_args.prior_loading_reopens = max(data_center_reopen_count(r["recovery_events"]) for r in (first, second))
    first["recovery_events"].insert(0, "collection_integrity_recovery:attempted_once")
    try:
        recovered = collect(retry_args)
    except ElementListReadError as error:
        first["recovery_events"].insert(0, "collection_integrity_recovery:elements_unproven")
        return first
    fresh = identities(recovered)
    if (not recovered["complete"] or len(set(fresh)) != len(fresh)
            or collection_account_key(recovered) != collection_account_key(first)
            or any(first[k] != recovered[k] for k in fields)
            or not all(ordered_identity_coverage(values, fresh) for values in observed)):
        first["recovery_events"].insert(0, "collection_integrity_recovery:coverage_or_pair_unproven")
        return first
    evidence = [e for e in first["recovery_events"] if e.startswith(("collection_primary_count:",
                "collection_verification_count:", "collection_primary_sha256:", "collection_verification_sha256:",
                "collection_verification_stop:"))]
    recovered["recovery_events"][0:0] = ["collection_integrity_recovery:verified_after_mismatch"] + [
        "prior_" + e for e in evidence]
    status_warning="creator_account_status_abnormal_observed"
    if any(status_warning in r.get("recovery_events",[]) for r in (first,second)):
        if status_warning not in recovered["recovery_events"]:recovered["recovery_events"].append(status_warning)
        if status_warning not in recovered["warnings"]:recovered["warnings"].append(status_warning)
    return recovered


def public_list_audit_events(ordered_identities):
    """A digest the formal API can verify after clipping titles to 180 UTF-16 units."""
    projected = [(title.encode("utf-16-le")[:356].decode("utf-16-le", "ignore"), *key)
                 for title, *key in ordered_identities]
    if len(set(projected)) != len(projected) or projected == ordered_identities:
        return []
    digest = hashlib.sha256(json.dumps(projected, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    return ["collection_public_identity:prefix178_utf16_v1", "collection_public_sha256:" + digest]


def collect(args):
    """Only two complete ordered element audits may succeed."""
    first = collect_once(args)
    if not first["complete"]:
        return first
    # Never serialize a provisional pass as complete if verification fails.
    first["complete"] = False
    first_stop = first["stop_reason"]
    first["stop_reason"] = "verification_unproven"
    verification_args = argparse.Namespace(**vars(args))
    verification_args.verification_pass = True
    verification_args.verified_entry_events = tuple(first["recovery_events"])
    verification_args.used_loading_reopens = data_center_reopen_count(first["recovery_events"])
    started = time.monotonic()
    title_dates = [(n["title"], n["published_date"]) for n in first["notes"]]
    duplicate_titles = len(set(title_dates)) != len(title_dates)
    try:
        if duplicate_titles:
            duplicate_keys = {key for key in title_dates if title_dates.count(key) > 1}
            if any(not n.get("element_cover_sha256") for n in first["notes"]
                   if (n["title"], n["published_date"]) in duplicate_keys):
                raise ElementListReadError("duplicate-title posts lack distinct cover elements")
            second = verify_duplicate_window_reverse(verification_args, first, first_stop)
        else:
            second = collect_once(verification_args)
    except ElementListReadError as error:
        first["recovery_events"].insert(0, "collection_verification_error:" + str(error))
        first["warnings"].append("verification_elements_unproven")
        first["recovery_events"].insert(0, "collection_integrity:verification_elements_unproven")
        return first
    if collection_account_key(first) != collection_account_key(second):
        first["warnings"].append("account_identity_changed_between_collection_passes")
        first["recovery_events"].insert(0, "collection_integrity:account_changed_between_passes")
        return first
    status_warning="creator_account_status_abnormal_observed"
    if status_warning in second.get("recovery_events",[]):
        if status_warning not in first["recovery_events"]:first["recovery_events"].append(status_warning)
        if status_warning not in first["warnings"]:first["warnings"].append(status_warning)
    identities = lambda result: [note_identity(n, normalized_date=True) if duplicate_titles else (n["title"], n["published_date"]) for n in result["notes"]]
    a, b = identities(first), identities(second)
    digest = lambda values: hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    # The existing public API retains only the first 100 events. Keep the
    # final completeness evidence ahead of verbose per-page observations.
    if duplicate_titles:
        first["recovery_events"].insert(0, "collection_identity_schema:title_date_cover_sha256_v1")
    first["recovery_events"][0:0] = [
        "collection_primary_sha256:" + digest(a), "collection_verification_sha256:" + digest(b),
        "collection_primary_count:" + str(len(a)), "collection_verification_count:" + str(len(b)),
        "collection_verification_scrolls:" + str(second["scrolls"]),
        "collection_verification_ms:" + str(round((time.monotonic() - started) * 1000)),
        "collection_verification_fresh_pages:" + str(second["recovery_events"].count("verification_fresh_page_accepted")),
        "collection_verification_fallback_pages:" + str(second["recovery_events"].count("verification_page_stability_fallback")),
        "collection_verification_entry_reused:" + str("verification_existing_list_reused" in second["recovery_events"]).lower(),
        "collection_verification_direction:" + ("reverse_same_list" if duplicate_titles else "forward_reopened"),
        "collection_verification_stop:" + str(second["stop_reason"])]
    # Counts/status may legitimately change during the second pass. Identity,
    # order, scope and the proven boundary must not be inferred from a union.
    valid_stops = {"older_than_window_visible", "list_end_visible"}
    if (not second["complete"] or first_stop not in valid_stops or second["stop_reason"] not in valid_stops
            or a != b or len(set(a)) != len(a)
            or any(first[k] != second[k] for k in ("app_slot", "window_start_date", "window_end_date", "list_scope_raw"))):
        first["warnings"].append("two_pass_identity_or_boundary_unproven")
        first["recovery_events"].insert(0, "collection_integrity:two_pass_mismatch")
        # Preserve the rejected second pass's actual reason (the API keeps only
        # 100 events). One fresh *pair* can repair a transient complete-tree or
        # seam rejection, but still must cover every old identity in order.
        rejected = [e for e in second["recovery_events"] if e.startswith("works_elements_scan_stopped:")]
        first["recovery_events"][1:1] = ["verification_"+e for e in rejected[-1:]]
        element_rejection = second["stop_reason"] == "elements_unproven" and bool(rejected)
        if first_stop in valid_stops and (second["complete"] and second["stop_reason"] in valid_stops or element_rejection):
            return recover_integrity_mismatch(args, first, second)
        return first
    if "account_identity" in first:
        require_current_account_binding(args, first["account_identity"]["configured_id"])
        if first["account_identity"].get("matches_exactly") is False:
            first["recovery_events"].insert(0, "account_identity:configured_id_mismatch_collected_current_slot")
    first["complete"] = True
    first["stop_reason"] = first_stop
    first["recovery_events"][0:0] = ["collection_integrity:verified_two_pass"] + public_list_audit_events(a)
    return first


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--protocol", action="version", version="xhs_data_collect_v1")
    parser.add_argument("--serial", required=True)
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--device-name", required=True)
    parser.add_argument("--device-cache", required=True)
    parser.add_argument("--app-slot", choices=("app1", "app2"), required=True)
    parser.add_argument("--cancel-file", default="", help="Agent cancellation marker checked before each operation")
    parser.add_argument("--task-id", default="", help="Only the matching collection job lock may be shared")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--max-scrolls", type=int, default=60)
    parser.add_argument("--min-scrolls", type=int, default=0)
    parser.add_argument("--stagnant-rounds", type=int, default=3)
    parser.add_argument("--integrity-retries", type=int, choices=(0, 1), default=1,
                        help="At most one fresh two-pass audit after identity mismatch")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not 1 <= args.days <= 180 or not 0 <= args.min_scrolls <= args.max_scrolls <= 100 or not 1 <= args.stagnant_rounds <= 5:
        parser.error("scroll limits are out of range")
    original_timeout = adb(args.adb, args.serial, "shell", "settings", "get", "system",
                           "screen_off_timeout", timeout=8).strip()
    original_proximity = adb(args.adb, args.serial, "shell", "settings", "get", "global",
                             "enable_screen_on_proximity_sensor", timeout=8).strip()
    extended_timeout = False
    proximity_disabled = False
    try:
        if original_timeout.isdigit() and int(original_timeout) < 600000:
            assert_idle(args.device_cache, args.serial, args.device_name, args.task_id, args.app_slot, args.cancel_file)
            adb(args.adb, args.serial, "shell", "settings", "put", "system",
                "screen_off_timeout", "600000", timeout=8)
            extended_timeout = True
        if original_proximity == "1":
            guard = lambda: assert_idle(args.device_cache, args.serial, args.device_name, args.task_id, args.app_slot, args.cancel_file)
            # Clear the sensor overlay before the normal startup lock check.
            wake_if_asleep(args.adb, args.serial, guard, [], dismiss_lock=False)
            if "ScreenOnProximitySensorGuide" in focus(args.adb, args.serial):
                guard()
                adb(args.adb, args.serial, "shell", "settings", "put", "global",
                    "enable_screen_on_proximity_sensor", "0", timeout=8)
                proximity_disabled = True
                # The setting change itself can remove the guide. Observe its
                # settled state before sending the otherwise unnecessary key.
                for _ in range(3):
                    if "ScreenOnProximitySensorGuide" not in focus(args.adb, args.serial):break
                    time.sleep(.3)
                if "ScreenOnProximitySensorGuide" in focus(args.adb, args.serial):
                    guard()
                    adb(args.adb, args.serial, "shell", "input", "keyevent", "24", timeout=7)
                wake_if_asleep(args.adb, args.serial, guard, [], dismiss_lock=False)
                if "ScreenOnProximitySensorGuide" in focus(args.adb, args.serial):
                    raise RuntimeError("proximity guard stayed open")
        result = collect(args)
        if proximity_disabled:
            result["recovery_events"].append("proximity_guard_temporarily_disabled")
    finally:
        if proximity_disabled:
            adb(args.adb, args.serial, "shell", "settings", "put", "global",
                "enable_screen_on_proximity_sensor", original_proximity, timeout=8)
        if extended_timeout:
            adb(args.adb, args.serial, "shell", "settings", "put", "system",
                "screen_off_timeout", original_timeout, timeout=8)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, output)
    print(json.dumps({"output": str(output), "notes": len(result["notes"]),
                      "complete": result["complete"], "scrolls": result["scrolls"],
                      "warnings": result["warnings"]}, ensure_ascii=False))
    return 0 if result["complete"] else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
