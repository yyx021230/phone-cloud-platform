#!/usr/bin/env python3
"""State-preserving, element-driven Alipay masked-name lookup task runner.

Each invocation is short lived, while the phone remains on Alipay's global
search page between invocations. A query therefore reuses the visible page;
only an evidenced abnormal state triggers a bounded full-path recovery.
"""
import argparse
import json
import os
import re
import subprocess
import time
import traceback
import xml.etree.ElementTree as ET

ALIPAY_PACKAGE = "com.eg.android.AlipayGphone"
ALIPAY_HOME = "com.eg.android.AlipayGphone/.AlipayLogin"
SEARCH_INPUT_ID = "com.alipay.mobile.antui:id/search_input_box"
ACCOUNT_ID = "com.alipay.mobile.securitybiz:id/tv_am_item_account"
ACCOUNT_CURRENT_ID = "com.alipay.mobile.securitybiz:id/tv_am_item_current"
TAB_DESCRIPTION_ID = "com.alipay.android.tablauncher:id/tab_description"
SETTINGS_ENTRY_ID = "com.alipay.mobile.antui:id/right_text"
VERIFICATION_TITLE = "为保障您的正常访问请进行验证"
VERIFICATION_ACTION = "向右滑动验证"
ACCESS_DENIED_TITLE = "访问被拒绝"
ACCESS_DENIED_PROXY_HINT = "代理软件"
ACCESS_DENIED_VPN_HINT = "VPN"
# Leave room for Agent dispatch and result persistence so the user-visible
# no-name response stays close to five seconds end to end.
POCO_NO_NAME_RESULT_SECONDS = 4.4
POCO_SEARCH_SUBMIT_DELAY_SECONDS = 0.4


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
        self._display_size = None

    def emit(self, step, **detail):
        item = {"step": step, "elapsedMs": int((time.perf_counter() - self.started) * 1000), **detail}
        self.log.append(item)
        print(json.dumps({"event": item}, ensure_ascii=True), flush=True)

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

    def dump(self, token):
        remote = f"/sdcard/PhoneCloud/.alipay-name-{self.task_id}-{token}.xml"
        self.adb(["shell", "mkdir", "-p", "/sdcard/PhoneCloud"], timeout=8)
        self.adb(["shell", "uiautomator", "dump", remote], timeout=15, check=False)
        raw = self.adb(["exec-out", "cat", remote], timeout=12, binary=True)
        if b"<hierarchy" not in raw:
            raw = self.adb(["exec-out", "uiautomator", "dump", "/dev/tty"], timeout=15, check=False, binary=True)
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
        slider = VERIFICATION_ACTION
        if protected in texts or slider in texts:
            return {
                "title": protected if protected in texts else "",
                "action": slider if slider in texts else "",
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

    def raise_access_denied(self, evidence, phase, driver):
        self.emit(
            "alipay_access_denied_detected",
            phase=phase,
            driver=driver,
            title=evidence.get("title", ""),
            accountSwitchRequired=True,
        )
        raise RuntimeError("alipay_access_denied_account_switch_required")

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
            end_x, end_y = x2 - knob_half, start_y
            duration_ms = 1000 + (attempt - 1) * 200
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
        raise RuntimeError("alipay_human_verification_required")

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
        while time.time() < deadline:
            root, parent = self.dump(token)
            access_denied = self.access_denied_evidence(root)
            if access_denied:
                self.raise_access_denied(access_denied, token, "xml_uiautomator")
            verification = self.verification_evidence(root)
            if verification:
                root, parent = self.solve_human_verification(root, parent, token)
            matches = self.find(root, **selector)
            if len(matches) == 1:
                return root, parent, matches[0]
            if len(matches) > 1:
                raise RuntimeError(f"selector_not_unique:{selector!r}")
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
                access_denied = self.access_denied_evidence(root)
                if access_denied:
                    self.raise_access_denied(access_denied, "search-ready-focus", "xml_uiautomator")
            except Exception as exc:
                if "alipay_access_denied_account_switch_required" in str(exc):
                    raise
                self.emit("access_denied_probe_unavailable", phase="search-ready-focus", driver="xml_uiautomator", error=str(exc))
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

    @staticmethod
    def descendant_texts(node):
        values = []
        for child in node.iter("node"):
            for key in ("text", "content-desc"):
                value = (child.get(key) or "").strip()
                if value and value not in values:
                    values.append(value)
        return values

    def parse_result(self, root, parent, phone):
        parent = parent or {child: node for node in root.iter() for child in node}
        patterns = [
            re.compile(r"[\(（]\*+([^\(\)（）\s])[\)）]\s*$"),
            re.compile(r"^\*+([\u4e00-\u9fff])$"),
            re.compile(r"^.{1,12}\*+([\u4e00-\u9fff])$"),
        ]
        candidates = []
        for node in root.iter("node"):
            display = (node.get("text") or "").strip()
            match = next((pattern.search(display) for pattern in patterns if pattern.search(display)), None)
            if match:
                candidates.append((node, display, next(group for group in match.groups() if group)))

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
        except Exception:
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
        if VERIFICATION_TITLE in texts and VERIFICATION_ACTION in texts:
            return {"title": VERIFICATION_TITLE, "action": VERIFICATION_ACTION}
        return None

    def poco_access_denied_evidence(self, snapshot):
        return self.access_denied_evidence_from_texts(self.poco_snapshot_texts(snapshot, 160))

    def poco_raise_if_access_denied(self, snapshot, phase):
        evidence = self.poco_access_denied_evidence(snapshot)
        if evidence:
            self.raise_access_denied(evidence, phase, "poco")

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
            end_x = max(1, min(width - 1, int(round(right * width)) - knob_half))
            end_y = start_y
            duration_ms = 1000 + (attempt - 1) * 200
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
        raise RuntimeError("poco_alipay_human_verification_required")

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

    def poco_unique(self, poco, timeout=3.0, **selector):
        deadline = time.time() + timeout
        last_count = 0
        while time.time() < deadline:
            try:
                nodes = self.poco_nodes(poco, **selector)
            except Exception as exc:
                raise RuntimeError(f"poco_rpc_failed:{exc}") from exc
            last_count = len(nodes)
            if last_count == 1:
                return nodes[0]
            if last_count > 1:
                raise RuntimeError(f"poco_selector_not_unique:{selector!r}")
            time.sleep(0.15)
        raise RuntimeError(f"poco_selector_missing:{selector!r}; count={last_count}")

    def poco_search_ready(self, poco):
        focus = "\n".join(self.focus())
        if "com.eg.android.AlipayGphone" not in focus or "MainSearchActivity" not in focus:
            try:
                snapshot = poco.freeze()
                self.poco_raise_if_access_denied(snapshot, "search-ready-focus")
            except Exception as exc:
                if "alipay_access_denied_account_switch_required" in str(exc):
                    raise
                self.emit("access_denied_probe_unavailable", phase="search-ready-focus", driver="poco", error=str(exc))
            raise RuntimeError(f"poco_alipay_search_not_foreground:{focus}")
        try:
            return self.poco_unique(poco, timeout=2.0, name=SEARCH_INPUT_ID)
        except Exception as exc:
            try:
                snapshot = poco.freeze()
                self.poco_raise_if_access_denied(snapshot, "search-ready-selector")
            except Exception as probe_exc:
                if "alipay_access_denied_account_switch_required" in str(probe_exc):
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

    def poco_open_search(self, poco, reason):
        self.poco_dismiss_known_overlay(poco)
        search = self.poco_unique(poco, timeout=8.0, desc="搜索框")
        self.poco_tap(search)
        self.emit("open_search", reason=reason, driver="poco")
        time.sleep(0.35)
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
        self.poco_dismiss_known_overlay(poco)
        snapshot = poco.freeze()
        self.poco_raise_if_access_denied(snapshot, f"prepare-full-path-{reason}")
        if self.poco_verification_evidence(snapshot):
            if verification_recoveries >= 2:
                raise RuntimeError("poco_alipay_human_verification_repeatedly_invalidated_start")
            self.poco_solve_human_verification(poco, f"{reason}-launch")
            return self.poco_prepare_full_path(poco, reason, verification_recoveries + 1)
        self.poco_open_search(poco, reason)

    def poco_try_reuse_search_page(self, poco):
        focus = "\n".join(self.focus())
        if "com.eg.android.AlipayGphone" in focus and "MainSearchActivity" in focus:
            self.poco_search_ready(poco)
            self.emit("reuse_existing_search_page", method="poco_already_foreground")
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

    def query_once_poco(self, poco, phone, verification_recoveries=0, query_deadline=None):
        if query_deadline is None:
            query_deadline = time.perf_counter() + 40.0
        no_name_deadline = time.time() + POCO_NO_NAME_RESULT_SECONDS
        input_node = self.poco_search_ready(poco)
        try:
            input_node.set_text("")
            self.emit("clear_previous_query", selector="exact_search_input", driver="poco")
            input_node.set_text(phone)
            self.emit("input_phone", method="poco_set_text", driver="poco")
        except Exception as exc:
            raise RuntimeError(f"poco_input_failed:{exc}") from exc

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
                raise RuntimeError(f"poco_freeze_failed:{exc}") from exc
            self.poco_raise_if_access_denied(snapshot, "input-readback")
            if self.poco_verification_evidence(snapshot):
                if verification_recoveries >= 2:
                    raise RuntimeError("poco_alipay_human_verification_repeatedly_invalidated_query")
                next_attempt = verification_recoveries + 1
                self.poco_solve_human_verification(poco, f"input-readback-{next_attempt}")
                self.emit(
                    "replay_query_after_human_verification", recoveryAttempt=next_attempt,
                    phase="input-readback", driver="poco",
                )
                self.poco_prepare_full_path(poco, f"verification-recovery-{next_attempt}")
                return self.query_once_poco(poco, phone, next_attempt, query_deadline)
            result = self.parse_poco_result(snapshot, phone)
            if result:
                self.emit(
                    "masked_real_name_tail_extracted", character=result["realNameTailCharacter"],
                    matchMethod=result["matchMethod"], driver="poco",
                )
                return result
            try:
                inputs = self.poco_nodes(snapshot, name=SEARCH_INPUT_ID)
                actual = self.poco_text(inputs[0]) if len(inputs) == 1 else ""
                actual_digits = re.sub(r"\D", "", actual)
            except Exception as exc:
                raise RuntimeError(f"poco_input_readback_failed:{exc}") from exc
            if actual_digits == phone:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError(f"search_input_readback_mismatch:length={len(actual_digits)}")

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
                raise RuntimeError(f"poco_freeze_failed:{exc}") from exc
            self.poco_raise_if_access_denied(snapshot, "result")
            if self.poco_verification_evidence(snapshot):
                if verification_recoveries >= 2:
                    raise RuntimeError("poco_alipay_human_verification_repeatedly_invalidated_query")
                next_attempt = verification_recoveries + 1
                self.poco_solve_human_verification(poco, f"result-{next_attempt}")
                self.emit(
                    "replay_query_after_human_verification", recoveryAttempt=next_attempt,
                    phase="result", driver="poco",
                )
                self.poco_prepare_full_path(poco, f"verification-recovery-{next_attempt}")
                return self.query_once_poco(poco, phone, next_attempt, query_deadline)
            result = self.parse_poco_result(snapshot, phone)
            if result:
                self.emit(
                    "masked_real_name_tail_extracted",
                    character=result["realNameTailCharacter"],
                    matchMethod=result["matchMethod"],
                    driver="poco",
                )
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
            raise RuntimeError("poco_search_submit_unavailable")
        try:
            inputs = self.poco_nodes(last_snapshot, name=SEARCH_INPUT_ID)
            actual = self.poco_text(inputs[0]) if len(inputs) == 1 else ""
            actual_digits = re.sub(r"\D", "", actual)
        except Exception as exc:
            raise RuntimeError(f"poco_result_state_readback_failed:{exc}") from exc
        if actual_digits != phone:
            raise RuntimeError(f"poco_result_page_state_changed:length={len(actual_digits)}")
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
            self.adb(["shell", "svc", "power", "stayon", "usb"], timeout=8, check=False)
            try:
                reused = self.poco_try_reuse_search_page(poco)
            except Exception as exc:
                self.emit("reuse_search_page_failed", error=str(exc), driver="poco")
                reused = False
            if not reused:
                self.poco_prepare_full_path(poco, "session-start")
            return {"ok": True, "message": "search_session_ready", "currentAccount": "", "log": self.log}
        if operation == "stop":
            input_node = self.poco_search_ready(poco)
            input_node.set_text("")
            self.emit("clear_previous_query", selector="exact_search_input", driver="poco")
            self.emit("lookup_session_stopped", searchPageKeptWarm=True, driver="poco")
            return {"ok": True, "message": "session_stopped", "log": self.log}
        if operation != "query":
            raise RuntimeError("unsupported_operation")
        successful_before = max(0, int(self.payload.get("successfulCountBefore") or 0))
        switch_every = max(1, int(self.payload.get("switchEvery") or 200))
        if successful_before > 0 and successful_before % switch_every == 0:
            raise RuntimeError("poco_account_switch_requires_xml")
        phone = re.sub(r"\D", "", str(self.payload.get("phoneNumber") or ""))
        if not re.fullmatch(r"1\d{10}", phone):
            raise RuntimeError("invalid_phone_number")
        result = self.query_once_poco(poco, phone)
        return {
            "ok": True, **result, "currentAccount": "", "accountSwitched": False,
            "recoveryAttempts": 0,
            "elapsedMs": int((time.perf_counter() - self.started) * 1000), "log": self.log,
        }

    def current_account(self):
        # The picker is not opened during the fast path. Return an empty value
        # unless a switch just produced exact account evidence.
        return ""

    def clear_search_input(self, root, parent, input_node):
        target = self.tappable(input_node, parent)
        x, y = self.bounds_center(target.get("bounds"))
        self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
        self.adb(["shell", "input", "keyevent", "123"], timeout=5, check=False)
        for _ in range(24):
            self.adb(["shell", "input", "keyevent", "67"], timeout=5)
        self.emit("clear_previous_query", selector="exact_search_input")

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
        root, parent, _ = self.wait_unique(f"account-picker-{token}", text="切换账号")
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

    def switch_account(self):
        self.launch("account-switch")
        rows = self.open_account_picker("before")
        current = next((row for row in rows if row[1]), None)
        target = next((row for row in rows if not row[1]), None)
        if current is None or target is None:
            raise RuntimeError("alipay_saved_account_candidate_missing")
        x, y = self.bounds_center(target[2].get("bounds"))
        self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
        self.emit("account_selected", fromAccount=current[0], toAccount=target[0], selector="exact_account_resource")
        self.wait_unique("account-switch-returned-home", timeout=20, text="我的")
        self.emit("account_selection_returned_home")
        verified_rows = self.open_account_picker("verify")
        verified = next((row for row in verified_rows if row[1]), None)
        if verified is None or verified[0] != target[0]:
            actual = verified[0] if verified else ""
            raise RuntimeError(f"alipay_account_switch_verification_failed:expected={target[0]};actual={actual}")
        self.emit(
            "account_switch_verified", fromAccount=current[0], currentAccount=verified[0],
            verification="exact_current_marker",
        )
        self.launch("account-switch-complete")
        self.open_search("account-switch-complete")
        return verified[0]

    def switch_account_for_reason(self, reason):
        self.emit("account_switch_triggered", reason=reason, retryCurrentPhone=True)
        current_account = self.switch_account()
        self.account_switched = True
        self.current_account_after_switch = current_account
        self.account_switch_reason = reason
        return current_account

    def query_once(self, phone, verification_recoveries=0, query_deadline=None):
        if query_deadline is None:
            query_deadline = time.perf_counter() + 55.0
        root, parent, input_node = self.search_ready()
        self.clear_search_input(root, parent, input_node)
        self.adb(["shell", "input", "text", phone], timeout=8)
        self.emit("input_phone", method="reuse_search_EditText")
        input_deadline = time.time() + 4
        actual_digits = ""
        while time.time() < input_deadline:
            root, parent = self.dump("input-readback")
            access_denied = self.access_denied_evidence(root)
            if access_denied:
                self.raise_access_denied(access_denied, "input-readback", "xml_uiautomator")
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
                break
            time.sleep(0.3)
        else:
            raise RuntimeError(f"search_input_readback_mismatch:length={len(actual_digits)}")
        remaining_budget = max(0.0, query_deadline - time.perf_counter())
        deadline = time.time() + min(10.0, remaining_budget)
        submit_after = time.time() + 1.5
        submitted = False
        while time.time() < deadline:
            root, parent = self.dump("result")
            access_denied = self.access_denied_evidence(root)
            if access_denied:
                self.raise_access_denied(access_denied, "result", "xml_uiautomator")
            verification = self.verification_evidence(root)
            if verification:
                root, parent = self.solve_human_verification(root, parent, "result")
                result = self.parse_result(root, parent, phone)
                if result:
                    self.emit(
                        "masked_real_name_tail_extracted",
                        character=result["realNameTailCharacter"],
                        matchMethod=result.get("matchMethod", ""),
                    )
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
                self.emit(
                    "masked_real_name_tail_extracted",
                    character=result["realNameTailCharacter"],
                    matchMethod=result.get("matchMethod", ""),
                )
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

    def run(self):
        operation = str(self.payload.get("operation") or "")
        if self.adb(["get-state"], timeout=8).strip() != "device":
            raise RuntimeError("device_not_online")
        if not self.adb(["shell", "pm", "path", ALIPAY_PACKAGE], timeout=10).strip():
            raise RuntimeError("alipay_not_installed")
        if operation == "start":
            self.adb(["shell", "svc", "power", "stayon", "usb"], timeout=8, check=False)
            try:
                reused = self.try_reuse_search_page()
            except Exception as exc:
                self.emit("reuse_search_page_failed", error=str(exc))
                reused = False
            if not reused:
                self.prepare_full_path("session-start")
            return {"ok": True, "message": "search_session_ready", "currentAccount": self.current_account(), "log": self.log}
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
        successful_before = max(0, int(self.payload.get("successfulCountBefore") or 0))
        switch_every = max(1, int(self.payload.get("switchEvery") or 200))
        forced_switch_reason = str(self.payload.get("forceAccountSwitchReason") or "").strip()
        if successful_before > 0 and successful_before % switch_every == 0:
            self.switch_account_for_reason("success_limit")
        elif forced_switch_reason == "access_denied":
            self.switch_account_for_reason("access_denied")
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
                    if "alipay_access_denied_account_switch_required" in raw_error:
                        raise
                    if "alipay_human_verification_required" in raw_error:
                        raise
                    query_elapsed = time.perf_counter() - query_started
                    if attempt >= max_recoveries or query_elapsed >= 50:
                        break
                    self.emit("query_full_path_recovery", attempt=attempt + 1, error=raw_error)
                    self.prepare_full_path(f"query-recovery-{attempt + 1}")
            raise RuntimeError(f"alipay_lookup_failed_after_recovery:{last_error}")

        try:
            result, recovery_attempts = query_with_recovery()
        except Exception as exc:
            if "alipay_access_denied_account_switch_required" not in str(exc):
                raise
            if self.account_switched:
                self.emit(
                    "alipay_access_denied_after_account_switch",
                    reason=self.account_switch_reason,
                    currentAccount=self.current_account_after_switch,
                )
                raise RuntimeError("alipay_access_denied_after_account_switch") from exc
            self.switch_account_for_reason("access_denied")
            try:
                result, recovery_attempts = query_with_recovery()
            except Exception as retry_exc:
                if "alipay_access_denied_account_switch_required" in str(retry_exc):
                    self.emit(
                        "alipay_access_denied_after_account_switch",
                        reason=self.account_switch_reason,
                        currentAccount=self.current_account_after_switch,
                    )
                    raise RuntimeError("alipay_access_denied_after_account_switch") from retry_exc
                raise
        return {
            "ok": True,
            **result,
            "currentAccount": self.current_account_after_switch,
            "accountSwitched": self.account_switched,
            "accountSwitchReason": self.account_switch_reason,
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
            "elapsedMs": int((time.perf_counter() - runner.started) * 1000),
            "log": runner.log,
        }
    print(json.dumps(result, ensure_ascii=True), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
