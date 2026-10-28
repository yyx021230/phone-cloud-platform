#!/usr/bin/env python3
"""Element-first Kuaishou vehicle lead automation with fail-closed popup recovery."""

import argparse
import json
import re
import time
import traceback

import xhs_airtest_poco as base


KUAISHOU_PACKAGE = "com.smile.gifmaker"
CITY_FIELD_LABELS = ("意向城市", "您所在的城市")
KUAISHOU_EDIT_TEXT_NAME = "android.widget.EditText"
VIVO_IME_COLLAPSE_NAME = "com.vivo.ai.ime:id/item_back"
VIVO_IME_COLLAPSE_DESC = "键盘收起"
AUTONOMOUS_REGION_DISPLAY_PREFIXES = (
    ("内蒙古自治区", "内蒙古"),
    ("广西壮族自治区", "广西"),
    ("西藏自治区", "西藏"),
    ("宁夏回族自治区", "宁夏"),
    ("新疆维吾尔自治区", "新疆"),
)
STALE_ENTRY_WAIT_ERRORS = frozenset(
    {
        "等待 vehicle_card 超时",
        "等待 detail_form 超时",
        "等待 detail_form_after_scroll 超时",
    }
)
SYSTEM_PERMISSION_PACKAGES = (
    "com.android.permissioncontroller",
    "com.google.android.permissioncontroller",
)
APP_POPUP_RULES = (
    {
        "kind": "upgrade",
        "markers": ("发现新版本", "升级版本", "版本更新", "立即升级"),
        "actions": ("以后再说", "暂不更新", "下次再说", "取消", "关闭"),
    },
    {
        "kind": "notification",
        "markers": ("开启通知", "通知权限", "及时收到消息", "打开通知"),
        "actions": ("暂不开启", "以后再说", "下次再说", "暂不", "取消", "关闭"),
    },
    {
        "kind": "teen_mode",
        "markers": ("青少年模式", "未成年人模式"),
        "actions": ("我知道了", "知道了", "暂不开启", "关闭"),
    },
    {
        "kind": "contacts",
        "markers": ("通讯录好友", "发现通讯录朋友", "访问通讯录"),
        "actions": ("暂不", "以后再说", "取消", "关闭"),
    },
    {
        "kind": "marketing",
        "markers": ("新人福利", "领取奖励", "邀请好友", "签到提醒"),
        "actions": ("稍后再说", "暂不", "取消", "关闭", "跳过"),
    },
)
MANUAL_POPUP_MARKERS = (
    "隐私政策",
    "用户协议",
    "账号异常",
    "安全验证",
    "滑块验证",
    "请输入验证码",
    "短信验证码",
)


class SubmittedUnknown(RuntimeError):
    """The submit tap happened, but success could not be confirmed safely."""


class SubmissionSucceededCloseFailed(RuntimeError):
    """The reservation succeeded, but its result sheet could not be closed."""


class CityStateRefreshRequired(RuntimeError):
    """The query is visible, but the current Poco hierarchy stayed stale."""


def emit(log, step, **detail):
    item = {"step": step, **detail}
    log.append(item)
    print(json.dumps({"event": item}, ensure_ascii=True), flush=True)


def text_nodes(snapshot):
    nodes = []
    for node_type in ("android.widget.TextView", "android.widget.Button"):
        try:
            nodes.extend(list(snapshot(type=node_type)))
        except Exception:
            pass
    return nodes


def visible_texts(snapshot, limit=180):
    values = []
    for node in text_nodes(snapshot):
        try:
            value = str(node.attr("text") or "").strip()
        except Exception:
            value = ""
        if value and value not in values:
            values.append(value)
        if len(values) >= limit:
            break
    return values


def exact_nodes(snapshot, text, node_type=None):
    try:
        nodes = list(snapshot(text=text))
    except Exception:
        return []
    if node_type:
        nodes = [node for node in nodes if node.attr("type") == node_type]
    return nodes


def find_city_search_state(snapshot, city_query):
    fields = exact_nodes(snapshot, city_query, "android.widget.EditText")
    if len(fields) != 1:
        return None
    try:
        text_views = list(snapshot(type="android.widget.TextView"))
    except Exception:
        return None
    field_y = fields[0].get_position()[1]
    results = []
    for node in text_views:
        try:
            text = str(node.attr("text") or "").strip()
            _, y = node.get_position()
        except Exception:
            continue
        # A table may intentionally use an unambiguous short city name such
        # as "红河", while Kuaishou renders the unique result as
        # "红河哈尼族彝族". Keep the field exact and accept only one
        # lower TextView whose value begins with that query.
        if text.startswith(city_query) and y > field_y + 0.02:
            results.append(node)
    if len(results) == 1:
        return fields, results
    return None


