#!/usr/bin/env python3
"""Stateless XML UIAutomator runner for known Poco-incompatible phones.

Every action reads the Android UI hierarchy afresh and taps the bounds of the
matching accessibility element.  It deliberately has no Poco dependency and
must be launched only after PocoService has been stopped for the same serial.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import traceback
import xml.etree.ElementTree as ET


def emit(log, step, **detail):
    item = {"step": step, **detail}
    log.append(item)
    print(json.dumps({"event": item}, ensure_ascii=True), flush=True)


def run_adb(adb_path, serial, args, timeout=12, check=True):
    result = subprocess.run(
        [adb_path, "-s", serial, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if check and result.returncode:
        raise RuntimeError(f"adb failed ({result.returncode}): {' '.join(args)} {result.stderr.strip()}")
    return result.stdout


def focus(adb_path, serial):
    try:
        output = run_adb(adb_path, serial, ["shell", "dumpsys", "window"], timeout=8)
        return [line.strip() for line in output.splitlines() if "mCurrentFocus" in line or "mFocusedApp" in line]
    except Exception as exc:
        return [f"focus_error={exc}"]


def wake_and_unlock(adb_path, serial, log):
    run_adb(adb_path, serial, ["shell", "input", "keyevent", "224"], timeout=8)
    time.sleep(0.4)
    run_adb(adb_path, serial, ["shell", "wm", "dismiss-keyguard"], timeout=8, check=False)
    current_focus = "\n".join(focus(adb_path, serial))
    if "VivoUsbDialog" in current_focus:
        run_adb(adb_path, serial, ["shell", "input", "keyevent", "4"], timeout=5)
        emit(log, "dismiss_vivo_usb_dialog")
        time.sleep(0.5)
    emit(log, "device_unlocked")


def dismiss_clone_resolver_overlay_if_present(adb_path, serial, log, focus_lines):
    """Reveal Vivo's clone resolver only when an exact covering window exists."""
    joined = "\n".join(focus_lines)
    if "DoubleAppResolverActivity" not in joined:
        return False
    overlay = ""
    if "com.bbk.updater" in joined:
        overlay = "vivo_system_update"
    elif "VivoUsbDialog" in joined:
        overlay = "vivo_usb_dialog"
    if not overlay:
        return False
    run_adb(adb_path, serial, ["shell", "input", "keyevent", "4"], timeout=5, check=False)
    time.sleep(0.6)
    after = focus(adb_path, serial)
    after_text = "\n".join(after)
    dismissed = "com.bbk.updater" not in after_text and "VivoUsbDialog" not in after_text
    if not dismissed and overlay == "vivo_system_update":
        # Back is ignored by some OriginOS updater builds. Force-stop only this
        # proven covering package; the underlying clone resolver remains alive.
        run_adb(adb_path, serial, ["shell", "am", "force-stop", "com.bbk.updater"], timeout=5, check=False)
        time.sleep(0.6)
        after = focus(adb_path, serial)
        dismissed = "com.bbk.updater" not in "\n".join(after)
    emit(log, "dismiss_clone_resolver_overlay", overlay=overlay, dismissed=dismissed, focus=after)
    return dismissed


def is_xhs_clone_resolver_focus(focus_lines):
    joined = "\n".join(focus_lines)
    return any(marker in joined for marker in (
        "DoubleAppResolverActivity",
        "com.android.intentresolver",
        # MIUI/HyperOS exposes the framework resolver under the android
        # package instead of the vendor-specific resolver package.
        "android/com.android.internal.app.ResolverActivity",
    ))


def require_default_internet_route(adb_path, serial, log):
    destination = "223.5.5.5"
    route = run_adb(adb_path, serial, ["shell", "ip", "route", "get", destination], timeout=6)
    normalized = route.lower()
    if not route or "unreachable" in normalized or "prohibit" in normalized:
        emit(log, "network_route_unavailable", destination=destination, route=route)
        raise RuntimeError("device_network_unavailable: no default internet route")
    emit(log, "network_route_ready", destination=destination, route=route)


def grant_xhs_media_access(adb_path, serial, package_name, log):
    granted = []
    for permission in ["android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VISUAL_USER_SELECTED"]:
        result = run_adb(adb_path, serial, ["shell", "pm", "grant", package_name, permission], timeout=8, check=False)
        granted.append({"permission": permission, "output": result[-240:]})
    emit(log, "grant_xhs_media_access", attempts=granted)


