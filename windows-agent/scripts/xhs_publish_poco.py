#!/usr/bin/env python3
"""Element-driven Xiaohongshu image-post publisher.

The flow intentionally reuses the bounded Poco runtime and popup policy from
the QR workflow.  Coordinates are only derived from already-resolved Poco
elements; no fixed screen position is a business-path selector.
"""
import argparse
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xhs_airtest_poco as base


FINAL_PUBLISH_LABELS = ("发布", "发布笔记", "发笔记")
CLONE_RESOLVER_OUTPUT_MARKERS = (
    "DoubleAppResolverActivity",
    "com.android.intentresolver",
    "android/com.android.internal.app.ResolverActivity",
)

STALE_PUBLISH_ACTIVITIES = (
    ("NoteDetailActivity", "note_detail"),
    # Current XHS builds reuse DetailFeedActivity for both a creator profile
    # and the note opened underneath it. Returning to IndexActivityV2 can
    # therefore require two proven Back operations.
    ("DetailFeedActivity", "detail_feed"),
    ("GlobalSearchActivity", "global_search"),
    ("XhsAlbumActivity", "stale_album"),
)


def launch_output_reports_clone_resolver(output):
    """Trust ``am start -W`` when it proves a vendor clone resolver.

    Starting Poco temporarily focuses PocoService's own TestActivity on some
    phones.  That transient focus must not erase the resolver evidence already
    returned by Android's synchronous activity launch result.
    """
    text = str(output or "")
    return any(marker in text for marker in CLONE_RESOLVER_OUTPUT_MARKERS)


def exact_nodes(poco, label):
    candidates = []
    for selector in ({"text": label}, {"desc": label}, {"name": label}):
        try:
            node = poco(**selector)
            if node.exists():
                candidates.append(node)
        except Exception:
            continue
    return candidates


def click_exact(
    poco,
    labels,
    log,
    step,
    timeout=12,
    y_min=0.0,
    y_max=1.0,
    x_min=0.0,
    x_max=1.0,
):
    deadline = time.time() + timeout
    popup_checked = False
    while time.time() < deadline:
        for label in labels:
            for node in exact_nodes(poco, label):
                try:
                    position = node.get_position()
                    x, y = position
                    if not (x_min <= x <= x_max and y_min <= y <= y_max):
                        continue
                    base.tap_node(node)
                    # Tapping can replace the whole UiAutomation hierarchy.
                    # Never query the now-stale Poco proxy again just to log
                    # its coordinates: that used to turn a successful tap
                    # into an apparent miss and could trigger a second action.
                    base.emit(log, step, label=label, selector="exact_poco_element", position=position)
                    return True
                except Exception:
                    continue
        if not popup_checked and time.time() + 4 >= deadline:
            popup_checked = True
            base.handle_common_popups(poco, log)
        time.sleep(0.3)
    base.emit(log, step, hit=False, labels=labels, texts=base.list_texts(poco, limit=50))
    return False


def back_from_known_stale_publish_activity(log, adb_path=None, serial=None, emit_miss=True):
    """Leave one proven stale XHS surface without guessing at page state."""
    adb_path = adb_path or base.CURRENT_ADB_PATH
    serial = serial or base.CURRENT_SERIAL
    current_focus = "\n".join(base.focus(adb_path, serial))
    if "DeviceOfflineRemindActivity" in current_focus:
        raise RuntimeError("手机小红书账号已下线，不在任务自动恢复范围内")
    for activity, reason in STALE_PUBLISH_ACTIVITIES:
        if activity not in current_focus:
            continue
        base.run_adb(
            adb_path,
            serial,
            ["shell", "input", "keyevent", "4"],
            timeout=5,
        )
        base.emit(
            log,
            "publish_surface_back_from_stale_activity",
            activity=activity,
            reason=reason,
            focus=current_focus.splitlines()[:6],
        )
        time.sleep(0.6)
        return True
    if emit_miss:
        base.emit(
            log,
            "publish_surface_stale_activity_not_proven",
            focus=current_focus.splitlines()[:6],
        )
    return False