def find_kuaishou_edit_fields(snapshot):
    try:
        nodes = list(
            snapshot(
                name=KUAISHOU_EDIT_TEXT_NAME,
                type="android.widget.EditText",
            )
        )
    except Exception:
        return []
    return [node for node in nodes if node.attr("visible")]


def find_vivo_ime_collapse(snapshot):
    try:
        nodes = list(
            snapshot(
                name=VIVO_IME_COLLAPSE_NAME,
                desc=VIVO_IME_COLLAPSE_DESC,
                type="android.widget.Button",
            )
        )
    except Exception:
        return []
    matches = []
    for node in nodes:
        try:
            x, y = node.get_position()
            width, height = node.get_size()
            touchable = bool(node.attr("touchable"))
            visible = bool(node.attr("visible"))
        except Exception:
            continue
        if (
            visible
            and touchable
            and x >= 0.80
            and 0.50 <= y <= 0.75
            and 0.05 <= width <= 0.20
            and 0.02 <= height <= 0.10
        ):
            matches.append(node)
    return matches


def find_city_labels(snapshot):
    labels = []
    for text in CITY_FIELD_LABELS:
        labels.extend(exact_nodes(snapshot, text, "android.widget.TextView"))
    return labels


def normalize_autonomous_region_prefix(region):
    for official_prefix, kuaishou_prefix in AUTONOMOUS_REGION_DISPLAY_PREFIXES:
        if region.startswith(official_prefix):
            return f"{kuaishou_prefix}{region[len(official_prefix):]}"
    return region


def normalize_kuaishou_region(city_query, expected_region):
    # The live-room picker uses autonomous-prefecture labels without the
    # administrative suffix. Verified example:
    #   红河哈尼族彝族自治州 -> 红河哈尼族彝族
    # Keep every other city untouched; do not introduce fuzzy aliases.
    suffix = "自治州"
    normalized_city = city_query
    normalized_region = expected_region
    if city_query.endswith(suffix):
        normalized_city = city_query[: -len(suffix)]
        if expected_region.endswith(city_query):
            normalized_region = expected_region[: -len(suffix)]
    # Kuaishou shortens the five province-level autonomous-region names in
    # the selected-city field (for example 广西壮族自治区柳州市 -> 广西柳州市).
    # Only these exact leading administrative prefixes are canonicalized;
    # the city portion remains mandatory and exact.
    normalized_region = normalize_autonomous_region_prefix(normalized_region)
    return normalized_city, normalized_region


def create_connected_poco(adb_path, serial):
    from airtest.core.api import connect_device
    from airtest.core.settings import Settings as ST

    ST.ADB = adb_path
    base.run_adb(adb_path, serial, ["shell", "echo", "ok"], timeout=8)
    base.reset_stale_poco_instrumentation(adb_path, serial)
    connect_device(
        f"Android://127.0.0.1:5037/{serial}?cap_method=JAVACAP&touch_method=ADBTOUCH"
    )
    return base.create_stable_poco(use_airtest_input=True, screenshot_each_action=False)


def should_rebuild_entry_poco(error):
    return str(error) in STALE_ENTRY_WAIT_ERRORS


def safe_click(node, log, step, focus=None, post_wait=0.7):
    target = node.focus(focus) if focus is not None else node
    emit(
        log,
        step,
        position=[round(value, 4) for value in target.get_position()],
        size=[round(value, 4) for value in node.get_size()],
    )
    base.tap_node(target, post_wait=post_wait)


def focused_text(adb_path, serial):
    return "\n".join(base.focus(adb_path, serial))


def soft_keyboard_is_shown(adb_path, serial):
    state = base.run_adb(
        adb_path, serial, ["shell", "dumpsys", "input_method"], timeout=8
    )
    return bool(re.search(r"\bmInputShown\s*=\s*true\b", state))


