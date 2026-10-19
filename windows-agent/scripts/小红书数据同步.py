#!/usr/bin/env python3
"""Collect visible Xiaohongshu Creator Center note list from one idle phone.

Navigation: 我 -> 菜单 -> 创作者中心 -> 最新笔记/更多 -> 作品分析.
This bounded probe reads list cards without opening notes. It writes a local
JSON snapshot only and does not publish, change accounts, or write to the Web
database. The list is reopened at its newest note and scanned for the last
30 days (or the configured window), not all history.
An exact unfinished-note prompt is handled by saving the existing draft,
as authorized by the user, before continuing navigation.
"""

import argparse
import base64
import datetime as dt
import difflib
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
# Only the verified bottom-profile glyph; no phone screenshot/user content.
PROFILE_GLYPH_PNG = "iVBORw0KGgoAAAANSUhEUgAAAC8AAAAwCAAAAACkzHw+AAADH0lEQVR4nM2W/U9SURjHvwgiF4lMUMPAKDWzlnM6cTTzpWzZbNbWmrm1tbV+6j9qa+svqOUP9qZllrPR0tTNZgaCYE1QE5BXu17aOfeFCwLabz4bPM8593Of+z3Pec4FRQr/ZUU4XLwq7xVuKpFgbx2IZ3e0QMoB6PbPzwX9K66jg8VptUF/Q24+uR3eXPPFASQcHVAA5BP8NsvtXMji/f5YNLIeSt863WgQ+Mg8h7ea+kxeN7Ile47JesKkpvmLAPPNZ8DL2+YMvrRzWISZGxUMHxVx4ABY+16DfTWky9BvrVXrdHr9cBjqGvFOTQxJ4s9vORAeHVDKeRVfaKJBMk0MZO2AfdOJ5S/2dMVyWzGAXRIor5aBMWE/Xi3y0F43DVkz9BfmUT3IqwcUpP8dG8LIyUJVJ/K/toE6WT7mspg/sJSeZRflz3DKYuM++nMazV9ZlEtPcA2o1qdRRuLbxaknIZT2i4PFEaCxOSt/AT1aADE+jHMH4BkAET78MC4UtlD9S8kaaOT+jr+9qgL5YwGihwHoxkTGgIWtfPl3A6tun/ZBCVDhRTymBfc+DHRU5OGjj0lTxn40AUYvENJi6idgatm73rh7MgqwfA97hQ0NYt4BMH38+Zfys+u/PR6pMPUnq8lxKietwo0CuEZCiY96vMsJcUJts1QJzVgOYIE8rqcWcn53jBUGHAdG2mww5lV6wtpF8YJ+vY1ExvY7j45krr2GfrddlE1R/c3zJqtZkihZwEW+7XZFNs88FI+PzLi5j0SmxsbjEUaZrk8O3D/hoz7hPU29y39Fmb9/wjPTxOkiwAzPry5udxvy9E9o8inFbfeNwIqbhEknPPN78tMfv+T4Ah1UdlvQ+gaYMGkAHwtYsvszFSEJStrIBabnrgU4awA2R3fAzQEqsyw/Xb6To6fEMPD8T0szOV5QXXoBLAWbAh7gnEZ8/wD49FWn5UjXt3WSu5XCOxp4NytG96pkemq58BrBcYbWRcLRJb4vmggu8WWC7z2eVStVfyv11i7qRD34HGNTymOnDDnKu+7aUJsb+D2V+APaYfv/8A/nYfKVUWstFQAAAABJRU5ErkJggg=="


def adb(adb_path, serial, *args, timeout=12):
    result = subprocess.run(
        [adb_path, "-s", serial, *args], capture_output=True,
        timeout=timeout, check=False,
    )
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
    raise RuntimeError("UIAutomator did not return an XML hierarchy")


class ImageListReadError(RuntimeError):
    pass


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