def open_publish_entry(poco, log, timeout=15):
    """Open XHS creation only after dismissing its exact notification layer.

    The notification onboarding runs in a translucent Activity above the XHS
    home page and offers only a business-looking ``确认`` button. Never tap
    that generic label. The shared QR policy proves the exact Activity and
    dismisses it with Android Back, which leaves notification permissions
    unchanged. Check once before the target lookup and once after a short miss
    to cover the popup racing with the clone-to-XHS transition.
    """
    if base.dismiss_notification_prompt_safely(base.CURRENT_ADB_PATH, base.CURRENT_SERIAL, log):
        base.emit(log, "publish_entry_notification_overlay_dismissed", phase="before_lookup")
    deadline = time.time() + timeout

    def budget(cap):
        return max(0.4, min(float(cap), deadline - time.time()))

    direct_timeout = budget(5)
    if click_exact(
        poco,
        ["发布", "+", "创作"],
        log,
        "open_publish_entry",
        timeout=direct_timeout,
        y_min=0.72,
        x_min=0.30,
        x_max=0.70,
    ):
        return True
    # Poco sees neither the XHS bottom bar nor this separate system window.
    # Once the target misses, hand off to the existing bounded XML path;
    # keeping Poco attached would prevent UIAutomator from dumping the dialog.
    foreground = [
        line for line in base.focus(base.CURRENT_ADB_PATH, base.CURRENT_SERIAL)
        if "mCurrentFocus" in line
    ]
    if any("com.bbk.updater" in line for line in foreground):
        base.emit(log, "publish_entry_vivo_update_overlay_detected")
        return False
    if any("VivoUsbDialog" in line for line in foreground):
        base.emit(log, "publish_entry_vivo_usb_overlay_detected")
        return False
    if base.dismiss_notification_prompt_safely(base.CURRENT_ADB_PATH, base.CURRENT_SERIAL, log):
        base.emit(log, "publish_entry_notification_overlay_dismissed", phase="after_target_miss")
        if click_exact(
            poco,
            ["发布", "+", "创作"],
            log,
            "open_publish_entry_after_notification",
            timeout=budget(3),
            y_min=0.72,
            x_min=0.30,
            x_max=0.70,
        ):
            return True

    # Cold start may restore a detail/search/album Activity. Only after the
    # publish target has missed do we leave one of those explicitly proven
    # stale surfaces, then retry the target before touching any navigation.
    for stale_back_attempt in range(1, 3):
        if time.time() >= deadline or not back_from_known_stale_publish_activity(log):
            break
        step = "open_publish_entry_after_stale_activity"
        if stale_back_attempt > 1:
            step = f"{step}_{stale_back_attempt}"
        if click_exact(
            poco,
            ["发布", "+", "创作"],
            log,
            step,
            timeout=budget(4),
            y_min=0.72,
            x_min=0.30,
            x_max=0.70,
        ):
            return True

    # IndexActivityV2 can restore the profile surface while keeping the same
    # Activity name. In that case require an exact bottom-navigation element
    # before changing pages; never issue a generic Back or fixed-coordinate
    # tap. Retry the publish target once after the verified navigation.
    if time.time() < deadline and click_exact(
        poco,
        ["首页", "发现"],
        log,
        "publish_surface_return_to_home",
        timeout=budget(3),
        y_min=0.72,
        x_max=0.38,
    ):
        return click_exact(
            poco,
            ["发布", "+", "创作"],
            log,
            "open_publish_entry_after_home_navigation",
            timeout=budget(4),
            y_min=0.72,
            x_min=0.30,
            x_max=0.70,
        )
    return False