def hide_soft_keyboard_if_shown(poco, adb_path, serial, log):
    if not soft_keyboard_is_shown(adb_path, serial):
        return False
    snapshot = poco.freeze()
    collapse = find_vivo_ime_collapse(snapshot)
    if len(collapse) == 1:
        safe_click(collapse[0], log, "hide_city_keyboard", post_wait=0.3)
        log[-1].update(method="poco_vivo_ime_collapse")
    else:
        # Other Android keyboards do not expose Vivo's collapse resource.
        # BACK is safe only after dumpsys has proven that the IME is visible;
        # the caller then re-locates the exact query and result nodes.
        base.run_adb(
            adb_path, serial, ["shell", "input", "keyevent", "4"], timeout=5
        )
        time.sleep(0.3)
        emit(
            log,
            "hide_city_keyboard",
            method="adb_back_while_keyboard_visible",
            pocoCandidateCount=len(collapse),
        )
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and soft_keyboard_is_shown(adb_path, serial):
        time.sleep(0.2)
    if soft_keyboard_is_shown(adb_path, serial):
        raise RuntimeError("输入法收起键点击后键盘仍显示")
    return True


def handle_known_system_popup(adb_path, serial, log):
    focus_text = focused_text(adb_path, serial)
    if "VivoUsbDialog" in focus_text:
        base.run_adb(adb_path, serial, ["shell", "input", "keyevent", "4"], timeout=5)
        time.sleep(0.5)
        emit(log, "dismiss_system_popup", kind="vivo_usb", method="back")
        return True
    if (
        "NotificationAuthorizationTranslucentActivity" in focus_text
        or ("com.vivo.pushservice" in focus_text and "type=2038" in focus_text)
    ):
        base.run_adb(adb_path, serial, ["shell", "input", "keyevent", "4"], timeout=5)
        time.sleep(0.5)
        emit(log, "dismiss_system_popup", kind="notification_authorization", method="back")
        return True
    if any(package in focus_text for package in SYSTEM_PERMISSION_PACKAGES):
        # This workflow does not require camera, contacts, location, or media
        # permission. Back dismisses the prompt without changing user policy.
        base.run_adb(adb_path, serial, ["shell", "input", "keyevent", "4"], timeout=5)
        time.sleep(0.5)
        emit(log, "dismiss_system_popup", kind="permission_controller", method="back")
        return True
    return False


def handle_known_app_popup(snapshot, log):
    texts = visible_texts(snapshot)
    joined = "\n".join(texts)
    if "请移除遮挡物" in joined:
        for label in ("关闭", "不再提示"):
            nodes = exact_nodes(snapshot, label)
            if len(nodes) == 1:
                safe_click(nodes[0], log, "dismiss_system_popup", post_wait=0.5)
                log[-1].update(kind="vivo_proximity", action=label)
                return True
        emit(log, "known_system_popup_missing_safe_action", kind="vivo_proximity")
        return False
    if "无响应" in joined or "isn't responding" in joined:
        for label in ("等待", "Wait"):
            nodes = exact_nodes(snapshot, label)
            if len(nodes) == 1:
                safe_click(nodes[0], log, "dismiss_system_popup", post_wait=0.8)
                log[-1].update(kind="application_not_responding", action=label)
                return True
        emit(log, "known_system_popup_missing_safe_action", kind="application_not_responding")
        return False
    for marker in MANUAL_POPUP_MARKERS:
        if marker in joined:
            emit(log, "manual_popup_detected", marker=marker)
            raise RuntimeError(f"检测到需要人工确认的弹窗: {marker}")
    for rule in APP_POPUP_RULES:
        marker = next((value for value in rule["markers"] if value in joined), "")
        if not marker:
            continue
        for label in rule["actions"]:
            nodes = exact_nodes(snapshot, label)
            if len(nodes) == 1:
                safe_click(nodes[0], log, "dismiss_app_popup", post_wait=0.5)
                log[-1].update(kind=rule["kind"], marker=marker, action=label)
                return True
        emit(log, "known_app_popup_missing_safe_action", kind=rule["kind"], marker=marker)
        return False
    return False


def handle_known_popup(poco, adb_path, serial, log):
    if handle_known_system_popup(adb_path, serial, log):
        return True
    try:
        snapshot = poco.freeze()
    except Exception as exc:
        emit(log, "popup_snapshot_failed", error=repr(exc))
        return False
    return handle_known_app_popup(snapshot, log)


