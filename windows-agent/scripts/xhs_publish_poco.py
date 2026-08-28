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


def click_exact(poco, labels, log, step, timeout=12, y_min=0.0, y_max=1.0):
    deadline = time.time() + timeout
    popup_checked = False
    while time.time() < deadline:
        for label in labels:
            for node in exact_nodes(poco, label):
                try:
                    _, y = node.get_position()
                    if not (y_min <= y <= y_max):
                        continue
                    base.tap_node(node)
                    base.emit(log, step, label=label, selector="exact_poco_element", position=node.get_position())
                    return True
                except Exception:
                    continue
        if not popup_checked and time.time() + 4 >= deadline:
            popup_checked = True
            base.handle_common_popups(poco, log)
        time.sleep(0.3)
    base.emit(log, step, hit=False, labels=labels, texts=base.list_texts(poco, limit=50))
    return False


def visible_edit_texts(poco):
    rows = []
    try:
        nodes = poco("android.widget.EditText")
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
        editors = visible_edit_texts(poco)
        if len(editors) >= 2:
            editors[0].set_text(title)
            base.emit(log, "set_publish_title", selector="first_visible_EditText", length=len(title))
            editors[1].set_text(content)
            base.emit(log, "set_publish_content", selector="second_visible_EditText", length=len(content))
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
                for selected, (_, _, width, height, name, node) in enumerate(candidates[:count], start=1):
                    position = node.get_position()
                    base.tap_node(node, post_wait=0.35)
                    base.emit(
                        log,
                        "select_publish_image",
                        index=selected,
                        selector="bounded_gallery_thumbnail_element",
                        position=position,
                        size=[width, height],
                        name=name,
                        candidateCount=len(candidates),
                    )
                return True
        except Exception as exc:
            base.emit(log, "publish_gallery_candidates_failed", error=repr(exc))
        time.sleep(0.35)
    base.emit(log, "select_publish_images_incomplete", requested=count, selected=0, texts=base.list_texts(poco, limit=50))
    return False


def launch_xhs(payload, log):
    serial = payload["serial"]
    adb_path = payload.get("adbPath") or "adb"
    package_name = payload.get("xhsPackageName") or "com.xingin.xhs"
    base.require_default_internet_route(adb_path, serial, log)
    base.wake_and_unlock(adb_path, serial, log)
    base.grant_xhs_media_access(adb_path, serial, package_name, log)
    base.reset_launch_surface(adb_path, serial, log)
    base.run_adb(adb_path, serial, ["shell", "am", "force-stop", package_name], timeout=10)
    activity = base.resolve_activity(adb_path, serial, package_name)
    base.start_xhs_activity(adb_path, serial, activity, package_name, log)
    poco = base.create_stable_poco(use_airtest_input=True, screenshot_each_action=False)
    slot = "Ⅱ·小红书" if payload.get("xhsAppSlot") == "app2" else "小红书"
    base.choose_xhs_slot(poco, adb_path, serial, slot, log)
    base.clear_popups_rounds(poco, log, rounds=1)
    return poco


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
        if not click_exact(poco, ["发布", "+", "创作"], log, "open_publish_entry", timeout=15, y_min=0.72):
            raise RuntimeError("xhs_publish_entry_not_found")
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
        if not click_exact(poco, ["发布"], log, "click_final_publish", timeout=12, y_min=0.55):
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
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