def bottom_xml_tappable(
    root,
    parent,
    labels,
    screen_height,
    screen_width=0,
    y_min=0.72,
    x_min=0.30,
    x_max=0.70,
):
    """Return an exact, enabled bottom-navigation XML target.

    XHS exposes the centre creation button as ``content-desc=发布`` on builds
    where Poco's UiAutomation hierarchy can omit the entire bottom bar.  The
    returned tap remains element-derived and is rejected unless the resolved
    element is in the same bounded lower-screen region used by the Poco path.
    """
    wanted = set(labels)
    height = max(1, int(screen_height or 0))
    for node in root.iter("node"):
        text = (node.get("text") or "").strip()
        desc = (node.get("content-desc") or "").strip()
        if text not in wanted and desc not in wanted:
            continue
        candidate = base.nearest_xml_tappable(node, parent)
        bounds = candidate.get("bounds") if candidate is not None else ""
        if not bounds or candidate.get("enabled", "true") == "false":
            continue
        x1, y1, x2, y2 = base.xml_bounds_values(bounds)
        if ((y1 + y2) / 2) / height < y_min:
            continue
        if screen_width and not (x_min <= ((x1 + x2) / 2) / screen_width <= x_max):
            continue
        return candidate, text, desc
    return None, "", ""


def dismiss_vivo_update_overlay_xml(adb_path, serial, root, parent, log):
    """Defer only the exact Vivo system-update dialog seen above XHS home.

    Return None when this is not that dialog, False when its safe action cannot
    be proved, and True after tapping the element-labelled defer action.
    Never tap the install button or use a generic Back on an unknown overlay.
    """
    updater_nodes = [node for node in root.iter("node") if node.get("package") == "com.bbk.updater"]
    if not updater_nodes:
        return None
    if not any((node.get("text") or "").strip() == "系统升级" for node in updater_nodes):
        base.emit(log, "publish_vivo_update_overlay_unrecognized")
        return False
    safe_buttons = []
    for node in updater_nodes:
        if (node.get("text") or "").strip() != "稍后提醒":
            continue
        button = parent.get(node)
        if button is None or button.get("resource-id") != "android:id/button2":
            continue
        if button.get("package") != "com.bbk.updater":
            continue
        if button.get("clickable") != "true" or button.get("enabled") != "true":
            continue
        if not button.get("bounds"):
            continue
        safe_buttons.append(button)
    if len(safe_buttons) != 1:
        base.emit(log, "publish_vivo_update_defer_not_proven", safeButtonCount=len(safe_buttons))
        return False
    x, y = base.xml_bounds_center(safe_buttons[0].get("bounds"))
    base.run_adb(adb_path, serial, ["shell", "input", "tap", str(x), str(y)], timeout=5)
    base.emit(log, "publish_vivo_update_deferred", selector="com.bbk.updater/android:id/button2", bounds=safe_buttons[0].get("bounds"))
    return True


def dismiss_vivo_usb_overlay_xml(adb_path, serial, root, log):
    """Cancel only the proven Vivo USB-choice dialog, without changing mode."""
    nodes = [node for node in root.iter("node") if node.get("package") == "android"]
    if not any((node.get("text") or "").strip() == "USB 已连接" for node in nodes):
        return None
    titles = [
        node for node in nodes
        if node.get("resource-id") == "android:id/alertTitle"
        and (node.get("text") or "").strip() == "USB 已连接"
    ]
    foreground = base.focus(adb_path, serial)
    if len(titles) != 1 or not any(
        "mCurrentFocus" in line and "VivoUsbDialog" in line for line in foreground
    ):
        base.emit(log, "publish_vivo_usb_overlay_not_proven", titleCount=len(titles))
        return False
    cancel_buttons = [
        node for node in nodes
        if node.get("resource-id") == "android:id/button2"
        and (node.get("text") or "").strip() == "取消"
        and node.get("clickable") == "true"
        and node.get("enabled") == "true"
        and node.get("bounds")
    ]
    if len(cancel_buttons) != 1:
        base.emit(log, "publish_vivo_usb_cancel_not_proven", cancelButtonCount=len(cancel_buttons))
        return False
    bounds = cancel_buttons[0].get("bounds")
    x, y = base.xml_bounds_center(bounds)
    base.run_adb(adb_path, serial, ["shell", "input", "tap", str(x), str(y)], timeout=5)
    base.emit(log, "publish_vivo_usb_cancelled", selector="android:id/button2", bounds=bounds, usbModeChanged=False)
    return True