def wait_for(poco, predicate, adb_path, serial, log, label, timeout=20, recover=True):
    deadline = time.monotonic() + timeout
    attempts = 0
    last_error = ""
    last_popup_check = 0.0
    while time.monotonic() < deadline:
        attempts += 1
        try:
            snapshot = poco.freeze()
            value = predicate(snapshot)
            if value:
                emit(log, f"{label}_ready", attempts=attempts)
                return snapshot, value
        except Exception as exc:
            last_error = repr(exc)
        now = time.monotonic()
        if recover and now - last_popup_check >= 2:
            try:
                handle_known_popup(poco, adb_path, serial, log)
            except RuntimeError:
                raise
            last_popup_check = now
        time.sleep(0.7)
    emit(log, f"{label}_timeout", attempts=attempts, error=last_error)
    raise RuntimeError(f"等待 {label} 超时")


def find_current_city(snapshot):
    labels = find_city_labels(snapshot)
    if len(labels) != 1:
        return []
    try:
        nodes = list(snapshot(type="android.widget.TextView"))
    except Exception:
        return []
    _, label_y = labels[0].get_position()
    matches = []
    for node in nodes:
        try:
            text = str(node.attr("text") or "").strip()
            x, y = node.get_position()
            width, _ = node.get_size()
            parent = node.parent()
            parent_width, _ = parent.get_size()
            parent_touchable = bool(parent.attr("touchable"))
        except Exception:
            continue
        # Both known form variants render the current region as the only wide
        # TextView directly below the exact city label, inside a touchable row.
        # This avoids walking a broad ancestor that also contains phone,
        # privacy, agreement and submit texts in the newer form.
        if (
            text
            and text not in CITY_FIELD_LABELS
            and label_y + 0.02 <= y <= label_y + 0.12
            and x >= 0.10
            and width >= 0.25
            and parent_width >= 0.50
            and parent_touchable
        ):
            matches.append(node)
    return matches


def find_selected_region(snapshot, expected_region):
    current = find_current_city(snapshot)
    if len(current) != 1:
        return []
    try:
        value = str(current[0].attr("text") or "").strip()
    except Exception:
        return []
    value = normalize_autonomous_region_prefix(value)
    expected_region = normalize_autonomous_region_prefix(expected_region)
    return current if value.startswith(expected_region) else []


def find_vehicle_cards(snapshot):
    cards = []
    try:
        images = list(snapshot(type="android.widget.ImageView"))
    except Exception:
        images = []
    for image in images:
        try:
            image_x, image_y = image.get_position()
            image_width, image_height = image.get_size()
        except Exception:
            continue
        # The product artwork is the only large, non-touchable ImageView in
        # the lower-right product-card region. The CTA background is much
        # shorter and is excluded by the height gate. No text is consulted.
        if not (
            not bool(image.attr("touchable"))
            and image_x >= 0.65
            and 0.60 <= image_y <= 0.82
            and 0.22 <= image_width <= 0.42
            and 0.08 <= image_height <= 0.22
        ):
            continue
        current = image
        for _ in range(4):
            current = current.parent()
            try:
                x, y = current.get_position()
                width, height = current.get_size()
                touchable = bool(current.attr("touchable"))
            except Exception:
                break
            if (
                touchable
                and x >= 0.65
                and 0.60 <= y <= 0.86
                and 0.25 <= width <= 0.45
                and 0.15 <= height <= 0.35
            ):
                if current not in cards:
                    cards.append(current)
                break
    return cards


def enter_detail_form(poco, adb_path, serial, log):
    try:
        snapshot = poco.freeze()
        if len(find_city_labels(snapshot)) == 1:
            emit(log, "detail_form_already_open")
            emit(log, "detail_form_scroll")
            poco.swipe([0.5, 0.78], [0.5, 0.40], duration=0.8)
            wait_for(
                poco,
                find_city_labels,
                adb_path,
                serial,
                log,
                "detail_form_after_scroll",
                timeout=12,
                recover=True,
            )
            return
    except Exception:
        pass

    _, cards = wait_for(
        poco, find_vehicle_cards, adb_path, serial, log, "vehicle_card", timeout=15, recover=True
    )
    if len(cards) != 1:
        raise RuntimeError(f"车型卡片不唯一: {len(cards)}")
    # Click the upper artwork area of the proven card, never the changing CTA.
    safe_click(cards[0], log, "click_vehicle_card", focus=[0.5, 0.32], post_wait=1.2)

    # The product sheet can render the label just below the viewport. The
    # gesture uses normalized coordinates but starts only after the detail
    # card element and sheet transition have been proven.
    wait_for(
        poco,
        find_city_labels,
        adb_path,
        serial,
        log,
        "detail_form",
        timeout=25,
        recover=True,
    )
    emit(log, "detail_form_scroll")
    poco.swipe([0.5, 0.78], [0.5, 0.40], duration=0.8)
    wait_for(
        poco,
        find_city_labels,
        adb_path,
        serial,
        log,
        "detail_form_after_scroll",
        timeout=12,
        recover=True,
    )