def bounds_center(bounds):
    values = bounds.replace("[", "").replace("]", ",").split(",")
    x1, y1, x2, y2 = [int(value) for value in values[:4]]
    return (x1 + x2) // 2, (y1 + y2) // 2


def dump_ui(adb_path, serial, token):
    remote = f"/sdcard/PhoneCloud/.uia-{token}.xml"
    # Some Vivo builds print a harmless cpu-info permission exception while
    # still writing a valid XML file.  Trust the parsed XML, not dump stderr.
    run_adb(adb_path, serial, ["shell", "mkdir", "-p", "/sdcard/PhoneCloud"], timeout=8)
    run_adb(adb_path, serial, ["shell", "uiautomator", "dump", remote], timeout=15, check=False)
    raw = subprocess.run([adb_path, "-s", serial, "exec-out", "cat", remote], capture_output=True, timeout=12).stdout
    if not raw.strip():
        raise RuntimeError("uiautomator_xml_empty")
    try:
        root = ET.fromstring(raw.decode("utf-8", errors="replace"))
    except ET.ParseError as exc:
        raise RuntimeError(f"uiautomator_xml_invalid: {exc}") from exc
    parent = {child: node for node in root.iter() for child in node}
    return root, parent


def text_values(root):
    values = []
    for node in root.iter("node"):
        for key in ("text", "content-desc"):
            value = (node.get(key) or "").strip()
            if value and value not in values:
                values.append(value)
    return values


def nearest_tappable(node, parent):
    current = node
    while current is not None:
        if current.get("bounds") and current.get("enabled", "true") != "false":
            if current.get("clickable") == "true" or current.get("checkable") == "true":
                return current
        current = parent.get(current)
    return node if node.get("bounds") else None


def find_labeled(root, parent, labels, *, y_min=0, y_max=10_000, tappable=True):
    labels = set(labels)
    for node in root.iter("node"):
        text = (node.get("text") or "").strip()
        desc = (node.get("content-desc") or "").strip()
        if text not in labels and desc not in labels:
            continue
        candidate = nearest_tappable(node, parent) if tappable else node
        if candidate is None or not candidate.get("bounds"):
            continue
        _, y = bounds_center(candidate.get("bounds"))
        if y_min <= y <= y_max:
            return candidate, {"text": text, "desc": desc, "bounds": candidate.get("bounds")}
    return None, None


def tap_element(adb_path, serial, node):
    x, y = bounds_center(node.get("bounds"))
    run_adb(adb_path, serial, ["shell", "input", "tap", str(x), str(y)], timeout=8)
    return x, y


def bounds_size(bounds):
    values = bounds.replace("[", "").replace("]", ",").split(",")
    x1, y1, x2, y2 = [int(value) for value in values[:4]]
    return x2 - x1, y2 - y1


def dismiss_notification_prompt_if_present(adb_path, serial, log):
    current_focus = "\n".join(focus(adb_path, serial))
    exact_vivo_notification_overlay = (
        "com.vivo.pushservice" in current_focus and "type=2038" in current_focus
    )
    if "NotificationAuthorizationTranslucentActivity" not in current_focus and not exact_vivo_notification_overlay:
        return False
    run_adb(adb_path, serial, ["shell", "input", "keyevent", "4"], timeout=5)
    emit(log, "dismiss_notification_prompt_back")
    time.sleep(0.5)
    return True


def close_celebration_popup(adb_path, serial, root, log):
    # Equivalent to Poco's celebration-sheet close: it is used only after the
    # sheet marker is present, then taps the rendered X ImageView element.
    candidates = []
    for node in root.iter("node"):
        if node.get("class") != "android.widget.ImageView" or not node.get("bounds"):
            continue
        x, y = bounds_center(node.get("bounds"))
        width, height = bounds_size(node.get("bounds"))
        if 648 <= x <= 713 and 620 <= y <= 882 and 28 <= width <= 116 and 20 <= height <= 176:
            candidates.append((abs(x - 686) + abs(y - 748), node))
    if not candidates:
        return False
    node = min(candidates, key=lambda item: item[0])[1]
    x, y = tap_element(adb_path, serial, node)
    emit(log, "close_xhs_celebration_popup", hit=True, element={"bounds": node.get("bounds")}, tap={"x": x, "y": y})
    time.sleep(0.4)
    return True