def click_publish_entry_xml(adb_path, serial, log, token, timeout=8):
    deadline = time.time() + timeout
    attempts = 0
    stale_recoveries = 0
    usb_dismissals = 0
    last_values = []
    screen_width, screen_height = base.screen_size(adb_path, serial)
    while time.time() <= deadline:
        attempts += 1
        try:
            root, parent, values, _ = base.dump_confirm_xml(adb_path, serial, token)
            last_values = values
            update_deferred = dismiss_vivo_update_overlay_xml(adb_path, serial, root, parent, log)
            if update_deferred is True:
                # A second vendor prompt may be underneath. Always inspect a
                # fresh hierarchy before attempting the XHS publish target.
                time.sleep(0.35)
                continue
            if update_deferred is False:
                return False
            if usb_dismissals and any(
                node.get("package") == "android"
                and (node.get("text") or "").strip() == "USB 已连接"
                for node in root.iter("node")
            ):
                base.emit(log, "publish_vivo_usb_overlay_still_present_after_cancel")
                return False
            usb_cancelled = dismiss_vivo_usb_overlay_xml(adb_path, serial, root, log)
            if usb_cancelled is True:
                usb_dismissals += 1
                # A cancellation may reveal XHS or another exact overlay.
                # Never act on the hierarchy captured before the tap.
                time.sleep(0.35)
                continue
            if usb_cancelled is False:
                return False
            # XHS may asynchronously restore the last viewed note after the
            # initial Poco probe has already established that IndexActivity
            # was focused. Re-check on every XML round, but only press Back
            # for the exact allow-listed stale Activities and at most twice.
            if stale_recoveries < 2 and back_from_known_stale_publish_activity(
                log,
                adb_path=adb_path,
                serial=serial,
                emit_miss=False,
            ):
                stale_recoveries += 1
                base.emit(
                    log,
                    "open_publish_entry_xml_stale_recovered",
                    attempts=attempts,
                    staleRecoveries=stale_recoveries,
                )
                continue
            candidate, text, desc = bottom_xml_tappable(
                root,
                parent,
                ("发布", "+", "创作"),
                screen_height,
                screen_width=screen_width,
            )
            if candidate is not None:
                x, y = base.xml_bounds_center(candidate.get("bounds"))
                base.run_adb(adb_path, serial, ["shell", "input", "tap", str(x), str(y)], timeout=5)
                base.emit(
                    log,
                    "open_publish_entry_xml",
                    hit=True,
                    attempts=attempts,
                    element={"text": text, "desc": desc, "bounds": candidate.get("bounds")},
                )
                time.sleep(0.8)
                return True
        except Exception as exc:
            base.emit(log, "open_publish_entry_xml_probe_failed", attempts=attempts, error=repr(exc))
        time.sleep(0.35)
    base.emit(
        log,
        "open_publish_entry_xml",
        hit=False,
        attempts=attempts,
        values=last_values[:60],
        focus=base.focus(adb_path, serial),
    )
    return False


def preserve_existing_publish_draft(poco, log):
    """Preserve an interrupted XHS draft before starting a fresh task.

    This is publisher-only recovery. It never discards user content: when the
    exact resume question is present, choose the exact ``存草稿`` element and
    return to the home surface. The QR task intentionally keeps its separate
    Back-only policy.
    """
    question_found = False
    for question in ("继续编辑图文笔记吗", "继续编辑图文笔记吗?", "继续编辑图文笔记吗？"):
        try:
            if poco(text=question).exists():
                question_found = True
                break
        except Exception:
            continue
    if not question_found:
        return False
    if not click_exact(poco, ["存草稿"], log, "preserve_existing_publish_draft", timeout=4):
        raise RuntimeError("xhs_publish_draft_prompt_without_save_element")
    return True