def image_navigation_capture(adb_path, serial, guard, events, current):
    slots = {e.split(":",1)[1] for e in events if e.startswith("collection_slot_requested:")}
    requested = {e.split(":",1)[1] for e in events if e.startswith("clone_user_requested:")}
    if len(slots) != 1 or not works_webview_activity(current):
        raise RuntimeError("image list reader has no proven collection slot/activity")
    slot = next(iter(slots))
    expected = "0" if slot == "app1" else next(iter(requested)) if len(requested) == 1 else None
    actual = re.search(r"\bu(\d+)\s+com\.xingin\.xhs/",current)
    if (slot not in ("app1","app2") or expected is None or (slot == "app2" and expected not in ("128","999"))
            or actual is None or actual[1] != expected):
        raise RuntimeError("image list reader foreground does not match the requested Android user")
    from xhs_list_ocr import read_works_image, hierarchy_for_frame, WorksListHint
    windows = {e.split(":",1)[1] for e in events if e.startswith("collection_window_days:")}
    as_of_values = {e.split(":",1)[1] for e in events if e.startswith("collection_scan_as_of:")}
    if len(windows) > 1 or len(as_of_values) > 1:raise RuntimeError("image reader collection window is ambiguous")
    days = int(next(iter(windows))) if windows else 30
    if not 1 <= days <= 180:raise RuntimeError("image reader collection window is invalid")
    image_as_of = dt.date.fromisoformat(next(iter(as_of_values))) if as_of_values else dt.datetime.now(SHANGHAI).date()
    cutoff = image_as_of-dt.timedelta(days=days-1)
    frames = []
    for frame_attempt in range(6):
        guard()
        if focus(adb_path,serial) != current:
            raise RuntimeError("image list reader foreground changed")
        screenshot = subprocess.run([adb_path,"-s",serial,"exec-out","screencap","-p"],capture_output=True,timeout=10)
        if screenshot.returncode:
            raise RuntimeError("image list reader screenshot failed")
        try:
            frame = read_works_image(screenshot.stdout,guard,lambda raw:published_date(raw,image_as_of) >= cutoff)
        except WorksListHint as hint:
            if "works_filter_hint_dismissed" in events:
                raise ImageListReadError("works-list filter hint stayed visible") from hint
            guard()
            if focus(adb_path, serial) != current:
                raise RuntimeError("image list reader foreground changed")
            confirmation = subprocess.run([adb_path,"-s",serial,"exec-out","screencap","-p"],capture_output=True,timeout=10)
            if confirmation.returncode:
                raise RuntimeError("image list reader screenshot failed")
            try:
                read_works_image(confirmation.stdout,guard,lambda raw:published_date(raw,image_as_of) >= cutoff)
            except WorksListHint as second:
                if second.box != hint.box:
                    raise ImageListReadError("works-list filter hint moved") from second
            else:
                raise ImageListReadError("works-list filter hint disappeared before confirmation")
            guard()
            if focus(adb_path, serial) != current:
                raise RuntimeError("image list reader foreground changed")
            x1,y1,x2,y2 = hint.box
            adb(adb_path,serial,"shell","input","tap",str((x1+x2)//2),str((y1+y2)//2),timeout=7)
            events.append("works_filter_hint_dismissed")
            time.sleep(.5)
            return image_navigation_capture(adb_path,serial,guard,events,current)
        except (RuntimeError,subprocess.TimeoutExpired) as error:
            guard()
            if str(error).startswith("OCR works-list header is not unique:") and frame_attempt < 5:
                # A bad header read proves no data. Discard the pair and require
                # two later, consecutive fresh captures with every field proven.
                frames.clear()
                events.append("works_image_header_capture_retried")
                time.sleep(.2)
                continue
            raise ImageListReadError(str(error)) from error
        guard()
        if focus(adb_path,serial) != current:
            raise RuntimeError("image list reader foreground changed")
        frames.append(frame)
        if len(frames) == 2:break
    if len(frames) != 2:raise ImageListReadError("image list reader could not prove two consecutive fresh frames")
    def signature(frame):
        if frame.get("navigationOnly"):
            return ("filter",sorted(frame["headers"].items()),sorted(frame["navigationLabels"].items()))
        return ([(c["date"],c["counts"],c["status"],c["imageHint"],
                  re.sub(r"[^\w\u4e00-\u9fff]","",c["title"])) for c in frame["cards"]],
                set(frame["markers"]),frame["leadingClip"],bool(frame.get("trailingClip")),bool(frame.get("scope")))
    if signature(frames[0]) != signature(frames[1]):
        raise ImageListReadError("image list fields changed between two fresh captures")
    if frames[1].get("navigationOnly"):
        return hierarchy_for_frame(frames[1])
    if "works_list_image_reader_active" not in events:
        events.append("works_list_image_reader_active")
    return hierarchy_for_frame(frames[1])


def select_image_profile_after_dump_failure(adb_path,serial,current,guard,events):
    """Use two proven Index bottom bars only when XML is unavailable."""
    if ("image_profile_navigation_selected" in events or not re.search(
            r"mCurrentFocus=Window\{[^\n}]*\bu\d+\s+com\.xingin\.xhs/(?:com\.xingin\.xhs\.index\.v2\.IndexActivityV2|\.index\.v2\.IndexActivityV2)[}\s]",current)):
        raise RuntimeError("image profile navigation is unavailable outside the requested Index page")
    assert_requested_foreground(current,events)
    from xhs_list_ocr import read_profile_navigation
    frames=[]
    for _ in range(2):
        guard()
        if focus(adb_path,serial) != current:raise RuntimeError("image profile foreground changed")
        png=subprocess.run([adb_path,"-s",serial,"exec-out","screencap","-p"],capture_output=True,timeout=10)
        if png.returncode:raise RuntimeError("image profile screenshot failed")
        frames.append(read_profile_navigation(png.stdout,guard))
    if frames[0] != frames[1]:raise RuntimeError("image profile bottom bar changed between captures")
    guard()
    if focus(adb_path,serial) != current:raise RuntimeError("image profile foreground changed")
    x1,y1,x2,y2=frames[1]["labels"]["我"]
    events.append("image_profile_navigation_selected")
    adb(adb_path,serial,"shell","input","tap",str((x1+x2)//2),str((y1+y2)//2),timeout=7)
    time.sleep(.7)
    return navigation_capture(adb_path,serial,guard,events)


def navigation_capture(adb_path, serial, guard, events):
    try:
        root = capture(adb_path, serial)
    except (RuntimeError,subprocess.TimeoutExpired) as error:
        current = focus(adb_path, serial)
        if login_activity(current):
            assert_requested_foreground(current, events)
            raise RuntimeError("Xiaohongshu account is logged out; manual login is required") from error
        notification = re.search(
            r"com\.xingin\.xhs/(?:com\.xingin\.authorization\.NotificationAuthorizationTranslucentActivity|"
            r"\.authorization\.NotificationAuthorizationTranslucentActivity)(?:[}\s]|$)", current)
        if (os.name == "nt" and works_webview_activity(current)
                and (isinstance(error,subprocess.TimeoutExpired) or "did not return an XML hierarchy" in str(error))):
            return image_navigation_capture(adb_path,serial,guard,events,current)
        if (os.name == "nt" and "did not return an XML hierarchy" in str(error)
                and re.search(r"mCurrentFocus=Window\{[^\n}]*\bu\d+\s+com\.xingin\.xhs/(?:com\.xingin\.xhs\.index\.v2\.IndexActivityV2|\.index\.v2\.IndexActivityV2)[}\s]",current)):
            return select_image_profile_after_dump_failure(adb_path,serial,current,guard,events)
        if "did not return an XML hierarchy" not in str(error) or not notification:
            raise
        guard()
        adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
        time.sleep(0.4)
        events.append("inaccessible_notification_prompt_back")
        return capture(adb_path, serial)
    if creator_filter_panel(root):
        return root
    if (os.name == "nt" and (creator_list(root) or data_center_tab_header(root))
            and ("works_list_image_reader_active" in events or not note_cards(root))
            and not label(root,"暂无笔记")):
        current = focus(adb_path,serial)
        if works_webview_activity(current):
            try:
                return image_navigation_capture(adb_path,serial,guard,events,current)
            except ImageListReadError as error:
                # A valid XML tab may arrive before its body finishes loading.
                # Keep the existing bounded wait; blank never proves zero notes.
                if note_cards(root) or label(root,"到底了"):
                    raise
                marker = "works_image_probe_unproven:" + str(error)
                if marker not in events:events.append(marker)
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
    return [n for n in root.iter("node") if bounds(n) and
            bounds(n)[2] > bounds(n)[0] and bounds(n)[3] > bounds(n)[1]]


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


def wake_if_asleep(adb_path, serial, guard, events):
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
    dismiss_unsecured_keyguard(adb_path,serial,guard,events)
    events.append("screen_woken_after_timeout")
    return True


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
    root = navigation_capture(adb_path, serial, guard, events)
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

    def press_back():
        guard()
        adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
        time.sleep(0.4)

    if ("NotificationAuthorizationTranslucentActivity" in current or
            ("com.vivo.pushservice" in current and "type=2038" in current)):
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
                          "分享喜悦，获得更多人的关注💗"))
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
    if label(root, "数据中心") and label(root, "作品分析") and label(root, "全部笔记"):
        return True
    # Some WebViews scroll their header off-screen but retain the same
    # data-center WebView and exact tab/filter fields in its hierarchy.
    views = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
             and n.get("class") == "android.webkit.WebView" and n.get("text") == "数据中心"]
    return len(views) == 1 and all(any(n.get("package") == XHS_PACKAGE
                                     and n.get("class") in ("android.widget.TextView", "android.view.View")
                                     and n.get("text") == value
                                     for n in views[0].iter("node")) for value in ("作品分析", "全部笔记"))


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


def open_works_tab(adb_path, serial, root, guard, events):
    """The observed data-center WebView marks its tab label non-clickable."""
    if not (label(root, "数据中心") and label(root, "账号概览") and not label(root, "全部笔记")):
        return False
    if not re.search(r"com\.xingin\.xhs/com\.xingin\.xywebview\.activity\.WebViewActivityV2(?:[}\s]|$)", focus(adb_path, serial)):
        return False
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
    if (len(views) != 1 or not bounds(row) or bounds(tabs[0])[3] > bounds(views[0])[3] * 0.25
            or bounds(row)[3] - bounds(row)[1] > bounds(views[0])[3] * 0.20):
        raise RuntimeError("data-center works tab is outside the header")
    x1, y1, x2, y2 = bounds(tabs[0])
    guard()
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


def profile_glyph_position(png):
    """Match the verified profile glyph only inside the observed footer region."""
    try:
        import cv2
        import numpy as np
    except ImportError as error:
        raise RuntimeError("profile image fallback requires the existing OpenCV runtime") from error
    frame = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    template = cv2.imdecode(np.frombuffer(base64.b64decode(PROFILE_GLYPH_PNG), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if frame is None or template is None or frame.shape[0] < 700 or frame.shape[1] < 400:
        raise RuntimeError("profile image fallback did not receive a usable screenshot")
    height, width = frame.shape
    left, top, bottom = int(width * .80), int(height * .95), int(height * .995)
    region = frame[top:bottom, left:width]
    matches = []
    for step in range(13, 30):
        scale = width / 1080 * step / 20
        glyph = cv2.resize(template, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        gh, gw = glyph.shape
        if gh >= region.shape[0] or gw >= region.shape[1]:
            continue
        for variant in (glyph, 255-glyph):
            scores = cv2.matchTemplate(region, variant, cv2.TM_CCOEFF_NORMED)
            ys, xs = np.where(scores >= .92)
            for y, x in zip(ys, xs):
                matches.append((float(scores[y, x]), left + int(x) + gw//2, top + int(y) + gh//2, max(gw, gh)))
    if not matches:
        raise RuntimeError("profile glyph not proven in the footer screenshot")
    matches.sort(reverse=True)
    best = matches[0]
    if any(abs(m[1]-best[1]) + abs(m[2]-best[2]) > max(m[3], best[3]) for m in matches[1:]):
        raise RuntimeError("profile glyph matches multiple footer locations")
    return best[1], best[2]


def select_zero_bounds_profile(adb_path, serial, root, current, guard, events):
    """140's footer is visible, but all five accessibility bounds are zero."""
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
    screenshot = subprocess.run([adb_path, "-s", serial, "exec-out", "screencap", "-p"], capture_output=True, timeout=10)
    if screenshot.returncode:
        raise RuntimeError("profile image fallback screenshot failed")
    x, y = profile_glyph_position(screenshot.stdout)
    if focus(adb_path, serial) != current:
        raise RuntimeError("profile image fallback foreground changed")
    guard()
    adb(adb_path, serial, "shell", "input", "tap", str(x), str(y), timeout=7)
    time.sleep(.5)
    refreshed = navigation_capture(adb_path, serial, guard, events)
    if any(n.get("text", "").startswith(("恭喜你🎉", "嗨👋今天是你加入小红书的")) for n in live_nodes(refreshed)):
        recover_known_overlay(adb_path, serial, refreshed, guard, events)
        refreshed = navigation_capture(adb_path, serial, guard, events)
    if (not re.search(r"com\.xingin\.xhs/com\.xingin\.xhs\.index\.v2\.IndexActivityV2(?:[}\s]|$)", focus(adb_path, serial))
            or not any(n.get("package") == XHS_PACKAGE and n.get("content-desc") == "我"
                       and n.get("selected") == "true" for n in refreshed.iter("node"))):
        raise RuntimeError("profile image fallback did not confirm the selected personal tab")
    events.append("profile_zero_bounds_image_selected")
    return refreshed


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


def recover_vivo_browser_redirect(adb_path, serial, slot, current, guard, events):
    # 43's owner app cold-start was followed by a Vivo browser activity. Leave
    # that page intact and attempt the known XHS owner activity exactly once.
    if (slot != "app1" or "collection_slot_requested:app1" not in events or "xhs_cold_started" not in events
            or not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+com\.vivo\.browser/com\.vivo\.browser\.BrowserActivity[}\s]", current)):
        return False
    if "vivo_browser_redirect_reopened" in events:
        raise RuntimeError("Xiaohongshu redirected to Vivo browser again; collection stopped")
    guard()
    adb(adb_path,serial,"shell","input","keyevent","3",timeout=7)
    guard()
    events.append("vivo_browser_redirect_reopened")
    adb(adb_path,serial,"shell","am","start","-W","--user","0","-n",XHS_PACKAGE+"/.index.v2.IndexActivityV2",timeout=20)
    time.sleep(.7)
    if not re.search(r"mCurrentFocus=Window\{[^\n}]*\bu0\s+com\.xingin\.xhs/",focus(adb_path,serial)):
        raise RuntimeError("Xiaohongshu owner foreground was not restored after browser redirect")
    return True


def ensure_creator_list(adb_path, serial, root, slot, guard, events):
    recoveries = 0
    more_attempts = 0
    shell_passes = 0
    shell_reopens = 0
    chat_backs = 0
    server_refreshes = 0
    for _ in range(14):
        if wake_if_asleep(adb_path, serial, guard, events):
            root = navigation_capture(adb_path, serial, guard, events)
        if any(event.startswith("clone_user_requested:") for event in events):
            current = focus(adb_path, serial)
            if re.search(r"\bu\d+\s+com\.xingin\.xhs/", current):
                verify_collection_slot(adb_path, serial, slot, events)
        if creator_filter_panel(root):
            tap_filter_label(adb_path,serial,root,"收起",guard)
            events.append("works_filter_panel_collapsed")
            root = navigation_capture(adb_path,serial,guard,events)
            continue
        if creator_list(root):
            return root
        if (label(root, "个人信息保护提示") and any(n.get("package") == XHS_PACKAGE
                and n.get("text", "").startswith("欢迎使用小红书！") for n in root.iter("node"))
                and label(root, "同意") and label(root, "不同意")):
            raise RuntimeError("Xiaohongshu first-use privacy agreement requires manual acceptance")
        if label(root, "服务器出错") and refresh_creator_server_error(adb_path, serial, root, guard, events, server_refreshes):
            server_refreshes += 1
            time.sleep(1)
            root = navigation_capture(adb_path, serial, guard, events)
            continue
        if open_works_tab(adb_path, serial, root, guard, events):
            root = navigation_capture(adb_path, serial, guard, events)
            continue
        if (label(root, "账号异常") and label(root, "开通数据权限")
                and label(root, "创作中心") and not label(root, "最新笔记")):
            # 107 exposes these labels underneath the known growth offer.
            # Reclassify a fresh page only after its proven safe dismissal.
            if (recoveries < 3 and label(root, "解锁成长中心")
                    and recover_known_overlay(adb_path, serial, root, guard, events)):
                recoveries += 1
                root = navigation_capture(adb_path, serial, guard, events)
                continue
            raise RuntimeError("creator account shows abnormal status and no latest-notes entry")
        if label(root, "数据中心") and label(root, "作品分析") and not label(root, "全部笔记"):
            shell_passes += 1
            if shell_passes <= 2:
                time.sleep(0.8)
            elif shell_reopens < 2:
                guard()
                adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
                center = navigation_capture(adb_path, serial, guard, events)
                if not (label(center, "创作中心") and label(center, "最新笔记")
                        and creator_more_label(center)):
                    raise RuntimeError("works-analysis shell could not return to Creator Center")
                tap_label(adb_path, serial, center, creator_more_label(center), guard)
                shell_reopens += 1
                shell_passes = 0
                events.append("works_analysis_shell_reopened")
                time.sleep(0.8)
            else:
                raise RuntimeError("works-analysis WebView remained inaccessible after reopening")
            root = navigation_capture(adb_path, serial, guard, events)
            continue
        if recoveries < 3 and recover_known_overlay(adb_path, serial, root, guard, events):
            recoveries += 1
            root = navigation_capture(adb_path, serial, guard, events)
            continue
        current = focus(adb_path, serial)
        if recover_vivo_browser_permission_redirect(adb_path,serial,root,slot,current,guard,events):
            root=navigation_capture(adb_path,serial,guard,events)
            continue
        if recover_vivo_browser_redirect(adb_path,serial,slot,current,guard,events):
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
            tap_label(adb_path, serial, root, "菜单", guard)
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
            tap_label(adb_path, serial, root, "菜单", guard)
            events.append("index_menu_opened_without_bottom_tab")
        else:
            time.sleep(0.5)
        root = navigation_capture(adb_path, serial, guard, events)
    image_error = next((e for e in reversed(events) if e.startswith("works_image_probe_unproven:")),"")
    raise RuntimeError("could not prove the Creator Center works-analysis path" + ("; " + image_error if image_error else ""))


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
    return text.startswith("笔记状态") or text in ("该篇笔记已不可被他人查看", "该篇笔记已不被推荐给未关注用户")


def note_cards(root):
    if root.get("data-source") == "windows_native_ocr":
        from xhs_list_ocr import cards_from_hierarchy
        return cards_from_hierarchy(root)
    cards = []
    for node in live_nodes(root):
        box = bounds(node)
        if box[2]-box[0] < 400 or not 140 <= box[3]-box[1] <= 320:
            continue
        children = [n for n in node.iter("node") if n in live_nodes(root)]
        texts = [(n.get("text") or "").strip() for n in children]
        if not any(is_note_status(t) for t in texts):
            continue
        title = next(((n.get("text") or "").strip() for n in children
                      if bounds(n)[0] >= box[0] + (box[2]-box[0])*0.20
                      and bounds(n)[1] < box[1] + (box[3]-box[1])*0.38
                      and 1 <= len((n.get("text") or "").strip()) <= 180
                      and not re.fullmatch(r"[0-9a-f]{32,64}", (n.get("text") or "").strip())
                      and not is_note_status(n.get("text") or "")), None)
        date = next((t for t in texts if DATE.fullmatch(t)), None)
        if not title or not date:
            continue
        status = next((t for t in texts if is_note_status(t)), None)
        numbers = sorted((bounds(n)[0], count(n.get("text"))) for n in children
                         if count(n.get("text")) is not None and bounds(n)[1] >= box[1] + (box[3]-box[1])*0.58)
        values = [value for _, value in numbers]
        if len(values) < 3:
            continue
        cards.append((node, {"title": title, "published_at_raw": date, "status_raw": status,
                             "list_view_count": values[0] if len(values) > 0 else None,
                             "list_like_count": values[1] if len(values) > 1 else None,
                             "list_comment_count": values[2] if len(values) > 2 else None}))
    if not cards:
        cards = flat_webview_cards(root)
    return cards


def flat_webview_cards(root):
    """Huawei WebView can expose card fields as direct siblings without rows."""
    if not creator_list(root):
        return []
    webviews = [n for n in live_nodes(root) if n.get("package") == XHS_PACKAGE
                and n.get("class") == "android.webkit.WebView" and n.get("text") == "数据中心"]
    if len(webviews) != 1:
        return []
    groups = []
    for node in webviews[0]:
        text = (node.get("text") or "").strip()
        if DATE.fullmatch(text):
            groups.append([node])
        elif groups and text:
            groups[-1].append(node)
    cards = []
    visible = set(live_nodes(root))
    for group in groups:
        if len(group) != 6 or any(n not in visible or n.get("package") != XHS_PACKAGE
                                  or n.get("class") != "android.widget.TextView" for n in group):
            continue
        date, title, status, *metrics = group
        title_text = (title.get("text") or "").strip()
        status_text = (status.get("text") or "").strip()
        values = [count(n.get("text")) for n in metrics]
        if (not 1 <= len(title_text) <= 180 or DATE.fullmatch(title_text) or count(title_text) is not None
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


def wait_creator_content(adb_path, serial, root, guard, events):
    """A rendered tab header is not proof that its note request has finished."""
    for pass_index in range(2):
        for _ in range(6):
            if wake_if_asleep(adb_path, serial, guard, events):
                root = navigation_capture(adb_path, serial, guard, events)
            if note_cards(root) or label(root, "到底了") or label(root, "暂无笔记"):
                return root
            time.sleep(0.6)
            root = navigation_capture(adb_path, serial, guard, events)
        if pass_index == 0 and creator_list(root):
            # The embedded page occasionally remains blank after loading.
            # Reopen this known page once; never treat blank as zero notes.
            guard()
            adb(adb_path, serial, "shell", "input", "keyevent", "4", timeout=7)
            time.sleep(0.4)
            root = navigation_capture(adb_path, serial, guard, events)
            if label(root, "创作中心") and label(root, "最新笔记") and creator_more_label(root):
                tap_label(adb_path, serial, root, creator_more_label(root), guard)
                root = navigation_capture(adb_path, serial, guard, events)
    image_error = next((e for e in reversed(events) if e.startswith("works_image_probe_unproven:")),"")
    raise RuntimeError("works-analysis note list stayed blank; collection aborted" + ("; " + image_error if image_error else ""))


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
    start_y, end_y = y1 + (y2-y1) * 4 // 5, y1 + (y2-y1) * 3 // 10
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


def recheck_filter_image(adb_path,serial,root,guard,events):
    """A stale accessibility tree cannot prove whether a filter tap opened it."""
    if os.name != "nt":return root
    current=focus(adb_path,serial)
    if not works_webview_activity(current):return root
    actual=image_navigation_capture(adb_path,serial,guard,events,current)
    events.append("works_filter_state_rechecked_by_image")
    return actual


def refresh_scrolled_webview(adb_path, serial, root, guard, events, previous_root=None):
    """Refresh a stale WebView accessibility tree without changing filters."""
    if root.get("data-source") == "windows_native_ocr":
        if not creator_list(root) or not works_webview_activity(focus(adb_path,serial)):
            raise RuntimeError("image works list changed unexpectedly")
        guard()
        return root
    if previous_root is not None and not creator_filter_panel(root) and creator_list(root) and note_cards(root):
        previous = [(n[1]["title"], n[1]["published_at_raw"]) for n in note_cards(previous_root)]
        current_cards = [(n[1]["title"], n[1]["published_at_raw"]) for n in note_cards(root)]
        if (previous and current_cards != previous
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
    if not all(label(expanded, value) for value in ("笔记类型", "发布时间", "排序方式", "收起")):
        expanded=recheck_filter_image(adb_path,serial,expanded,guard,events)
        if (expanded.get("data-source") == "windows_native_ocr" and creator_list(expanded)
                and not label(expanded,"排序方式") and (note_cards(expanded) or label(expanded,"暂无笔记") or label(expanded,"到底了"))):
            events.append("webview_accessibility_refreshed")
            return expanded
        if not all(label(expanded, value) for value in ("笔记类型", "发布时间", "排序方式", "收起")):
            raise RuntimeError("works-analysis filter panel is not proven")
    tap_filter_label(adb_path, serial, expanded, "收起", guard)
    refreshed = navigation_capture(adb_path, serial, guard, events)
    if label(refreshed, "排序方式"):
        refreshed=recheck_filter_image(adb_path,serial,refreshed,guard,events)
    if label(refreshed, "排序方式") or not creator_list(refreshed):
        raise RuntimeError("works-analysis filter panel did not close")
    events.append("webview_accessibility_refreshed")
    return refreshed


def collect(args):
    device = assert_idle(args.device_cache, args.serial, args.device_name, args.task_id, args.app_slot, args.cancel_file)
    if adb(args.adb, args.serial, "get-state", timeout=6).strip() != "device":
        raise RuntimeError("target ADB transport is not online")
    guard = lambda: assert_idle(args.device_cache, args.serial, args.device_name, args.task_id, args.app_slot, args.cancel_file)
    accounts = [a for a in device.get("xhsAccounts", []) if isinstance(a, dict)
                and a.get("appSlot") == args.app_slot and a.get("enabled")]
    if not accounts:
        raise RuntimeError("requested Xiaohongshu app slot is not enabled")
    events = ["collection_window_days:" + str(args.days)]
    release_idle_poco(args.adb, args.serial, guard, events)
    root = start_xhs(args.adb, args.serial, args.app_slot, guard, events)
    root = ensure_creator_list(args.adb, args.serial, root, args.app_slot, guard, events)
    verify_collection_slot(args.adb, args.serial, args.app_slot, events)
    root = wait_creator_content(args.adb, args.serial,
                                reopen_creator_list(args.adb, args.serial, root, guard, events, args.app_slot), guard, events)
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
    image_seen = {}
    scan_source = root.get("data-source","xml")
    newest_page = True
    stagnant = 0
    previous_top_date = None
    date_order_valid = True
    for round_index in range(args.max_scrolls + 1):
        assert_idle(args.device_cache, args.serial, args.device_name, args.task_id, args.app_slot, args.cancel_file)
        assert_no_poco(args.adb, args.serial)
        if not creator_list(root):
            raise RuntimeError("works-analysis list changed unexpectedly")
        if newest_page and root.get("data-leading-clip") == "true":
            raise ImageListReadError("newest image list has an unreadable leading card")
        discovered = 0
        round_image_keys = set()
        cards = note_cards(root)
        card_dates = [published_date(item["published_at_raw"], as_of) for _, item in cards]
        if any(later > earlier for earlier, later in zip(card_dates, card_dates[1:])):
            date_order_valid = False
        if card_dates and previous_top_date is not None and card_dates[0] > previous_top_date:
            date_order_valid = False
        if card_dates:
            previous_top_date = card_dates[0]
        for _, item in cards:
            hint = item.pop("_image_hint",None)
            boundary_only = item.pop("_boundary_only",False)
            if boundary_only and published_date(item["published_at_raw"],as_of) >= cutoff:
                raise ImageListReadError("image date boundary does not match the requested collection window")
            displayed_unit = item.pop("_displayed_unit",False)
            if displayed_unit and "list_metric_units_are_displayed_approximations" not in result["warnings"]:
                result["warnings"].append("list_metric_units_are_displayed_approximations")
            identity = (item["title"], item["published_at_raw"])
            if hint is not None:
                if not re.fullmatch(r"[0-9a-f]{16}",hint):raise ImageListReadError("image overlap hint is unproven")
                values = tuple(item[k] for k in ("list_view_count","list_like_count","list_comment_count"))
                normalized = re.sub(r"[^\w\u4e00-\u9fff]","",item["title"])
                matches = [key for key,(old_hint,old_date,old_values,old_title) in image_seen.items()
                           if old_date == item["published_at_raw"]
                           and bin(int(old_hint,16)^int(hint,16)).count("1") <= 3
                           and difflib.SequenceMatcher(None,normalized,old_title).ratio() >= .94]
                if len(matches) > 1:raise ImageListReadError("image note overlap identity is ambiguous")
                identity = matches[0] if matches else ("image",item["published_at_raw"],hint,normalized)
                if identity in round_image_keys:
                    raise ImageListReadError("two visible image notes have an ambiguous identity")
                round_image_keys.add(identity)
                image_seen[identity] = (hint,item["published_at_raw"],values,normalized)
            if identity in seen:
                saved = seen[identity]
                if saved is not None:
                    for field in ("list_view_count", "list_like_count", "list_comment_count"):
                        if item[field] is not None and (hint is not None or saved[field] is None):
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
        if stagnant >= args.stagnant_rounds or round_index >= args.max_scrolls:
            break
        swipe(args.adb, args.serial, root, guard, events)
        newest_page = False
        result["scrolls"] += 1
        previous_root = root
        try:
            root = refresh_scrolled_webview(args.adb, args.serial, navigation_capture(args.adb, args.serial, guard, events), guard, events, previous_root)
            root = wait_creator_content(args.adb, args.serial, root, guard, events)
        except ImageListReadError as error:
            events.append("works_image_scan_stopped:" + str(error))
            result["stop_reason"] = "image_list_read_unproven"
            result["warnings"].append("image_list_read_unproven")
            break
        if root.get("data-source","xml") != scan_source:
            if scan_source != "xml" or root.get("data-source") != "windows_native_ocr":
                raise RuntimeError("works list reader changed unexpectedly")
            root = wait_creator_content(args.adb,args.serial,reopen_creator_list(args.adb,args.serial,root,guard,events,args.app_slot),guard,events)
            result["notes"].clear();result["scan_rounds"].clear();seen.clear();image_seen.clear()
            scan_source = "windows_native_ocr";stagnant = 0;previous_top_date = None;date_order_valid = True
            newest_page = True
            result["list_scope_raw"] = next((n.get("text") for n in live_nodes(root) if (n.get("text") or "").startswith("仅统计")),None)
            events.append("works_image_scan_restarted_at_newest")
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
    if "works_list_image_reader_active" in events:
        result["warnings"].append("list_read_with_local_image_recognition")
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
    parser.add_argument("--max-scrolls", type=int, default=30)
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
            wake_if_asleep(args.adb, args.serial, guard, [])
            if "ScreenOnProximitySensorGuide" in focus(args.adb, args.serial):
                guard()
                adb(args.adb, args.serial, "shell", "settings", "put", "global",
                    "enable_screen_on_proximity_sensor", "0", timeout=8)
                proximity_disabled = True
                adb(args.adb, args.serial, "shell", "input", "keyevent", "24", timeout=7)
                wake_if_asleep(args.adb, args.serial, guard, [])
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