def close_popup_by_top_icon(adb_path, serial, root, log):
    screen_width, screen_height = 720, 1470
    candidates = []
    for node in root.iter("node"):
        if node.get("clickable") != "true" or not node.get("bounds"):
            continue
        if node.get("class") not in {"android.view.ViewGroup", "android.widget.ImageView"}:
            continue
        x, y = bounds_center(node.get("bounds"))
        width, height = bounds_size(node.get("bounds"))
        if not (0.82 * screen_width <= x <= screen_width and y <= 0.72 * screen_height):
            continue
        if not (0.03 * screen_width <= width <= 0.22 * screen_width and 0.02 * screen_height <= height <= 0.16 * screen_height):
            continue
        candidates.append((abs(x - 0.905 * screen_width) + y, node))
    if not candidates:
        return False
    node = min(candidates, key=lambda item: item[0])[1]
    x, y = tap_element(adb_path, serial, node)
    emit(log, "close_profile_popup", hit=True, element={"class": node.get("class"), "bounds": node.get("bounds")}, tap={"x": x, "y": y})
    time.sleep(0.4)
    return True


def handle_common_popup(adb_path, serial, root, parent, log, allow_back=False):
    """Mirror Poco's popup policy, but only after a required target is absent."""
    started = time.perf_counter()
    texts = text_values(root)
    joined = "\n".join(texts)
    markers = [
        "恭喜你", "去发布", "你可能感兴趣的人", "发现新版本", "升级版本", "免流量升级", "新版本",
        "青少年模式", "开启通知", "发送通知", "通讯录好友", "访问照片", "访问相册",
        "照片和视频", "选择照片", "媒体", "权限", "隐私政策", "继续编辑图文笔记吗",
    ]
    marker = next((item for item in markers if item in joined), "")
    if not marker and not dismiss_notification_prompt_if_present(adb_path, serial, log):
        return False
    if not marker:
        return True
    permission_prompt = any(item in joined for item in ["访问照片", "访问相册", "照片和视频", "选择照片", "媒体", "权限"])
    notification_prompt = any(item in joined for item in ["开启通知", "发送通知", "通知权限", "互动消息"])
    privacy_prompt = any(item in joined for item in ["隐私政策", "用户协议"])
    # Never tap a generic “确认”: a QR login confirmation is a business action,
    # not a disposable popup.  Only the gallery media permission is accepted.
    if permission_prompt:
        choices = ["允许全部", "允许访问所有照片", "允许访问照片和视频", "选择照片和视频", "仅在使用期间允许", "允许"]
    elif notification_prompt:
        choices = ["暂不开启", "以后再说", "下次再说", "暂不", "取消", "关闭"]
    elif privacy_prompt:
        choices = ["同意", "我知道了", "知道了"]
    else:
        choices = ["我知道了", "知道了", "稍后再说", "暂不", "以后再说", "拒绝", "取消", "关闭", "跳过", "暂不开启", "下次再说"]
    node, info = find_labeled(root, parent, choices)
    if node is not None:
        x, y = tap_element(adb_path, serial, node)
        emit(log, "close_popup_text", marker=marker, element=info, tap={"x": x, "y": y})
        emit(log, "popup_handled", marker=marker, checkMs=int((time.perf_counter() - started) * 1000))
        time.sleep(0.4)
        return True
    if marker in {"恭喜你", "去发布"} and close_celebration_popup(adb_path, serial, root, log):
        emit(log, "popup_handled", marker=marker, checkMs=int((time.perf_counter() - started) * 1000))
        return True
    if marker == "继续编辑图文笔记吗" and any(label in joined for label in ("存草稿", "去编辑")):
        run_adb(adb_path, serial, ["shell", "input", "keyevent", "4"], timeout=5)
        emit(log, "dismiss_xhs_draft_restore_popup_back", marker=marker)
        time.sleep(0.4)
        return True
    if close_popup_by_top_icon(adb_path, serial, root, log):
        emit(log, "popup_handled", marker=marker, checkMs=int((time.perf_counter() - started) * 1000))
        return True
    if allow_back:
        run_adb(adb_path, serial, ["shell", "input", "keyevent", "4"], timeout=5)
        emit(log, "close_profile_popup_back", marker=marker)
        return True
    emit(log, "popup_not_handled", marker=marker, texts=texts[:40])
    return False