def enabled_final_publish_elements(poco):
    rows = []
    for label in FINAL_PUBLISH_LABELS:
        for node in exact_nodes(poco, label):
            try:
                x, y = node.get_position()
                enabled = node.attr("enabled")
                if y < 0.55 or enabled in (False, 0, "false", "False"):
                    continue
                rows.append({"label": label, "position": [x, y], "enabled": True})
            except Exception:
                continue
    return rows


def exact_text_visible(poco, value):
    for node in exact_nodes(poco, value):
        try:
            if node.exists():
                return True
        except Exception:
            continue
    return False


def visible_edit_texts(poco):
    rows = []
    try:
        # A positional Poco selector matches ``name``. Android's widget class
        # is exposed as ``type``; using it positionally silently returned an
        # empty collection on the current XHS editor.
        nodes = poco(type="android.widget.EditText")
        for index in range(len(nodes)):
            node = nodes[index]
            try:
                if not node.exists():
                    continue
                x, y = node.get_position()
                if 0.04 <= x <= 0.96 and 0.05 <= y <= 0.96:
                    rows.append((y, x, node))
            except Exception:
                continue
    except Exception:
        pass
    rows.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in rows]


def fill_editor(poco, title, content, log, timeout=18):
    deadline = time.time() + timeout
    while time.time() < deadline:
        # Prefer the editor's semantic placeholders. This keeps title/body
        # assignment stable if XHS adds another EditText above or below them.
        title_nodes = exact_nodes(poco, "添加标题")
        content_nodes = exact_nodes(poco, "添加正文")
        if title_nodes and content_nodes:
            title_nodes[0].set_text(title)
            base.emit(log, "set_publish_title", selector="exact_placeholder_添加标题", length=len(title))
            content_nodes[0].set_text(content)
            base.emit(log, "set_publish_content", selector="exact_placeholder_添加正文", length=len(content))
            return True
        editors = visible_edit_texts(poco)
        if len(editors) >= 2:
            editors[0].set_text(title)
            base.emit(log, "set_publish_title", selector="first_visible_typed_EditText", length=len(title))
            editors[1].set_text(content)
            base.emit(log, "set_publish_content", selector="second_visible_typed_EditText", length=len(content))
            return True
        time.sleep(0.4)
    base.emit(log, "publish_editor_missing", editTextCount=len(visible_edit_texts(poco)), texts=base.list_texts(poco, limit=60))
    return False