def enter_city_query(poco, adb_path, serial, city_query, log):
    try:
        _, searches = wait_for(
            poco,
            find_kuaishou_edit_fields,
            adb_path,
            serial,
            log,
            "city_search",
            timeout=12,
        )
        if len(searches) != 1:
            raise RuntimeError(f"城市搜索框不唯一: {len(searches)}")
        # Kuaishou only fires the search field's change handler after the
        # actual EditText has focus.
        safe_click(searches[0], log, "focus_city_search", post_wait=0.3)

        # The Vivo IME exposes its own composing EditText while the keyboard
        # is open. A broad type-only selector can write the city into that
        # candidate strip. Select the one exact Kuaishou EditText name.
        live_searches = list(
            poco(name=KUAISHOU_EDIT_TEXT_NAME, type="android.widget.EditText")
        )
        if len(live_searches) != 1:
            raise RuntimeError(f"快手城市搜索框不唯一: {len(live_searches)}")
        live_searches[0].set_text("")
        live_searches[0].set_text(city_query)
        emit(log, "set_city_query", value=city_query)

        _, input_fields = wait_for(
            poco,
            lambda s: exact_nodes(s, city_query, "android.widget.EditText"),
            adb_path,
            serial,
            log,
            "city_query_in_field",
            timeout=15,
            recover=False,
        )
        if len(input_fields) != 1:
            raise RuntimeError(f"城市搜索框写入校验失败: {len(input_fields)}")

        # Do not hide the keyboard until the actual field value and the exact
        # lower result coexist.
        _, state = wait_for(
            poco,
            lambda s: find_city_search_state(s, city_query),
            adb_path,
            serial,
            log,
            "city_query_and_result_before_keyboard_hide",
            timeout=15,
            recover=False,
        )
        return state
    except CityStateRefreshRequired:
        raise
    except Exception as exc:
        raise CityStateRefreshRequired(
            "城市搜索写入或校验通道失效；只允许重建 Poco 后原地继续"
        ) from exc


def complete_city_picker(poco, adb_path, serial, city_query, expected_region, log):
    try:
        snapshot = poco.freeze()
        selected = find_selected_region(snapshot, expected_region)
        if len(selected) == 1:
            emit(log, "selected_region_already_ready_after_rebuild")
            return
        picker_markers = exact_nodes(snapshot, "选择地区", "android.widget.TextView")
        if len(picker_markers) != 1:
            raise RuntimeError("重建后既非已选中表单，也非唯一城市选择页")
        search_state = find_city_search_state(snapshot, city_query)
    except Exception as exc:
        raise CityStateRefreshRequired("城市选择页 Poco 读取通道失效") from exc
    if search_state:
        emit(log, "city_query_and_result_already_ready")
    else:
        search_state = enter_city_query(poco, adb_path, serial, city_query, log)

    keyboard_deadline = time.monotonic() + 2.0
    while time.monotonic() < keyboard_deadline:
        if soft_keyboard_is_shown(adb_path, serial):
            break
        time.sleep(0.2)
    try:
        hide_soft_keyboard_if_shown(poco, adb_path, serial, log)
    except Exception as exc:
        raise CityStateRefreshRequired(
            "键盘收起元素通道失效；只允许重建 Poco 后原地继续"
        ) from exc
    time.sleep(1.0)
    emit(log, "city_keyboard_settled", seconds=1)

    try:
        _, search_state = wait_for(
            poco,
            lambda s: find_city_search_state(s, city_query),
            adb_path,
            serial,
            log,
            "city_query_and_result_after_keyboard",
            timeout=4,
            recover=False,
        )
    except RuntimeError as exc:
        raise CityStateRefreshRequired(
            "收键盘后当前 Poco 未刷新城市双节点；只允许重建读取通道"
        ) from exc
    click_city_result(poco, adb_path, serial, city_query, expected_region, log, search_state)