def wait_and_tap(adb_path, serial, token, log, step, labels, timeout, **kwargs):
    deadline = time.time() + timeout
    direct_deadline = min(deadline, time.time() + min(4, timeout))
    last_values = []
    popup_checked = False
    while time.time() < deadline:
        root, parent = dump_ui(adb_path, serial, token)
        last_values = text_values(root)
        node, info = find_labeled(root, parent, labels, **kwargs)
        if node is not None:
            x, y = tap_element(adb_path, serial, node)
            emit(log, step, hit=True, element=info, tap={"x": x, "y": y})
            return True
        if not popup_checked and time.time() >= direct_deadline:
            popup_checked = True
            emit(log, f"{step}_missing_recover_popups", labels=list(labels))
            handle_common_popup(adb_path, serial, root, parent, log)
        time.sleep(0.45)
    emit(log, step, hit=False, labels=list(labels), texts=last_values[:40], focus=focus(adb_path, serial))
    return False


def wait_for_confirm(adb_path, serial, token, log, timeout):
    platform_markers = {"请确认是你本人操作", "登录平台", "千帆", "专业号", "商家", "已阅读并同意"}
    ordinary_markers = {"登录确认", "即将登录小红书电脑端", "确认登录", "确定登录"}
    deadline = time.time() + timeout
    last_values = []
    while time.time() < deadline:
        root, _ = dump_ui(adb_path, serial, token)
        last_values = text_values(root)
        joined = "\n".join(last_values)
        if any(marker in joined for marker in platform_markers):
            emit(log, "confirm_visible", confirmType="platform", texts=last_values[:40])
            return "platform", root
        if any(marker in joined for marker in ordinary_markers):
            emit(log, "confirm_visible", confirmType="ordinary", texts=last_values[:40])
            return "ordinary", root
        time.sleep(0.5)
    emit(log, "confirm_not_found", texts=last_values[:40], focus=focus(adb_path, serial))
    return "", None


def click_first_gallery_image(adb_path, serial, token, log, timeout=8):
    deadline = time.time() + timeout
    direct_deadline = min(deadline, time.time() + min(4, timeout))
    popup_checked = False
    while time.time() < deadline:
        root, parent = dump_ui(adb_path, serial, token)
        for node in root.iter("node"):
            if node.get("clickable") != "true" or not node.get("bounds"):
                continue
            if node.get("class") != "android.widget.ImageView":
                continue
            _, y = bounds_center(node.get("bounds"))
            if y < 150:
                continue
            x, y = tap_element(adb_path, serial, node)
            emit(log, "select_qr_gallery_image", hit=True, element={"class": node.get("class"), "bounds": node.get("bounds")}, tap={"x": x, "y": y})
            return True
        if not popup_checked and time.time() >= direct_deadline:
            popup_checked = True
            emit(log, "gallery_image_missing_recover_popups")
            handle_common_popup(adb_path, serial, root, parent, log)
        time.sleep(0.45)
    emit(log, "select_qr_gallery_image", hit=False, focus=focus(adb_path, serial))
    return False


def accept_xhs_photo_permission(adb_path, serial, token, log):
    root, parent = dump_ui(adb_path, serial, token)
    texts = "\n".join(text_values(root))
    if not any(marker in texts for marker in ["访问照片", "访问相册", "照片和视频", "选择照片", "媒体", "权限"]):
        return False
    node = None
    info = None
    for candidate in root.iter("node"):
        resource_id = (candidate.get("resource-id") or "").strip()
        if not resource_id.endswith("permission_allow_all_button"):
            continue
        node = nearest_tappable(candidate, parent)
        if node is not None and node.get("bounds"):
            info = {"resourceId": resource_id, "bounds": node.get("bounds")}
            break
    if node is None:
        node, info = find_labeled(root, parent, ["允许访问全部", "允许全部", "允许访问所有照片", "允许访问照片和视频", "选择照片和视频", "仅在使用期间允许", "允许"])
    if node is None:
        emit(log, "allow_xhs_photo_access", hit=False, texts=text_values(root)[:40])
        return False
    x, y = tap_element(adb_path, serial, node)
    emit(log, "allow_xhs_photo_access", hit=True, element=info, tap={"x": x, "y": y})
    time.sleep(0.8)
    return True