def select_gallery_images(poco, count, log):
    # Ask for multi-select only when needed. It is optional because some XHS
    # versions show checkboxes by default.
    if count > 1:
        click_exact(poco, ["选择多张", "多选"], log, "enable_multi_select", timeout=3)
    deadline = time.time() + 16
    while time.time() < deadline:
        try:
            # Match the proven QR selector: take one bounded hierarchy snapshot
            # and derive every touch from real thumbnail elements. This avoids
            # treating toolbar/system ImageViews as user photos.
            nodes = list(poco.freeze()(type="android.widget.ImageView"))
            candidates = []
            for node in nodes:
                try:
                    name = node.attr("name") or ""
                    x, y = node.get_position()
                    width, height = node.get_size()
                    if (
                        "redscanner" not in name
                        and "systemui" not in name
                        and 0.05 < x < 0.95
                        and 0.08 < y < 0.78
                        and 0.08 <= width <= 0.5
                        and 0.08 <= height <= 0.5
                    ):
                        candidates.append((y, x, width, height, name, node))
                except Exception:
                    continue
            candidates.sort(key=lambda item: (item[0], item[1]))
            if len(candidates) >= count:
                screen_width, screen_height = base.screen_size(base.CURRENT_ADB_PATH, base.CURRENT_SERIAL)
                for selected, (_, _, width, height, name, node) in enumerate(candidates[:count], start=1):
                    x, y = node.get_position()
                    # Recent XHS versions open MaterialPreviewActivity when
                    # the thumbnail centre is tapped. Select through the
                    # checkbox rendered inside this resolved element's
                    # top-right corner instead. These coordinates remain
                    # element-derived rather than fixed to the screen.
                    tap_x = x + width / 2 - max(0.018, width * 0.10)
                    tap_y = y - height / 2 + max(0.018, height * 0.10)
                    pixel_x = max(1, min(screen_width - 1, int(round(tap_x * screen_width))))
                    pixel_y = max(1, min(screen_height - 1, int(round(tap_y * screen_height))))
                    base.run_adb(
                        base.CURRENT_ADB_PATH,
                        base.CURRENT_SERIAL,
                        ["shell", "input", "tap", str(pixel_x), str(pixel_y)],
                        timeout=5,
                    )
                    time.sleep(0.35)
                    focus_after_tap = base.focus(base.CURRENT_ADB_PATH, base.CURRENT_SERIAL)
                    if "MaterialPreviewActivity" in "\n".join(focus_after_tap):
                        base.run_adb(
                            base.CURRENT_ADB_PATH,
                            base.CURRENT_SERIAL,
                            ["shell", "input", "keyevent", "KEYCODE_BACK"],
                            timeout=5,
                        )
                        raise RuntimeError(
                            f"xhs_publish_thumbnail_opened_preview:index={selected},"
                            f"element={[x, y, width, height]},tap={[pixel_x, pixel_y]}"
                        )
                    base.emit(
                        log,
                        "select_publish_image",
                        index=selected,
                        selector="bounded_gallery_thumbnail_checkbox",
                        position=[x, y],
                        size=[width, height],
                        checkboxTap=[pixel_x, pixel_y],
                        name=name,
                        candidateCount=len(candidates),
                    )
                return True
        except Exception as exc:
            base.emit(log, "publish_gallery_candidates_failed", error=repr(exc))
        time.sleep(0.35)
    base.emit(log, "select_publish_images_incomplete", requested=count, selected=0, texts=base.list_texts(poco, limit=50))
    return False


def bind_airtest_device(serial, adb_path, log, step="airtest_device_bound"):
    # Airtest keeps a process-global current device. Direct ADB calls above
    # include ``-s``, but Poco creation does not, so without this binding a
    # fresh publish task can inherit another phone chosen by an earlier task.
    from airtest.core.settings import Settings as ST
    from airtest.core.api import connect_device

    ST.ADB = adb_path
    try:
        connected = connect_device(
            f"Android://127.0.0.1:5037/{serial}?cap_method=JAVACAP&touch_method=ADBTOUCH"
        )
    except SystemExit as exc:
        raise RuntimeError(f"airtest_connect_exited:serial={serial},code={exc.code}") from exc
    connected_serial = str(getattr(getattr(connected, "adb", None), "serialno", "") or "")
    base.emit(
        log,
        step,
        requestedSerial=serial,
        connectedSerial=connected_serial,
    )
    if connected_serial != serial:
        raise RuntimeError(
            f"airtest_serial_mismatch:requested={serial},connected={connected_serial or 'unknown'}"
        )
    return connected