def select_city(poco, adb_path, serial, city_query, expected_region, log):
    snapshot, current = wait_for(
        poco, find_current_city, adb_path, serial, log, "current_city", timeout=10
    )
    if len(current) != 1:
        raise RuntimeError(f"当前城市元素不唯一: {len(current)}")
    safe_click(current[0].parent(), log, "open_city_picker", post_wait=0.8)
    complete_city_picker(
        poco, adb_path, serial, city_query, expected_region, log
    )


def click_city_result(poco, adb_path, serial, city_query, expected_region, log, search_state):
    search_fields, results = search_state
    if results[0].get_position()[1] <= search_fields[0].get_position()[1]:
        raise RuntimeError("城市搜索结果位置异常")
    # Verified on-device: only the city text node triggers selection reliably;
    # tapping the row center or decorative trailing circle does not.
    safe_click(results[0], log, "select_city_result", post_wait=1.0)

    try:
        _, verified = wait_for(
            poco,
            lambda s: find_selected_region(s, expected_region),
            adb_path,
            serial,
            log,
            "selected_region_first_click",
            timeout=4,
            recover=False,
        )
    except RuntimeError:
        try:
            _, retry_state = wait_for(
                poco,
                lambda s: find_city_search_state(s, city_query),
                adb_path,
                serial,
                log,
                "city_result_retry",
                timeout=6,
                recover=False,
            )
        except RuntimeError as exc:
            raise CityStateRefreshRequired(
                "城市结果点击后 Poco 未刷新；只允许重建读取通道后复核当前页"
            ) from exc
        _, retry_results = retry_state
        safe_click(retry_results[0], log, "select_city_result_retry", post_wait=1.0)
        _, verified = wait_for(
            poco,
            lambda s: find_selected_region(s, expected_region),
            adb_path,
            serial,
            log,
            "selected_region",
            timeout=12,
        )
    if len(verified) != 1:
        raise RuntimeError("城市选择后校验失败")


def set_phone(poco, adb_path, serial, phone, log):
    def phone_fields(snapshot):
        try:
            fields = list(snapshot(type="android.widget.EditText"))
        except Exception:
            return []
        return [node for node in fields if node.attr("visible")]

    snapshot, fields = wait_for(
        poco, phone_fields, adb_path, serial, log, "phone_field", timeout=10
    )
    if len(fields) != 1:
        raise RuntimeError(f"手机号输入框不唯一: {len(fields)}")
    old_text = fields[0].attr("text") or ""
    live_field = poco(text=old_text) if old_text else poco(type="android.widget.EditText")
    live_field.set_text("")
    live_field.set_text(phone)
    _, verified = wait_for(
        poco,
        lambda s: exact_nodes(s, phone, "android.widget.EditText"),
        adb_path,
        serial,
        log,
        "phone_value",
        timeout=8,
    )
    if len(verified) != 1:
        raise RuntimeError("手机号写入校验失败")
    emit(log, "phone_verified", masked=f"{phone[:3]}****{phone[-4:]}")


def close_success(poco, log):
    snapshot = poco.freeze()
    if len(exact_nodes(snapshot, "预约成功")) != 1:
        return False
    candidates = []
    try:
        groups = list(snapshot(type="android.view.ViewGroup"))
    except Exception:
        groups = []
    for node in groups:
        try:
            x, y = node.get_position()
            w, h = node.get_size()
            touchable = bool(node.attr("touchable"))
        except Exception:
            continue
        if x > 0.85 and 0.15 < y < 0.30 and w <= 0.16 and h <= 0.10 and touchable:
            candidates.append(node)
    if len(candidates) != 1:
        emit(log, "success_close_not_unique", candidates=len(candidates))
        return False
    safe_click(candidates[0], log, "close_success", post_wait=0.8)
    return True


def submit_and_confirm(poco, adb_path, serial, log):
    _, buttons = wait_for(
        poco,
        lambda s: exact_nodes(s, "询底价"),
        adb_path,
        serial,
        log,
        "submit_button",
        timeout=10,
    )
    if len(buttons) != 1:
        raise RuntimeError(f"询底价按钮不唯一: {len(buttons)}")
    safe_click(buttons[0].parent(), log, "submit_vehicle_lead", post_wait=0.8)
    emit(log, "submission_boundary_crossed")
    try:
        wait_for(
            poco,
            lambda s: exact_nodes(s, "预约成功"),
            adb_path,
            serial,
            log,
            "submission_success",
            timeout=30,
            recover=False,
        )
    except Exception as exc:
        raise SubmittedUnknown("已点击询底价，但未能确认预约结果；禁止自动重试") from exc
    if not close_success(poco, log):
        raise SubmissionSucceededCloseFailed("预约已成功，但未能唯一定位关闭按钮")


