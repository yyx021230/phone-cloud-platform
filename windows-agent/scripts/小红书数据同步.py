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
    if re.search(r"com\.xingin\.xhs/com\.xingin\.login\.device\.offline\.DeviceOfflineRemindActivity(?:[}\s]|$)", current):
        raise RuntimeError("Xiaohongshu account is logged out; manual login is required")
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


def assert_requested_foreground(current, events):
    slots = {e.split(":", 1)[1] for e in events if e.startswith("collection_slot_requested:")}
    users = {e.split(":", 1)[1] for e in events if e.startswith("clone_user_requested:")}
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






def native_window_capture(adb_path, serial, current, guard, events):
    from xhs_native_window import read
    assert_requested_foreground(current, events)
    assert_no_poco(adb_path, serial)
    root = read(adb_path, serial, adb_process, lambda: focus(adb_path, serial), guard, current)
    require_element_tree(root)
    if "native_window_elements_enabled" not in events:
        events.append("native_window_elements_enabled")
    return root


def navigation_capture(adb_path, serial, guard, events):
    # Once stock export fails, use the complete native reader on this WebView.
    # Every read still proves foreground user, occupancy and native node identity.
    if "native_window_elements_enabled" in events:
        current = focus(adb_path, serial)
        if works_webview_activity(current):
            return native_window_capture(adb_path, serial, current, guard, events)
    try:
        root = capture(adb_path, serial)
    except (RuntimeError,subprocess.TimeoutExpired) as error:
        current = focus(adb_path, serial)
        if (not current and (isinstance(error,subprocess.TimeoutExpired)
                             or "did not return an XML hierarchy" in str(error))
                and wake_focusless_display(adb_path, serial, guard, events)):
            return capture(adb_path, serial)
        if login_activity(current):
            assert_requested_foreground(current, events)
            raise RuntimeError("Xiaohongshu account is logged out; manual login is required") from error
        notification = re.search(
            r"com\.xingin\.xhs/(?:com\.xingin\.authorization\.NotificationAuthorizationTranslucentActivity|"
            r"\.authorization\.NotificationAuthorizationTranslucentActivity)(?:[}\s]|$)", current)
        if works_webview_activity(current) and (isinstance(error,subprocess.TimeoutExpired)
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
            if ("creator_more_selected" in events and "works_native_more_recovery_attempted" not in events
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


def focus(adb_path, serial):
    output = adb(adb_path, serial, "shell", "dumpsys", "window", timeout=8)
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
            adb(adb_path, serial, "shell", "input", "swipe", str(width//2), str(height*85//100),
                str(width//2), str(height*30//100), "350", timeout=7)
            swiped = True
        if attempt == 7:
            raise RuntimeError("unsecured keyguard stayed visible after dismissal")
        time.sleep(.5)
    events.append("unsecured_keyguard_dismissed")
    return True


def verify_collection_slot(adb_path, serial, slot, events):
    requested = [event.split(":", 1)[1] for event in events if event.startswith("clone_user_requested:")]
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
    user_args = ("--user", clone_user) if clone_user else ()
    guard()
    adb(adb_path, serial, "shell", "am", "start", "-W", *user_args, "-n", activity, timeout=20)
    return capture_vivo_startup_retry(adb_path, serial, slot, clone_user, guard, events)


def start_xhs(adb_path, serial, slot, guard, events):
    """Cold-start the app and choose only the caller's explicit clone slot."""
    guard()
    marker = "collection_slot_requested:" + slot
    if marker not in events:events.append(marker)
    adb(adb_path, serial, "shell", "input", "keyevent", "224", timeout=7)
    # Vivo reports the old unlocked state briefly while its screen wakes.
    # Inspect the settled lock before the generic asynchronous dismissal.
    time.sleep(.7)
    dismiss_unsecured_keyguard(adb_path, serial, guard, events)
    adb(adb_path, serial, "shell", "wm", "dismiss-keyguard", timeout=7)
    if f"package:{XHS_PACKAGE}" not in adb(adb_path, serial, "shell", "pm", "list", "packages", XHS_PACKAGE):
        raise RuntimeError("Xiaohongshu is not installed on this phone")
    clone_user = explicit_clone_user(adb_path, serial) if slot == "app2" else None
    user_args = ("--user", clone_user) if clone_user else ()
    resolved = adb(adb_path, serial, "shell", "cmd", "package", "resolve-activity", "--brief", *user_args, XHS_PACKAGE)
    activity = next((line.strip() for line in reversed(resolved.splitlines())
                     if "/" in line and " " not in line), f"{XHS_PACKAGE}/.index.v2.IndexActivityV2")
    guard()
    adb(adb_path, serial, "shell", "am", "force-stop", *user_args, XHS_PACKAGE, timeout=8)
    events.append("xhs_cold_started")
    guard()
    adb(adb_path, serial, "shell", "am", "start", "-W", *user_args, "-n", activity, timeout=20)
    if clone_user:
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


def recover_known_overlay(adb_path, serial, root, guard, events):
    """Use only exact, previously evidenced QR/publish dismissal paths."""
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

    if ("NotificationAuthorizationTranslucentActivity" in current or
            ("com.vivo.pushservice" in current and "type=2038" in current)):
        if "creator_late_notification_retry" in events:
            raise ElementListReadError("notification overlay recurred after bounded navigation recovery")
        press_back()
        if "NotificationAuthorizationTranslucentActivity" in focus(adb_path, serial):
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
            raise RuntimeError("Vivo update overlay stayed open after defer")
        events.append("vivo_update_deferred")
        return True

    honor_package = "com.hihonor.ouc"
    honor_focus = bool(re.search(r"\bcom\.hihonor\.ouc(?:[}/\s]|$)", current))
    if honor_focus or any(node.get("package") == honor_package for node in nodes):
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
        if re.search(r"\bcom\.hihonor\.ouc(?:[}/\s]|$)", focus(adb_path, serial)):
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
                          "分享喜悦，获得更多人的关注💗", "去记录在小红书留下的每一步👣"))
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


def creator_more_label(root):
    return next((value for value in ("更多", "更多笔记") if label(root, value)), "")


def open_works_tab(adb_path, serial, root, guard, events, expected_foreground=None):
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
    adb(adb_path, serial, "shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2), timeout=7)
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
    current = focus(adb_path, serial)
    assert_requested_foreground(current, events)
    if not re.search(r"com\.xingin\.xhs/(?:com\.xingin\.xhs\.index\.v2\.IndexActivityV2|\.index\.v2\.IndexActivityV2)(?:[}\s]|$)", current):
        raise ElementListReadError("native navigation requires the requested XHS index page")
    assert_no_poco(adb_path, serial)
    perform(action, adb_path, serial, adb_process, lambda: focus(adb_path, serial), guard, current)
    events.append("native_accessibility_action:" + action)


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
        if not recover_known_overlay(adb_path, serial, fresh, notification_guard, events):
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
    """The observed empty full-screen WebView with a small central spinner."""
    nodes = live_nodes(root)
    if not nodes or any(n.get("package") != XHS_PACKAGE or n.get("text", "").strip()
                        or n.get("content-desc", "").strip() for n in nodes):
        return False
    width = max(bounds(n)[2] for n in nodes)
    height = max(bounds(n)[3] for n in nodes)
    views = [n for n in nodes if n.get("class") == "android.webkit.WebView"
             and n.get("enabled") == "true" and bounds(n) == (0, 0, width, height)
             and not list(n)]
    spinners = [bounds(n) for n in nodes if n.get("class") == "android.widget.ImageView"
                and n.get("clickable") == "false" and n.get("enabled") == "true"]
    if len(views) != 1 or len(spinners) != 1:return False
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
    if label(center, "账号异常"):
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
    chat_backs = 0
    server_refreshes = 0
    states = []
    for _ in range(6 if _notification_retry else 14):
        states.append(creator_navigation_state(root))
        if wake_if_asleep(adb_path, serial, guard, events):
            root = navigation_capture(adb_path, serial, guard, events)
        if any(event.startswith("clone_user_requested:") for event in events):
            current = focus(adb_path, serial)
            if re.search(r"\bu\d+\s+com\.xingin\.xhs/", current):
                verify_collection_slot(adb_path, serial, slot, events)
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
        if ((label(root, "数据中心") and not creator_overview_entry(root))
                or (more_attempts and blank_works_loading(root))):
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
            raise RuntimeError("creator account shows abnormal status; collection skipped")
        if recoveries < 3 and recover_known_overlay(adb_path, serial, root, guard, events):
            recoveries += 1
            root = navigation_capture(adb_path, serial, guard, events)
            continue
        current = focus(adb_path, serial)
        if recover_vivo_store_update(adb_path,serial,root,slot,current,guard,events):
            root = navigation_capture(adb_path,serial,guard,events)
            continue
        if recover_vivo_browser_permission_redirect(adb_path,serial,root,slot,current,guard,events):
            root=navigation_capture(adb_path,serial,guard,events)
            continue
        if recover_vivo_browser_redirect(adb_path,serial,slot,current,guard,events,root):
            root = navigation_capture(adb_path,serial,guard,events)
            continue
        if login_activity(current):
            assert_requested_foreground(current, events)
            raise RuntimeError("Xiaohongshu account is logged out; manual login is required")
        if (label(root, "登录后展示自己") and label(root, "微信登录")
                and (label(root, "手机号登录") or (label(root, "一键登录") and label(root, "其他登录方式")))
                and re.search(r"mCurrentFocus=Window\{[^\n}]*\bu\d+\s+com\.xingin\.xhs/(?:com\.xingin\.xhs\.index\.v2\.IndexActivityV2|\.index\.v2\.IndexActivityV2)[}\s]", current)):
            assert_requested_foreground(current, events)
            raise RuntimeError("Xiaohongshu account is logged out; manual login is required")
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
        elif label(root, "创作中心") and label(root, "最新笔记") and creator_more_label(root):
            if more_attempts >= 2 and label(root, "账号异常"):
                raise RuntimeError("creator account abnormal; More did not open works analysis")
            tap_label(adb_path, serial, root, creator_more_label(root), guard)
            events.append("creator_more_selected")
            more_attempts += 1
            time.sleep(1)
        elif creator_overview_entry(root):
            tap_label(adb_path, serial, root, "观看", guard)
            events.append("creator_overview_opened_without_latest_notes")
            time.sleep(0.8)
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
        if recover_known_overlay(adb_path, serial, root, notification_guard, events):
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
    if label(root, "创作中心") and label(root, "最新笔记") and creator_more_label(root):
        tap_label(adb_path, serial, root, creator_more_label(root), guard)
    elif creator_overview_entry(root):
        tap_label(adb_path, serial, root, "观看", guard)
        events.append("creator_overview_reopened")
        root = navigation_capture(adb_path, serial, guard, events)
        root = ensure_creator_list(adb_path, serial, root, slot, guard, events)
        events.append("list_reopened_at_newest")
        return root
    else:
        raise RuntimeError("could not prove list returned to Creator Center")
    events.append("list_reopened_at_newest")
    return navigation_capture(adb_path, serial, guard, events)


def is_note_status(text):
    return text.startswith("笔记状态") or text in ("笔记审核中", "该篇笔记已不可被他人查看", "该篇笔记已不被推荐给未关注用户")


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
        cards.append((node, {"title": title, "published_at_raw": date, "status_raw": status,
                             "list_view_count": values[0] if len(values) > 0 else None,
                             "list_like_count": values[1] if len(values) > 1 else None,
                             "list_comment_count": values[2] if len(values) > 2 else None}))
    return cards


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


def element_page_signature(root, allow_duplicate_rows=False):
    """Prove complete visible element rows, excluding only clipped edge rows."""
    require_element_tree(root)
    if not creator_list(root) or creator_filter_panel(root):return None
    cards = note_cards(root)
    if not cards:
        return ((),bool(label(root,"暂无笔记")),bool(label(root,"到底了"))) if label(root,"暂无笔记") or label(root,"到底了") else None
    # Window-aware callers retain every row, then reject ambiguous identities
    # inside the requested window. Other callers keep the strict default.
    identities = [(item["title"], item["published_at_raw"]) for _, item in cards]
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
    return (tuple((v["title"],v["published_at_raw"],v["status_raw"],v["list_view_count"],v["list_like_count"],v["list_comment_count"]) for _,v in cards),
            bool(label(root,"暂无笔记")),bool(label(root,"到底了")))


def verify_newest_element_position(root):
    cards = note_cards(root)
    filters = label(root,"全部笔记")
    views = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
             and n.get("class") == "android.webkit.WebView" and n.get("text") == "数据中心"]
    if cards and len(filters) == len(views) == 1:
        top = bounds(filters[0])[3];width = bounds(views[0])[2]-bounds(views[0])[0]
        raw = structured_note_cards(root)
        if (any(bounds(n)[1] < top for n,_ in raw)
                or not top <= bounds(cards[0][0])[1] <= top+width*.12):
            raise ElementListReadError("newest list position is not proven by elements")


def verify_element_overlap(previous_root, root):
    previous = {(v["title"],v["published_at_raw"]) for _,v in note_cards(previous_root)}
    raw = structured_note_cards(root) or flat_webview_cards(root)
    current = {(v["title"],v["published_at_raw"]) for _,v in raw}
    if previous and not previous.intersection(current):
        raise ElementListReadError("element page continuity is unproven after scroll")


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
    if label(center, "账号异常"):
        raise RuntimeError("creator account shows abnormal status; collection skipped")
    more = creator_more_label(center)
    if label(center, "创作中心") and label(center, "最新笔记") and more:
        entry = "观看" if blank_works_loading(root) and creator_overview_entry(center) else more
    elif creator_overview_entry(center):
        entry = "观看"
    else:
        raise ElementListReadError("loading retry did not return to proven Creator Center")
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
                assert_requested_foreground(current, events)
                if login_activity(current):
                    raise RuntimeError("Xiaohongshu account is logged out; manual login is required")
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
                    selected = open_works_tab(adb_path, serial, root, guard, events, expected_foreground=current)
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


def swipe(adb_path, serial, root, guard, events):
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
    if step <= 0:
        raise ElementListReadError("native row geometry cannot prove a scroll distance")
    end_y = max(y1+1, start_y-step)
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
        previous = [(n[1]["title"], n[1]["published_at_raw"]) for n in note_cards(previous_root)]
        current_cards = [(n[1]["title"], n[1]["published_at_raw"]) for n in note_cards(root)]
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
            raise RuntimeError("Xiaohongshu account is logged out; manual login is required")
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
    from xhs_native_window import NativePairUnavailable
    if fast_pair:
        try:
            trees = capture_element_pair(adb_path, serial, guard, events)
        except NativePairUnavailable:
            fast_pair = False
            events.append("native_pair_disabled_after_rejection")
        else:
            signature = stable_pair_signature(trees)
            previous = {(v["title"], v["published_at_raw"]) for _, v in note_cards(previous_root)}
            current = {(v["title"], v["published_at_raw"]) for _, v in note_cards(trees[1])}
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


def collect(args):
    device = assert_idle(args.device_cache, args.serial, args.device_name, args.task_id, args.app_slot, args.cancel_file)
    if adb(args.adb, args.serial, "get-state", timeout=6).strip() != "device":
        raise RuntimeError("target ADB transport is not online")
    guard = lambda: assert_idle(args.device_cache, args.serial, args.device_name, args.task_id, args.app_slot, args.cancel_file)
    accounts = [a for a in device.get("xhsAccounts", []) if isinstance(a, dict)
                and a.get("appSlot") == args.app_slot and a.get("enabled")]
    if not accounts:
        raise RuntimeError("requested Xiaohongshu app slot is not enabled")
    events = ["collection_window_days:" + str(args.days), "collection_reader:ui_elements_only"]
    entry_started = time.monotonic()
    release_idle_poco(args.adb, args.serial, guard, events)
    root = start_xhs(args.adb, args.serial, args.app_slot, guard, events)
    root = ensure_creator_list(args.adb, args.serial, root, args.app_slot, guard, events)
    verify_collection_slot(args.adb, args.serial, args.app_slot, events)
    events.append("collection_entry_ms:" + str(round((time.monotonic() - entry_started) * 1000)))
    newest_started = time.monotonic()
    root = wait_creator_content(args.adb, args.serial,
                                reopen_creator_list(args.adb, args.serial, root, guard, events, args.app_slot), guard, events)
    verify_newest_element_position(root)
    events.append("collection_newest_ready_ms:" + str(round((time.monotonic() - newest_started) * 1000)))
    as_of = dt.datetime.now(SHANGHAI).date()
    events.append("collection_scan_as_of:" + as_of.isoformat())
    # Include today as the first calendar date in the requested day count.
    cutoff = as_of - dt.timedelta(days=args.days - 1)
    result = {"schema_version": 3, "source": "xhs_creator_center_works_analysis_list",
              "serial": args.serial, "device_name": args.device_name, "app_slot": args.app_slot,
              "account_bound": any(a.get("xhsId") for a in accounts),
              "captured_at": dt.datetime.now(dt.timezone.utc).isoformat(),
              "window_days": args.days, "window_start_date": cutoff.isoformat(),
              "window_end_date": as_of.isoformat(), "stop_reason": None,
              "list_scope_raw": next((n.get("text") for n in live_nodes(root)
                                      if (n.get("text") or "").startswith("仅统计")), None),
              "notes": [], "scrolls": 0, "complete": False, "recovery_events": events,
              "scan_rounds": [], "warnings": []}
    seen = {}
    stagnant = 0
    previous_top_date = None
    date_order_valid = True
    fast_probe_attempted = False
    fast_pair = False
    page_read_ms = 0
    fast_pages = 0
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
        identities = [(item["title"], item["published_at_raw"])
                      for (_, item), date in zip(cards, card_dates) if date >= cutoff]
        if len(set(identities)) != len(identities):
            raise ElementListReadError("visible in-window element rows have ambiguous duplicate title/date")
        if any(later > earlier for earlier, later in zip(card_dates, card_dates[1:])):
            date_order_valid = False
        if card_dates and previous_top_date is not None and card_dates[0] > previous_top_date:
            date_order_valid = False
        if card_dates:
            previous_top_date = card_dates[0]
        for _, item in cards:
            identity = (item["title"], item["published_at_raw"])
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
        bottom = bool(label(root, "到底了"))
        if label(root, "暂无笔记"):
            bottom = True
        older_visible = bool(card_dates and min(card_dates) < cutoff)
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
        if not fast_probe_attempted:
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
    return result


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