def launch_xhs(payload, log):
    serial = payload["serial"]
    adb_path = payload.get("adbPath") or "adb"
    package_name = payload.get("xhsPackageName") or "com.xingin.xhs"
    slot_name = "app2" if payload.get("xhsAppSlot") == "app2" else "app1"
    slot_label = "Ⅱ·小红书" if slot_name == "app2" else "小红书"
    poco = None
    try:
        base.require_default_internet_route(adb_path, serial, log)
        base.wake_and_unlock(adb_path, serial, log)
        base.grant_xhs_media_access(adb_path, serial, package_name, log)
        base.reset_launch_surface(adb_path, serial, log)
        base.run_adb(adb_path, serial, ["shell", "am", "force-stop", package_name], timeout=10)
        activity = base.resolve_activity(adb_path, serial, package_name)
        start_out = base.start_xhs_activity(adb_path, serial, activity, package_name, log)
        launch_focus = base.focus(adb_path, serial)
        resolver_from_start = launch_output_reports_clone_resolver(start_out)
        resolver_was_active = (
            resolver_from_start
            or base.package_from_focus(launch_focus) == "com.android.intentresolver"
        )
        base.emit(
            log,
            "publish_launch_focus",
            resolverActive=resolver_was_active,
            resolverFromStartOutput=resolver_from_start,
            focus=launch_focus,
        )

        if resolver_was_active:
            # Vivo/OPPO clone pickers are system UI, not part of XHS's Poco
            # hierarchy. Select the proven resolver with bounded XML before
            # Poco can focus its own TestActivity and hide the resolver state.
            # This is the same element-driven fallback used by the QR flow.
            base.release_poco_for_confirm_xml(adb_path, serial, log)
            token = f"{payload.get('taskId') or int(time.time() * 1000)}-publish-resolver"
            if not base.click_xhs_slot_xml(adb_path, serial, slot_name, log, token, timeout=8):
                raise RuntimeError("xhs_publish_clone_slot_not_found")
            bind_airtest_device(serial, adb_path, log, step="airtest_device_bound_after_clone_xml")
            poco = base.create_stable_poco(use_airtest_input=True, screenshot_each_action=False)
            base.emit(log, "poco_recreated_after_publish_clone_xml", focus=base.focus(adb_path, serial))
        else:
            bind_airtest_device(serial, adb_path, log)
            poco = base.create_stable_poco(use_airtest_input=True, screenshot_each_action=False)
            slot_selected = base.choose_xhs_slot(poco, adb_path, serial, slot_label, log)
            if not slot_selected:
                # A resolver may appear just after the launch probe. Release
                # Poco and reuse the same bounded XML path for this late race.
                base.stop_stable_poco(poco, adb_path, serial)
                poco = None
                token = f"{payload.get('taskId') or int(time.time() * 1000)}-publish-resolver"
                if not base.click_xhs_slot_xml(adb_path, serial, slot_name, log, token, timeout=8):
                    raise RuntimeError("xhs_publish_clone_slot_not_found")
                bind_airtest_device(serial, adb_path, log, step="airtest_device_rebound_after_clone_xml")
                poco = base.create_stable_poco(use_airtest_input=True, screenshot_each_action=False)
                base.emit(log, "poco_recreated_after_publish_clone_xml", focus=base.focus(adb_path, serial))
        base.clear_popups_rounds(poco, log, rounds=1)
        return poco
    except Exception:
        if poco is not None:
            try:
                base.stop_stable_poco(poco, adb_path, serial)
            except Exception:
                pass
        raise