def validate_payload(payload):
    phone = re.sub(r"\s+", "", str(payload.get("phone") or ""))
    city_query = str(payload.get("cityQuery") or "").strip()
    expected_region = str(payload.get("region") or "").strip()
    if not re.fullmatch(r"1\d{10}", phone):
        raise ValueError("phone 必须是 11 位手机号")
    if not city_query or not expected_region:
        raise ValueError("cityQuery 和 region 不能为空")
    city_query, expected_region = normalize_kuaishou_region(
        city_query, expected_region
    )
    return phone, city_query, expected_region


def run(payload, poco=None):
    log = []
    submitted = False
    owns_poco = False
    started = time.perf_counter()
    serial = str(payload["serial"])
    adb_path = str(payload.get("adbPath") or "adb")
    phone, city_query, expected_region = validate_payload(payload)
    base.CURRENT_ADB_PATH = adb_path
    base.CURRENT_SERIAL = serial
    try:
        if poco is None:
            poco = create_connected_poco(adb_path, serial)
            owns_poco = True
        base.wake_and_unlock(adb_path, serial, log)
        try:
            enter_detail_form(poco, adb_path, serial, log)
        except RuntimeError as exc:
            if not owns_poco or not should_rebuild_entry_poco(exc):
                raise
            # A card tap can already have opened the sheet while the original
            # Poco channel keeps returning the pre-transition tree. Rebuild
            # only the element-reading channel, then re-evaluate the current
            # page without replaying any phone or submit action.
            emit(log, "rebuild_entry_poco_after_stale_hierarchy", reason=str(exc))
            base.stop_stable_poco(poco, adb_path, serial)
            poco = create_connected_poco(adb_path, serial)
            enter_detail_form(poco, adb_path, serial, log)
        dry_run = payload.get("dryRun")
        if dry_run is True or dry_run == "form":
            emit(log, "dry_run_form_ready")
            return {
                "ok": True,
                "status": "dry_run",
                "submitted": False,
                "elapsedMs": int((time.perf_counter() - started) * 1000),
                "log": log,
            }
        try:
            select_city(poco, adb_path, serial, city_query, expected_region, log)
        except CityStateRefreshRequired:
            if not owns_poco:
                raise
            emit(log, "rebuild_city_poco_in_place")
            base.stop_stable_poco(poco, adb_path, serial)
            poco = create_connected_poco(adb_path, serial)
            complete_city_picker(
                poco, adb_path, serial, city_query, expected_region, log
            )
        if dry_run == "city":
            emit(log, "dry_run_city_selected", region=expected_region)
            return {
                "ok": True,
                "status": "dry_run_city",
                "submitted": False,
                "elapsedMs": int((time.perf_counter() - started) * 1000),
                "log": log,
            }
        set_phone(poco, adb_path, serial, phone, log)
        submit_and_confirm(poco, adb_path, serial, log)
        submitted = True
        return {
            "ok": True,
            "status": "success",
            "submitted": True,
            "elapsedMs": int((time.perf_counter() - started) * 1000),
            "log": log,
        }
    except SubmittedUnknown as exc:
        emit(log, "submitted_unknown", error=str(exc))
        return {
            "ok": False,
            "status": "submitted_unknown",
            "submitted": True,
            "retryable": False,
            "error": str(exc),
            "log": log,
        }
    except SubmissionSucceededCloseFailed as exc:
        emit(log, "success_close_failed", error=str(exc))
        return {
            "ok": False,
            "status": "success_close_failed",
            "submitted": True,
            "retryable": False,
            "error": str(exc),
            "log": log,
        }
    except Exception as exc:
        emit(log, "error", error=repr(exc), trace=traceback.format_exc())
        return {
            "ok": False,
            "status": "failed_before_submit",
            "submitted": submitted,
            "retryable": True,
            "error": str(exc),
            "log": log,
        }
    finally:
        if owns_poco and poco is not None:
            try:
                base.stop_stable_poco(poco, adb_path, serial)
            except Exception as exc:
                emit(log, "poco_cleanup_error", error=repr(exc))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", required=True)
    args = parser.parse_args()
    with open(args.payload, "r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)
    print(json.dumps({"result": run(payload)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