def wait_confirm_branch_ready(adb_path, serial, token, log, confirm_type, wait_ms, ordinary_buttons, platform_buttons):
    if wait_ms <= 0:
        emit(log, "confirm_wait_skipped", waitMs=wait_ms, confirmType=confirm_type)
        return confirm_type
    deadline = time.time() + wait_ms / 1000.0
    last_values = []
    while time.time() < deadline:
        root, _ = dump_ui(adb_path, serial, token)
        last_values = text_values(root)
        joined = "\n".join(last_values)
        if confirm_type == "platform" and (any(button in last_values for button in platform_buttons) or any(marker in joined for marker in ["请确认是你本人操作", "登录设备", "登录平台", "千帆", "专业号", "商家"])):
            emit(log, "confirm_wait_ready", waitMs=wait_ms, confirmType="platform", texts=last_values[:20])
            return "platform"
        if confirm_type == "ordinary" and (any(button in last_values for button in ordinary_buttons) or any(marker in joined for marker in ["登录确认", "即将登录小红书电脑端", "确认登录"])):
            emit(log, "confirm_wait_ready", waitMs=wait_ms, confirmType="ordinary", texts=last_values[:20])
            return "ordinary"
        time.sleep(0.25)
    emit(log, "confirm_wait_timeout", waitMs=wait_ms, confirmType=confirm_type, texts=last_values[:20])
    return confirm_type


def click_platform_confirmation(adb_path, serial, token, log):
    root, parent = dump_ui(adb_path, serial, token)
    emit(log, "confirm_branch_platform", flow=["登录", "同意并登录"])
    # Some XHS WebView versions require the visible agreement radio before the
    # first Login tap.  It is a real XML control; only tap it when present.
    radio = next((node for node in root.iter("node") if node.get("class") == "android.widget.RadioButton" and node.get("bounds")), None)
    if radio is not None:
        x, y = tap_element(adb_path, serial, radio)
        emit(log, "accept_platform_agreement", hit=True, element={"bounds": radio.get("bounds")}, tap={"x": x, "y": y})
        time.sleep(0.35)
    node, info = find_labeled(root, parent, ["登录"], tappable=False)
    if node is None:
        emit(log, "click_platform_login", hit=False, texts=text_values(root)[:40])
        return False
    x, y = tap_element(adb_path, serial, node)
    emit(log, "click_platform_login", hit=True, element=info, tap={"x": x, "y": y})
    deadline = time.time() + 12
    while time.time() < deadline:
        root, parent = dump_ui(adb_path, serial, token)
        node, info = find_labeled(root, parent, ["同意并登录"], tappable=False)
        if node is not None:
            x, y = tap_element(adb_path, serial, node)
            emit(log, "click_platform_agree_login", hit=True, element=info, tap={"x": x, "y": y})
            return True
        time.sleep(0.4)
    # Match Poco's two-stage branch, while accepting the already-authorized
    # variant that stays on the original WebView after the first Login tap.
    emit(log, "platform_agree_login_not_present_after_login")
    return True


def resolve_activity(adb_path, serial, package_name, provided):
    if provided:
        return provided
    output = run_adb(adb_path, serial, ["shell", "cmd", "package", "resolve-activity", "--brief", package_name], timeout=8)
    for line in reversed([line.strip() for line in output.splitlines() if line.strip()]):
        if "/" in line and " " not in line:
            return line
    return f"{package_name}/.index.v2.IndexActivityV2"