def run_publish(payload):
    log = []
    started = time.perf_counter()
    poco = None
    base.CURRENT_ADB_PATH = payload.get("adbPath") or "adb"
    base.CURRENT_SERIAL = payload["serial"]
    base.CURRENT_RUN_STARTED_AT = started
    base.CURRENT_LAST_EMIT_AT = 0.0
    try:
        title = str(payload.get("title") or "").strip()
        content = str(payload.get("content") or "").strip()
        remote_paths = list(payload.get("remotePaths") or [])
        if not title or not content or not remote_paths:
            raise RuntimeError("publish_payload_incomplete")
        poco = launch_xhs(payload, log)
        preserve_existing_publish_draft(poco, log)
        if not open_publish_entry(poco, log, timeout=15):
            # Some current XHS builds expose the bottom publish navigation to
            # UIAutomator XML while the attached Poco hierarchy omits it. Use
            # the exact bottom XML element, then return to a fresh Poco session
            # for the remainder of the publisher workflow.
            base.stop_stable_poco(poco, base.CURRENT_ADB_PATH, base.CURRENT_SERIAL)
            poco = None
            base.release_poco_for_confirm_xml(base.CURRENT_ADB_PATH, base.CURRENT_SERIAL, log)
            token = f"{payload.get('taskId') or int(time.time() * 1000)}-publish-entry"
            if not click_publish_entry_xml(
                base.CURRENT_ADB_PATH,
                base.CURRENT_SERIAL,
                log,
                token,
                timeout=8,
            ):
                raise RuntimeError("xhs_publish_entry_not_found")
            bind_airtest_device(
                base.CURRENT_SERIAL,
                base.CURRENT_ADB_PATH,
                log,
                step="airtest_device_rebound_after_publish_entry_xml",
            )
            poco = base.create_stable_poco(use_airtest_input=True, screenshot_each_action=False)
            base.emit(log, "poco_recreated_after_publish_entry_xml", focus=base.focus(base.CURRENT_ADB_PATH, base.CURRENT_SERIAL))
        if not click_exact(poco, ["从相册选择", "上传图片", "图片", "发布图文"], log, "open_publish_album", timeout=12):
            raise RuntimeError("xhs_publish_album_entry_not_found")
        if not select_gallery_images(poco, len(remote_paths), log):
            raise RuntimeError("xhs_publish_images_not_selected")
        if not click_exact(poco, ["下一步"], log, "publish_gallery_next", timeout=12, y_min=0.5):
            raise RuntimeError("xhs_publish_gallery_next_not_found")
        # Some versions have an image-edit/crop page with a second Next.
        click_exact(poco, ["下一步"], log, "publish_editor_next", timeout=6, y_min=0.5)
        if not fill_editor(poco, title, content, log):
            raise RuntimeError("xhs_publish_editor_not_ready")
        if payload.get("dryRunBeforeFinalPublish"):
            title_verified = exact_text_visible(poco, title)
            content_verified = exact_text_visible(poco, content)
            final_buttons = enabled_final_publish_elements(poco)
            base.emit(
                log,
                "publish_dry_run_ready_before_final",
                titleExact=title_verified,
                contentExact=content_verified,
                finalPublishElements=final_buttons,
                clickedFinalPublish=False,
            )
            if not title_verified or not content_verified:
                raise RuntimeError("xhs_publish_dry_run_text_readback_failed")
            if not final_buttons:
                raise RuntimeError("xhs_publish_dry_run_final_button_not_ready")
            return {
                "ok": True,
                "dryRun": True,
                "terminalState": "READY_BEFORE_FINAL_PUBLISH",
                "clickedFinalPublish": False,
                "elapsedMs": int((time.perf_counter() - started) * 1000),
                "log": log,
            }
        if not click_exact(poco, FINAL_PUBLISH_LABELS, log, "click_final_publish", timeout=12, y_min=0.55):
            raise RuntimeError("xhs_final_publish_button_not_found")
        deadline = time.time() + 20
        while time.time() < deadline:
            texts = base.list_texts(poco, limit=80)
            if any(marker in "\n".join(texts) for marker in ("发布成功", "发布完成", "审核中")):
                base.emit(log, "publish_confirmed", evidence="success_text", texts=texts[:30])
                break
            if not visible_edit_texts(poco) and "com.xingin.xhs" in "\n".join(base.focus(base.CURRENT_ADB_PATH, base.CURRENT_SERIAL)):
                base.emit(log, "publish_confirmed", evidence="editor_closed_and_xhs_foreground")
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("xhs_publish_result_not_confirmed")
        return {"ok": True, "elapsedMs": int((time.perf_counter() - started) * 1000), "log": log}
    except Exception as exc:
        base.emit(log, "error", error=repr(exc), trace=traceback.format_exc(), focus=base.focus(base.CURRENT_ADB_PATH, base.CURRENT_SERIAL))
        return {"ok": False, "error": str(exc), "elapsedMs": int((time.perf_counter() - started) * 1000), "log": log}
    finally:
        if poco is not None:
            base.stop_stable_poco(poco, base.CURRENT_ADB_PATH, base.CURRENT_SERIAL)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", required=True)
    args = parser.parse_args()
    with open(args.payload, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    result = run_publish(payload)
    print(json.dumps(result, ensure_ascii=True), flush=True)
    # The Windows Agent treats stdout JSON as the runner contract and maps
    # ``ok: false`` to a failed task itself. Returning 1 here makes exec reject
    # before it can parse/replay the precise Poco step log, leaving users with
    # only a truncated generic command error.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