def run_xhs(payload):
    log = []
    started = time.perf_counter()
    serial = payload["serial"]
    adb_path = payload.get("adbPath") or "adb"
    package_name = payload.get("xhsPackageName") or "com.xingin.xhs"
    slot = "Ⅱ·小红书" if payload.get("xhsAppSlot") == "app2" else "小红书"
    confirm_wait_ms = int(payload.get("confirmWaitMs") or 10000)
    ordinary_buttons = payload.get("ordinaryConfirmButtons") or ["确认登录", "确定登录", "同意并登录", "授权登录"]
    platform_buttons = payload.get("platformConfirmButtons") or ["登录", "确认登录", "确定登录", "同意并登录", "授权登录"]
    token = str(payload.get("taskId") or int(time.time() * 1000)).replace("/", "_")
    try:
        require_default_internet_route(adb_path, serial, log)
        wake_and_unlock(adb_path, serial, log)
        grant_xhs_media_access(adb_path, serial, package_name, log)
        run_adb(adb_path, serial, ["shell", "am", "force-stop", package_name], timeout=10)
        activity = resolve_activity(adb_path, serial, package_name, payload.get("launchActivity") or "")
        start = run_adb(adb_path, serial, ["shell", "am", "start", "-W", "-f", "0x10008000", "-n", activity], timeout=20, check=False)
        emit(log, "start_xhs", activity=activity, output=start[-800:])
        time.sleep(1.0)
        focus_lines = focus(adb_path, serial)
        current_focus = "\n".join(focus_lines)
        if is_xhs_clone_resolver_focus(focus_lines):
            dismiss_clone_resolver_overlay_if_present(adb_path, serial, log, focus_lines)
            if not wait_and_tap(adb_path, serial, token, log, "choose_xhs_slot", [slot], timeout=8):
                raise RuntimeError("未找到系统双开应用入口")
            time.sleep(1.0)
        if not wait_and_tap(adb_path, serial, token, log, "open_profile", ["我"], timeout=15, y_min=1200):
            raise RuntimeError("未找到底部我入口")
        if not wait_and_tap(adb_path, serial, token, log, "open_scanner", ["扫一扫"], timeout=15):
            raise RuntimeError("未找到扫一扫入口")
        if not wait_and_tap(adb_path, serial, token, log, "open_album", ["相册"], timeout=12):
            raise RuntimeError("未找到相册入口")
        if payload.get("dryRun"):
            elapsed = int((time.perf_counter() - started) * 1000)
            return {"ok": True, "dryRun": True, "elapsedMs": elapsed, "log": log}
        image_selected = click_first_gallery_image(adb_path, serial, token, log)
        permission_recovered = accept_xhs_photo_permission(adb_path, serial, token, log)
        if permission_recovered:
            image_selected = click_first_gallery_image(adb_path, serial, token, log)
            if not image_selected and wait_and_tap(adb_path, serial, token, log, "reopen_album_after_permission", ["相册"], timeout=4):
                image_selected = click_first_gallery_image(adb_path, serial, token, log)
            if not image_selected:
                raise RuntimeError("授予照片权限后未能重新选择二维码图片")
        elif not image_selected:
            raise RuntimeError("相册未找到可点击图片")
        confirm_type, _ = wait_for_confirm(adb_path, serial, token, log, timeout=18)
        if not confirm_type:
            raise RuntimeError("选中二维码后未进入登录确认页")
        confirm_type = wait_confirm_branch_ready(
            adb_path, serial, token, log, confirm_type, confirm_wait_ms,
            ordinary_buttons, platform_buttons,
        )
        if confirm_type == "platform":
            if not click_platform_confirmation(adb_path, serial, token, log):
                raise RuntimeError("已进入平台登录确认页，但未找到登录元素")
        elif not wait_and_tap(adb_path, serial, token, log, "click_confirm", ordinary_buttons, timeout=4):
            raise RuntimeError("已进入登录确认页，但未找到确认元素")
        elapsed = int((time.perf_counter() - started) * 1000)
        emit(log, "done", elapsedMs=elapsed, focus=focus(adb_path, serial))
        return {"ok": True, "elapsedMs": elapsed, "log": log}
    except Exception as exc:
        emit(log, "error", error=repr(exc), trace=traceback.format_exc(), focus=focus(adb_path, serial))
        return {"ok": False, "error": str(exc), "elapsedMs": int((time.perf_counter() - started) * 1000), "log": log}
    finally:
        run_adb(adb_path, serial, ["shell", "rm", "-f", f"/sdcard/PhoneCloud/.uia-{token}.xml"], timeout=8, check=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", required=True)
    args = parser.parse_args()
    with open(args.payload, "r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)
    print(json.dumps({"result": run_xhs(payload)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
