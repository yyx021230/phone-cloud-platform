#!/usr/bin/env python3
"""Local behavior tests for the two automation runners, without a phone."""
import importlib.util
import pathlib
import sys
import types
import unittest
import xml.etree.ElementTree as ET
from unittest import mock


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent


def load_module(name, file_name):
    spec = importlib.util.spec_from_file_location(name, SCRIPT_DIR / file_name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def phone_keycodes(phone):
    return [str(7 + int(digit)) for digit in phone]


def is_phone_keyevent_command(args, phone):
    return (
        args[:4] == ["shell", "input", "keyevent", "--delay"]
        and args[5:] == phone_keycodes(phone)
    )


class FakeNode:
    def __init__(self, name, position, size=(0.2, 0.2), exists=True):
        self.name = name
        self.position = position
        self.size = size
        self._exists = exists
        self.tapped = 0
        self.value = ""

    def exists(self):
        return self._exists

    def attr(self, key):
        return self.name if key == "name" else ""

    def get_position(self):
        return self.position

    def get_size(self):
        return self.size

    def set_text(self, value):
        self.value = value


class FakePoco:
    def __init__(self, images=None, editors=None):
        self.images = images or []
        self.editors = editors or []
        self.multi = FakeNode("multi", (0.8, 0.08), (0.1, 0.06))

    def freeze(self):
        return self

    def __call__(self, *args, **selector):
        if selector.get("type") == "android.widget.EditText":
            return self.editors
        if selector.get("type") == "android.widget.ImageView":
            return self.images
        if selector.get("text") == "选择多张":
            return self.multi
        return FakeNode("missing", (0, 0), exists=False)


class AutomationRunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.xhs = load_module("xhs_airtest_poco_core_test", "xhs_airtest_poco.py")
        fake_base = types.SimpleNamespace()

        def emit(log, step, **detail):
            log.append({"step": step, **detail})

        def tap_node(node, post_wait=0):
            node.tapped += 1

        fake_base.emit = emit
        fake_base.tap_node = tap_node
        fake_base.handle_common_popups = lambda poco, log: False
        fake_base.list_texts = lambda poco, limit=50: []
        fake_base.CURRENT_ADB_PATH = "adb"
        fake_base.CURRENT_SERIAL = "serial"
        fake_base.screen_size = lambda adb_path, serial: (1000, 2000)
        fake_base.focus = lambda adb_path, serial: []
        fake_base.adb_calls = []

        def run_adb(adb_path, serial, args, timeout=15):
            fake_base.adb_calls.append((adb_path, serial, args, timeout))
            return ""

        fake_base.run_adb = run_adb
        sys.modules["xhs_airtest_poco"] = fake_base
        cls.publish = load_module("xhs_publish_poco_test", "xhs_publish_poco.py")
        cls.lookup = load_module("alipay_name_lookup_test", "alipay_name_lookup.py")
        cls.original_wait_before_phone_input = cls.lookup.Runner.wait_before_phone_input

    def setUp(self):
        self.input_throttle_patcher = mock.patch.object(
            self.lookup.Runner, "wait_before_phone_input", return_value=0,
        )
        self.input_throttle_patcher.start()
        self.addCleanup(self.input_throttle_patcher.stop)

    def test_lookup_waits_random_three_to_ten_seconds_before_phone_input(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "input-throttle"})
        with mock.patch.object(self.lookup.random, "uniform", return_value=7.25) as choose_delay, \
                mock.patch.object(self.lookup.time, "sleep") as sleep:
            delay = type(self).original_wait_before_phone_input(runner, "poco")
        self.assertEqual(delay, 7.25)
        choose_delay.assert_called_once_with(3.0, 10.0)
        sleep.assert_called_once_with(7.25)
        event = runner.log[-1]
        self.assertEqual(event["step"], "query_input_throttle_wait")
        self.assertEqual(event["delayMs"], 7250)
        self.assertEqual(event["driver"], "poco")

    def test_xhs_clone_resolver_recognizes_abbreviated_android_component(self):
        lines = [
            "mCurrentFocus=Window{bfce448 u0 com.android.intentresolver/.ChooserActivityLauncher}",
            "mFocusedApp=ActivityRecord{9a35b49 u0 com.android.intentresolver/.ChooserActivityLauncher t309}",
        ]
        log = []
        with mock.patch.object(self.xhs, "focus", return_value=lines):
            selected = self.xhs.choose_xhs_slot(object(), "adb", "serial", "app2", log)
        self.assertFalse(selected)
        self.assertEqual(
            [item["step"] for item in log],
            ["choose_slot_begin", "choose_slot_focus", "choose_slot_vendor_resolver_defer_to_xml"],
        )

    def test_xhs_clone_resolver_dismisses_exact_oppo_updater_overlay(self):
        before = [
            "mCurrentFocus=Window{bfce448 u0 com.oplus.ota}",
            "mFocusedApp=ActivityRecord{9a35b49 u0 com.android.intentresolver/.ChooserActivityLauncher t309}",
        ]
        after = [
            "mCurrentFocus=Window{abcd123 u0 com.android.intentresolver/com.android.intentresolver.ChooserActivityLauncher}",
            "mFocusedApp=ActivityRecord{ef01234 u0 com.android.intentresolver/.ChooserActivityLauncher t309}",
        ]
        log = []
        with mock.patch.object(self.xhs, "run_adb", return_value="") as run_adb, \
                mock.patch.object(self.xhs, "focus", return_value=after), \
                mock.patch.object(self.xhs.time, "sleep", return_value=None):
            dismissed = self.xhs.dismiss_known_resolver_system_overlay("adb", "serial", log, before)
        self.assertTrue(dismissed)
        run_adb.assert_called_once_with(
            "adb", "serial", ["shell", "input", "keyevent", "4"], timeout=5
        )
        self.assertEqual(log[-1]["overlay"], "oppo_system_update")

    def test_publish_selects_only_bounded_gallery_thumbnail_elements_in_order(self):
        toolbar = FakeNode("com.android.systemui:id/icon", (0.04, 0.04), (0.04, 0.04))
        second = FakeNode("photo-2", (0.45, 0.25))
        first = FakeNode("photo-1", (0.18, 0.25))
        scanner = FakeNode("redscanner-decoration", (0.7, 0.25))
        poco = FakePoco(images=[toolbar, second, scanner, first])
        log = []
        self.publish.base.adb_calls.clear()
        self.assertTrue(self.publish.select_gallery_images(poco, 2, log))
        taps = [call[2] for call in self.publish.base.adb_calls if call[2][:3] == ["shell", "input", "tap"]]
        self.assertEqual(taps, [
            ["shell", "input", "tap", "260", "340"],
            ["shell", "input", "tap", "530", "340"],
        ])
        self.assertEqual(toolbar.tapped, 0)
        self.assertEqual(scanner.tapped, 0)
        selected = [item for item in log if item["step"] == "select_publish_image"]
        self.assertEqual([item["name"] for item in selected], ["photo-1", "photo-2"])

    def test_publish_explicitly_binds_and_validates_the_payload_serial(self):
        source = (SCRIPT_DIR / "xhs_publish_poco.py").read_text(encoding="utf-8")
        self.assertIn("connect_device(", source)
        self.assertIn("Android://127.0.0.1:5037/{serial}", source)
        self.assertIn("if connected_serial != serial:", source)
        self.assertIn("airtest_serial_mismatch:requested=", source)

    def test_publish_reuses_the_xml_clone_picker_then_returns_to_poco(self):
        source = (SCRIPT_DIR / "xhs_publish_poco.py").read_text(encoding="utf-8")
        self.assertIn("slot_selected = base.choose_xhs_slot", source)
        self.assertIn("if not slot_selected:", source)
        self.assertIn("base.click_xhs_slot_xml", source)
        self.assertIn("poco_recreated_after_publish_clone_xml", source)

    def test_publish_trusts_launch_output_and_selects_clone_before_poco(self):
        resolver_output = "Activity: com.android.intentresolver/.DoubleAppResolverActivity"
        self.assertTrue(self.publish.launch_output_reports_clone_resolver(resolver_output))
        self.assertFalse(
            self.publish.launch_output_reports_clone_resolver(
                "Activity: com.xingin.xhs/.index.v2.IndexActivityV2"
            )
        )

        source = (SCRIPT_DIR / "xhs_publish_poco.py").read_text(encoding="utf-8")
        start_index = source.index("start_out = base.start_xhs_activity")
        branch_index = source.index("if resolver_was_active:", start_index)
        xml_index = source.index("base.click_xhs_slot_xml", branch_index)
        poco_index = source.index("base.create_stable_poco", branch_index)
        self.assertLess(branch_index, xml_index)
        self.assertLess(xml_index, poco_index)
        self.assertIn("resolver_from_start = launch_output_reports_clone_resolver(start_out)", source)
        self.assertIn("base.release_poco_for_confirm_xml", source[branch_index:poco_index])

    def test_publish_clone_launch_executes_xml_before_poco_creation(self):
        calls = []
        poco = object()
        resolver_output = "Activity: com.android.intentresolver/.DoubleAppResolverActivity"

        with mock.patch.multiple(
            self.publish.base,
            require_default_internet_route=lambda *args: None,
            wake_and_unlock=lambda *args: None,
            grant_xhs_media_access=lambda *args: None,
            reset_launch_surface=lambda *args: None,
            resolve_activity=lambda *args: "com.xingin.xhs/.index.v2.IndexActivityV2",
            start_xhs_activity=lambda *args: resolver_output,
            focus=lambda *args: ["mFocusedApp=com.netease.open.pocoservice/.TestActivity"],
            package_from_focus=lambda *args: "com.netease.open.pocoservice",
            release_poco_for_confirm_xml=lambda *args: calls.append("release_poco"),
            click_xhs_slot_xml=lambda *args, **kwargs: calls.append("click_xml") or True,
            create_stable_poco=lambda **kwargs: calls.append("create_poco") or poco,
            clear_popups_rounds=lambda *args, **kwargs: calls.append("clear_popups"),
            create=True,
        ), mock.patch.object(
            self.publish,
            "bind_airtest_device",
            side_effect=lambda *args, **kwargs: calls.append("bind_airtest"),
        ):
            observed = self.publish.launch_xhs(
                {
                    "serial": "serial",
                    "taskId": "resolver-race",
                    "xhsAppSlot": "app1",
                },
                [],
            )

        self.assertIs(observed, poco)
        self.assertEqual(
            calls,
            ["release_poco", "click_xml", "bind_airtest", "create_poco", "clear_popups"],
        )

    def test_publish_xml_fallback_selects_only_exact_bottom_entry(self):
        root = ET.fromstring("""
        <hierarchy>
          <node text="发布" content-desc="" clickable="true" enabled="true" bounds="[20,100][200,180]" />
          <node text="" content-desc="发布" clickable="true" enabled="true" bounds="[288,1522][432,1612]" />
        </hierarchy>
        """)
        parent = {child: node for node in root.iter() for child in node}
        with mock.patch.multiple(
            self.publish.base,
            nearest_xml_tappable=lambda node, parents: node,
            xml_bounds_values=lambda bounds: (
                (20, 100, 200, 180)
                if bounds == "[20,100][200,180]"
                else (288, 1522, 432, 1612)
            ),
            create=True,
        ):
            candidate, text, desc = self.publish.bottom_xml_tappable(
                root,
                parent,
                ("发布", "+", "创作"),
                1612,
            )
        self.assertEqual(candidate.get("bounds"), "[288,1522][432,1612]")
        self.assertEqual(text, "")
        self.assertEqual(desc, "发布")

    def test_publish_entry_failure_releases_poco_then_uses_xml_and_rebinds(self):
        source = (SCRIPT_DIR / "xhs_publish_poco.py").read_text(encoding="utf-8")
        start = source.index("if not open_publish_entry(poco, log, timeout=15):")
        end = source.index("if not click_exact(poco, [\"从相册选择\"", start)
        fallback = source[start:end]
        stop_index = fallback.index("base.stop_stable_poco")
        release_index = fallback.index("base.release_poco_for_confirm_xml")
        xml_index = fallback.index("click_publish_entry_xml")
        bind_index = fallback.index("bind_airtest_device")
        create_index = fallback.index("base.create_stable_poco")
        self.assertLess(stop_index, release_index)
        self.assertLess(release_index, xml_index)
        self.assertLess(xml_index, bind_index)
        self.assertLess(bind_index, create_index)

    def test_publish_returns_structured_failures_to_the_agent_for_replay(self):
        source = (SCRIPT_DIR / "xhs_publish_poco.py").read_text(encoding="utf-8")
        main_body = source.split("def main():", 1)[1].split('if __name__ == "__main__":', 1)[0]
        self.assertIn("print(json.dumps(result", main_body)
        self.assertIn("return 0", main_body)
        self.assertNotIn('return 0 if result.get("ok") else 1', main_body)

    def test_publish_dismisses_the_exact_notification_activity_before_creation(self):
        source = (SCRIPT_DIR / "xhs_publish_poco.py").read_text(encoding="utf-8")
        self.assertIn("def open_publish_entry", source)
        self.assertIn("base.dismiss_notification_prompt_safely", source)
        self.assertIn("publish_entry_notification_overlay_dismissed", source)
        self.assertNotIn('["确认"]', source)

    def test_publish_dry_run_hard_stops_before_the_final_click(self):
        source = (SCRIPT_DIR / "xhs_publish_poco.py").read_text(encoding="utf-8")
        dry_run_index = source.index('if payload.get("dryRunBeforeFinalPublish"):')
        final_click_index = source.index('"click_final_publish"')
        self.assertLess(dry_run_index, final_click_index)
        dry_run_block = source[dry_run_index:final_click_index]
        self.assertIn('"clickedFinalPublish": False', dry_run_block)
        self.assertIn('"READY_BEFORE_FINAL_PUBLISH"', dry_run_block)
        self.assertIn("return {", dry_run_block)

    def test_publish_validation_and_final_click_share_the_same_button_labels(self):
        source = (SCRIPT_DIR / "xhs_publish_poco.py").read_text(encoding="utf-8")
        self.assertIn('FINAL_PUBLISH_LABELS = ("发布", "发布笔记", "发笔记")', source)
        self.assertIn("for label in FINAL_PUBLISH_LABELS:", source)
        self.assertIn(
            'click_exact(poco, FINAL_PUBLISH_LABELS, log, "click_final_publish"',
            source,
        )

    def test_publish_preserves_an_interrupted_draft_without_discarding_it(self):
        source = (SCRIPT_DIR / "xhs_publish_poco.py").read_text(encoding="utf-8")
        self.assertIn("def preserve_existing_publish_draft", source)
        self.assertIn('["存草稿"]', source)
        self.assertNotIn("放弃草稿", source)

    def test_publish_fills_the_two_visible_editors(self):
        title = FakeNode("title", (0.5, 0.25), (0.8, 0.08))
        content = FakeNode("content", (0.5, 0.45), (0.8, 0.2))
        poco = FakePoco(editors=[content, title])
        self.assertTrue(self.publish.fill_editor(poco, "测试标题", "测试正文", []))
        self.assertEqual(title.value, "测试标题")
        self.assertEqual(content.value, "测试正文")

    def test_lookup_extracts_only_a_result_with_phone_and_action_evidence(self):
        root = ET.fromstring("""
        <hierarchy><node>
          <node text="测试用户(**测)"/><node text="13800000008"/>
          <node text="转账"/><node text="加好友"/>
        </node></hierarchy>
        """)
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "test"})
        result = runner.parse_result(root, {}, "13800000008")
        self.assertEqual(result["realNameTailCharacter"], "测")
        self.assertEqual(result["alipayDisplayName"], "测试用户(**测)")
        self.assertEqual(result["matchMethod"], "same_accessibility_result_container")
        self.assertIsNone(runner.parse_result(root, {}, "13800000011"))

    def test_lookup_xml_returns_unverified_account_as_terminal_not_found(self):
        phone = "13800000022"
        root = ET.fromstring(f"""
        <hierarchy><node>
          <node text="138******22(未实名)" bounds="[20,100][300,150]"/>
          <node text="{phone}" bounds="[20,160][300,210]"/>
          <node text="转账"/><node text="加好友"/>
        </node></hierarchy>
        """)
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "xml-unverified"})
        result = runner.parse_result(root, {}, phone)
        self.assertTrue(result["notFound"])
        self.assertEqual(result["message"], "account_not_real_named")
        self.assertEqual(result["matchedPhone"], phone)
        self.assertEqual(result["realNameTailCharacter"], "")
        self.assertIsNone(runner.parse_result(root, {}, "13800000021"))

    def test_lookup_poco_fast_path_extracts_only_exact_phone_result(self):
        phone = "13800000008"

        class Node:
            def __init__(inner_self, text, position, node_type="android.widget.TextView"):
                inner_self.text = text
                inner_self.position = position
                inner_self.node_type = node_type

            def attr(inner_self, key):
                return {"text": inner_self.text, "desc": "", "type": inner_self.node_type}.get(key, "")

            def get_position(inner_self):
                return inner_self.position

        class Snapshot:
            def __init__(inner_self, nodes):
                inner_self.nodes = nodes

            def __call__(inner_self, **selector):
                return [
                    node for node in inner_self.nodes
                    if not selector.get("type") or node.node_type == selector["type"]
                ]

        snapshot = Snapshot([
            Node("测试用户(**测)", (0.4, 0.30)),
            Node(phone, (0.4, 0.36)),
            Node("转账", (0.3, 0.44)),
            Node("加好友", (0.7, 0.44)),
        ])
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-result"})
        result = runner.parse_poco_result(snapshot, phone)
        self.assertEqual(result["realNameTailCharacter"], "测")
        self.assertEqual(result["matchMethod"], "poco_geometry_plus_exact_account_actions")
        self.assertIsNone(runner.parse_poco_result(snapshot, "13800000011"))

    def test_lookup_poco_returns_unverified_account_as_terminal_not_found(self):
        phone = "13800000022"

        class Node:
            def __init__(inner_self, text, position, node_type="android.widget.TextView"):
                inner_self.text = text
                inner_self.position = position
                inner_self.node_type = node_type

            def attr(inner_self, key):
                return {"text": inner_self.text, "desc": "", "type": inner_self.node_type}.get(key, "")

            def get_position(inner_self):
                return inner_self.position

        class Snapshot:
            def __init__(inner_self, nodes):
                inner_self.nodes = nodes

            def __call__(inner_self, **selector):
                return [
                    node for node in inner_self.nodes
                    if not selector.get("type") or node.node_type == selector["type"]
                ]

        snapshot = Snapshot([
            Node("138******22(未实名)", (0.4, 0.30)),
            Node(phone, (0.4, 0.36)),
            Node("转账", (0.3, 0.44)),
            Node("加好友", (0.7, 0.44)),
        ])
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-unverified"})
        result = runner.parse_poco_result(snapshot, phone)
        self.assertTrue(result["notFound"])
        self.assertEqual(result["matchMethod"], "poco_geometry_unverified_account")
        runner.emit_query_result(result, driver="poco")
        self.assertEqual(runner.log[-1]["step"], "lookup_no_name_result")
        self.assertNotIn("masked_real_name_tail_extracted", [item["step"] for item in runner.log])

    def test_lookup_poco_query_uses_exact_element_with_bounded_adb_input(self):
        phone = "13800000008"

        class InputNode:
            def __init__(inner_self):
                inner_self.value = "old"
            def attr(inner_self, key):
                return inner_self.value if key == "text" else ""

        input_node = InputNode()
        result = {
            "alipayDisplayName": "测试用户(**测)",
            "realNameTailCharacter": "测",
            "matchedPhone": phone,
            "matchMethod": "poco_geometry_plus_exact_account_actions",
        }

        class Snapshot:
            def __call__(inner_self, **selector):
                return [input_node] if selector.get("name") == self.lookup.SEARCH_INPUT_ID else []

        class Poco:
            def freeze(inner_self):
                return Snapshot()

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-input"})
        runner.poco_search_ready = lambda poco, live=True: input_node
        runner.poco_tap = mock.Mock()
        runner.focused_search_input_length = mock.Mock(side_effect=[3, 0])
        runner.clear_focused_search_input = mock.Mock(
            side_effect=lambda method="": (
                setattr(input_node, "value", ""),
                runner.emit("clear_previous_query", method=method),
            ),
        )
        runner.adb = mock.Mock(
            side_effect=lambda args, **kwargs: (
                setattr(input_node, "value", phone)
                if is_phone_keyevent_command(args, phone) else None
            ) or "",
        )
        runner.poco_snapshot_texts = lambda snapshot, limit=120: []
        runner.parse_poco_result = lambda snapshot, target: result if target == phone else None
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            observed = runner.query_once_poco(Poco(), phone)
        self.assertEqual(observed["realNameTailCharacter"], "测")
        self.assertEqual(runner.poco_tap.call_count, 2)
        input_calls = [
            call.args[0] for call in runner.adb.call_args_list
            if is_phone_keyevent_command(call.args[0], phone)
        ]
        self.assertEqual(len(input_calls), 1)
        self.assertGreaterEqual(int(input_calls[0][4]), 85)
        self.assertLessEqual(int(input_calls[0][4]), 145)
        self.assertEqual(
            [item["step"] for item in runner.log],
            [
                "clear_previous_query", "poco_input_clear_confirmed",
                "input_phone", "masked_real_name_tail_extracted",
            ],
        )

    def test_lookup_poco_slider_resume_never_retypes_phone(self):
        phone = "13800000008"

        class InputNode:
            def __init__(inner_self):
                inner_self.value = ""
                inner_self.values = []

            def set_text(inner_self, value):
                inner_self.value = value
                inner_self.values.append(value)

            def attr(inner_self, key):
                return inner_self.value if key == "text" else ""

            def get_position(inner_self):
                return (0.4, 0.08)

        input_node = InputNode()
        verifying = object()
        resumed = object()
        result = {
            "alipayDisplayName": "测试用户(**测)",
            "realNameTailCharacter": "测",
            "matchedPhone": phone,
            "matchMethod": "poco_geometry_plus_exact_account_actions",
        }

        cleared = object()

        class Poco:
            def __init__(inner_self):
                inner_self.snapshots = iter([cleared, verifying, resumed])

            def freeze(inner_self):
                return next(inner_self.snapshots)

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-slider-resume"})
        runner.poco_search_ready = mock.Mock(return_value=input_node)
        runner.focused_search_input_length = mock.Mock(return_value=0)
        runner.poco_nodes = mock.Mock(
            side_effect=lambda snapshot, **selector: [input_node]
            if selector.get("name") == self.lookup.SEARCH_INPUT_ID else [],
        )
        runner.clear_focused_search_input = mock.Mock(
            side_effect=lambda method="": setattr(input_node, "value", ""),
        )
        runner.adb = mock.Mock(
            side_effect=lambda args, **kwargs: (
                setattr(input_node, "value", phone)
                if is_phone_keyevent_command(args, phone) else None
            ) or "",
        )
        runner.poco_raise_if_account_restricted = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(
            side_effect=lambda snapshot: {"action": "向右滑动验证"} if snapshot is verifying else None,
        )
        runner.poco_solve_human_verification = mock.Mock(return_value=True)
        runner.parse_poco_result = mock.Mock(
            side_effect=lambda snapshot, target: result if snapshot is resumed and target == phone else None,
        )

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            observed = runner.query_once_poco(Poco(), phone)

        self.assertEqual(observed["realNameTailCharacter"], "测")
        self.assertEqual(input_node.values, [])
        steps = [item["step"] for item in runner.log]
        self.assertIn("resume_query_after_human_verification", steps)
        self.assertIn("resume_query_without_reinput", steps)
        self.assertNotIn("replay_query_after_human_verification", steps)
        resume_event = next(
            item for item in runner.log if item["step"] == "resume_query_after_human_verification"
        )
        self.assertFalse(resume_event["resubmitsInput"])

    def test_lookup_poco_bounds_hierarchy_failure_after_input_for_resume(self):
        phone = "13800000008"

        class InputNode:
            def __init__(inner_self):
                inner_self.values = []

            def set_text(inner_self, value):
                inner_self.values.append(value)

            def attr(inner_self, key):
                return "" if key == "text" else ""

            def get_position(inner_self):
                return (0.4, 0.08)

        class Poco:
            def __init__(inner_self):
                inner_self.calls = 0

            def freeze(inner_self):
                inner_self.calls += 1
                if inner_self.calls == 1:
                    return lambda **selector: [input_node]
                raise TimeoutError("bounded Poco HTTP timeout")

        input_node = InputNode()
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-timeout-after-input"})
        runner.poco_search_ready = lambda poco, live=True: input_node
        runner.poco_tap = mock.Mock()
        runner.focused_search_input_length = mock.Mock(return_value=0)
        runner.clear_focused_search_input = mock.Mock()
        runner.adb = mock.Mock(return_value="")
        with self.assertRaisesRegex(RuntimeError, "poco_query_result_channel_timeout_after_input"):
            runner.query_once_poco(Poco(), phone)
        self.assertTrue(any(
            is_phone_keyevent_command(call.args[0], phone)
            for call in runner.adb.call_args_list
        ))

    def test_lookup_poco_bounded_adb_input_timeout_routes_to_state_resume(self):
        phone = "13800000008"

        class InputNode:
            def __init__(inner_self):
                inner_self.value = ""

            def attr(inner_self, key):
                return inner_self.value if key == "text" else ""

            def get_position(inner_self):
                return (0.4, 0.08)

        class Snapshot:
            def __call__(inner_self, **selector):
                return [input_node] if selector.get("name") == self.lookup.SEARCH_INPUT_ID else []

        class Poco:
            def freeze(inner_self):
                return Snapshot()

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-input-timeout"})
        input_node = InputNode()
        runner.poco_search_ready = mock.Mock(return_value=input_node)
        runner.poco_tap = mock.Mock()
        runner.focused_search_input_length = mock.Mock(return_value=0)
        runner.clear_focused_search_input = mock.Mock()
        runner.adb = mock.Mock(
            side_effect=lambda args, **kwargs: (_ for _ in ()).throw(
                TimeoutError("bounded ADB input timeout")
            ) if is_phone_keyevent_command(args, phone) else "",
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "poco_query_result_channel_timeout_after_input:poco_bounded_input_failed:TimeoutError",
        ):
            runner.query_once_poco(Poco(), phone)

        self.assertEqual(
            [item["step"] for item in runner.log],
            ["poco_input_clear_confirmed"],
        )

    def test_lookup_poco_resume_inspects_result_without_retyping_phone(self):
        phone = "13800000008"

        class InputNode:
            def __init__(inner_self):
                inner_self.values = []

            def set_text(inner_self, value):
                inner_self.values.append(value)

            def attr(inner_self, key):
                return phone if key == "text" else ""

        input_node = InputNode()
        result = {
            "alipayDisplayName": "测试用户(**测)",
            "realNameTailCharacter": "测",
            "matchedPhone": phone,
            "matchMethod": "poco_geometry_plus_exact_account_actions",
        }

        class Snapshot:
            def __call__(inner_self, **selector):
                if selector.get("name") == self.lookup.SEARCH_INPUT_ID:
                    return [input_node]
                return []

        class Poco:
            def freeze(inner_self):
                return Snapshot()

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-query-resume"})
        runner.poco_raise_if_account_restricted = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        runner.parse_poco_result = mock.Mock(return_value=result)
        observed = runner.query_once_poco(Poco(), phone, resume_after_input=True)
        self.assertEqual(observed["realNameTailCharacter"], "测")
        self.assertEqual(input_node.values, [])
        self.assertEqual(runner.log[0]["step"], "resume_query_without_reinput")
        self.assertFalse(runner.log[0]["resubmitsInput"])

    def test_lookup_poco_resume_retypes_once_only_after_rebuilt_poco_confirms_empty(self):
        phone = "13800000008"

        class InputNode:
            def __init__(inner_self):
                inner_self.value = ""

            def attr(inner_self, key):
                return inner_self.value if key == "text" else ""

            def get_position(inner_self):
                return (0.4, 0.08)

        input_node = InputNode()

        class Snapshot:
            def __call__(inner_self, **selector):
                if selector.get("name") == self.lookup.SEARCH_INPUT_ID:
                    return [input_node]
                return []

        class Poco:
            def freeze(inner_self):
                return Snapshot()

        result = {
            "alipayDisplayName": "测试用户(**测)",
            "realNameTailCharacter": "测",
            "matchedPhone": phone,
            "matchMethod": "poco_geometry_plus_exact_account_actions",
        }
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-empty-resume"})
        runner.poco_raise_if_account_restricted = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        runner.poco_search_ready = mock.Mock(return_value=input_node)
        runner.poco_tap = mock.Mock()
        runner.adb = mock.Mock(side_effect=lambda *args, **kwargs: setattr(input_node, "value", phone) or "")
        runner.parse_poco_result = mock.Mock(side_effect=[None, None, result])

        observed = runner.query_once_poco(Poco(), phone, resume_after_input=True)

        self.assertEqual(observed["realNameTailCharacter"], "测")
        runner.wait_before_phone_input.assert_called_once_with("poco_resume_empty_adb")
        runner.poco_tap.assert_called_once_with(input_node)
        input_command = runner.adb.call_args.args[0]
        self.assertTrue(is_phone_keyevent_command(input_command, phone))
        self.assertEqual(runner.adb.call_args.kwargs, {"timeout": 5})
        runner.poco_search_ready.assert_not_called()
        steps = [item["step"] for item in runner.log]
        self.assertIn("resume_empty_input_confirmed", steps)
        input_event = next(item for item in runner.log if item["step"] == "input_phone")
        self.assertEqual(input_event["method"], "adb_keyevents_after_poco_confirmed_empty")

    def test_lookup_poco_resume_focuses_matching_input_to_reveal_submit(self):
        phone = "13800000008"
        state = {"focused": False, "submitted": False}

        class InputNode:
            def attr(inner_self, key):
                return phone if key == "text" else ""

        class ConfirmNode:
            pass

        input_node = InputNode()
        confirm_node = ConfirmNode()

        class Snapshot:
            def __call__(inner_self, **selector):
                if selector.get("name") == self.lookup.SEARCH_INPUT_ID:
                    return [input_node]
                if selector.get("name") == "com.alipay.mobile.antui:id/search_confirm":
                    return [confirm_node] if state["focused"] else []
                return []

        class Poco:
            def freeze(inner_self):
                return Snapshot()

        result = {
            "alipayDisplayName": "测试用户(**测)",
            "realNameTailCharacter": "测",
            "matchedPhone": phone,
            "matchMethod": "poco_geometry_plus_exact_account_actions",
        }
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "focused-resume"})
        runner.poco_raise_if_account_restricted = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        runner.poco_search_ready = mock.Mock(return_value=input_node)
        runner.poco_tap = mock.Mock(
            side_effect=lambda node: state.__setitem__(
                "focused" if node is input_node else "submitted", True
            )
        )
        runner.parse_poco_result = mock.Mock(
            side_effect=lambda snapshot, requested_phone: result if state["submitted"] else None
        )

        with mock.patch.object(self.lookup, "POCO_SEARCH_SUBMIT_DELAY_SECONDS", 0):
            observed = runner.query_once_poco(Poco(), phone, resume_after_input=True)

        self.assertEqual(observed["realNameTailCharacter"], "测")
        self.assertEqual(runner.poco_tap.call_args_list[:2], [mock.call(input_node), mock.call(confirm_node)])
        self.assertIn("resume_existing_input_focused", [item["step"] for item in runner.log])
        focus_event = next(item for item in runner.log if item["step"] == "resume_existing_input_focused")
        self.assertFalse(focus_event["resubmitsInput"])

    def test_lookup_poco_resume_keeps_nonempty_mismatch_fail_closed(self):
        phone = "13800000008"

        class InputNode:
            def attr(inner_self, key):
                return "13800000011" if key == "text" else ""

        class Snapshot:
            def __call__(inner_self, **selector):
                return [InputNode()] if selector.get("name") == self.lookup.SEARCH_INPUT_ID else []

        class Poco:
            def freeze(inner_self):
                return Snapshot()

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-mismatch-resume"})
        runner.poco_raise_if_account_restricted = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        runner.parse_poco_result = mock.Mock(return_value=None)
        runner.adb = mock.Mock()

        with self.assertRaisesRegex(RuntimeError, "poco_query_resume_state_mismatch:length=11"):
            runner.query_once_poco(Poco(), phone, resume_after_input=True)

        runner.wait_before_phone_input.assert_not_called()
        runner.adb.assert_not_called()

    def test_lookup_poco_observation_only_resume_never_retypes_empty_input(self):
        class InputNode:
            def attr(inner_self, key):
                return "" if key == "text" else ""

        class Snapshot:
            def __call__(inner_self, **selector):
                return [InputNode()] if selector.get("name") == self.lookup.SEARCH_INPUT_ID else []

        class Poco:
            def freeze(inner_self):
                return Snapshot()

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "observe-only-resume"})
        runner.poco_raise_if_account_restricted = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        runner.parse_poco_result = mock.Mock(return_value=None)
        runner.adb = mock.Mock()

        with self.assertRaisesRegex(
            RuntimeError,
            "poco_query_resume_state_mismatch:length=0;emptyReinputAllowed=false",
        ):
            runner.query_once_poco(
                Poco(), "13800000008", resume_after_input=True,
                allow_empty_reinput=False,
            )

        runner.wait_before_phone_input.assert_not_called()
        runner.adb.assert_not_called()

    def test_lookup_poco_result_recovery_observes_without_input_or_submit(self):
        phone = "13800000008"

        class Snapshot:
            def __call__(inner_self, **selector):
                return []

        class Poco:
            def freeze(inner_self):
                return Snapshot()

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "observe-result-only"})
        runner.poco_raise_if_account_restricted = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        runner.parse_poco_result = mock.Mock(return_value=None)
        runner.poco_tap = mock.Mock()
        runner.adb = mock.Mock()

        with self.assertRaisesRegex(RuntimeError, "poco_query_resume_observation_no_result"):
            runner.query_once_poco(
                Poco(), phone,
                query_deadline=self.lookup.time.perf_counter(),
                resume_after_input=True,
                allow_empty_reinput=False,
                observation_only_resume=True,
            )

        runner.poco_tap.assert_not_called()
        runner.wait_before_phone_input.assert_not_called()
        runner.adb.assert_not_called()
        event = next(
            item for item in runner.log
            if item["step"] == "resume_result_observation_only"
        )
        self.assertFalse(event["resubmitsInput"])
        self.assertFalse(event["resubmitsSearch"])

    def test_lookup_poco_result_recovery_reads_late_visible_name_without_submit(self):
        phone = "13800000008"
        result = {
            "alipayDisplayName": "测试用户(**测)",
            "realNameTailCharacter": "测",
            "matchedPhone": phone,
            "matchMethod": "poco_geometry_plus_exact_account_actions",
        }

        class Snapshot:
            def __call__(inner_self, **selector):
                return []

        class Poco:
            def freeze(inner_self):
                return Snapshot()

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "observe-late-result"})
        runner.poco_raise_if_account_restricted = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        runner.parse_poco_result = mock.Mock(side_effect=[None, result])
        runner.poco_tap = mock.Mock()
        runner.adb = mock.Mock()

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            observed = runner.query_once_poco(
                Poco(), phone,
                resume_after_input=True,
                allow_empty_reinput=False,
                observation_only_resume=True,
            )

        self.assertEqual(observed["realNameTailCharacter"], "测")
        runner.poco_tap.assert_not_called()
        runner.wait_before_phone_input.assert_not_called()
        runner.adb.assert_not_called()

    def test_poco_http_transport_substitutes_a_bound_for_synchronous_rpc(self):
        source = (SCRIPT_DIR / "xhs_airtest_poco.py").read_text(encoding="utf-8")
        self.assertIn("def bounded_transport_send(request, timeout=None)", source)
        self.assertIn("timeout_seconds if timeout is None else timeout", source)
        self.assertIn("transport.send = bounded_transport_send", source)

    def test_lookup_poco_stable_no_name_result_returns_within_five_seconds_without_xml(self):
        phone = "13800000014"

        class Node:
            def __init__(inner_self, value=""):
                inner_self.value = value

            def set_text(inner_self, value):
                inner_self.value = value

            def attr(inner_self, key):
                return inner_self.value if key == "text" else ""

            def get_position(inner_self):
                return (0.9, 0.08)

        input_node = Node()
        confirm_node = Node("搜索")

        class Snapshot:
            def __call__(inner_self, **selector):
                if selector.get("name") == self.lookup.SEARCH_INPUT_ID:
                    return [input_node]
                if selector.get("name") == "com.alipay.mobile.antui:id/search_confirm":
                    return [confirm_node]
                return []

        class Poco:
            def freeze(inner_self):
                return Snapshot()

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-no-name"})
        runner.poco_search_ready = lambda poco, live=True: input_node
        runner.focused_search_input_length = mock.Mock(return_value=0)
        runner.parse_poco_result = lambda snapshot, target: None
        runner.poco_verification_evidence = lambda snapshot: None
        runner.poco_tap = mock.Mock()
        runner.clear_focused_search_input = mock.Mock(
            side_effect=lambda method="": setattr(input_node, "value", ""),
        )
        runner.adb = mock.Mock(
            side_effect=lambda args, **kwargs: (
                setattr(input_node, "value", phone)
                if is_phone_keyevent_command(args, phone) else None
            ) or "",
        )
        clock = [100.0]

        def advance(seconds):
            clock[0] += seconds

        with mock.patch.object(self.lookup.time, "time", side_effect=lambda: clock[0]), \
                mock.patch.object(self.lookup.time, "sleep", side_effect=advance):
            result = runner.query_once_poco(
                Poco(), phone, query_deadline=self.lookup.time.perf_counter() + 30,
            )
        self.assertTrue(result["notFound"])
        self.assertEqual(result["matchMethod"], "poco_stable_no_name_result")
        self.assertEqual(runner.poco_tap.call_count, 3)
        self.assertLessEqual(clock[0] - 100.0, 5.2)
        self.assertNotIn("retry_search_result", [item["step"] for item in runner.log])
        self.assertEqual(runner.log[-1]["step"], "lookup_no_name_result")

    def test_lookup_poco_missing_optional_overlay_is_not_an_rpc_failure(self):
        class MissingProxy:
            def exists(inner_self):
                return False

            def __iter__(inner_self):
                raise AssertionError("an empty Poco proxy must not be iterated")

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-empty"})
        self.assertEqual(runner.poco_nodes(lambda **selector: MissingProxy(), desc="全屏广告"), [])

    @staticmethod
    def coloros_securepay_usb_root(package="com.coloros.securepay", include_ignore=True):
        ignore = (
            f'<node text="忽略" resource-id="android:id/button2" package="{package}" '
            'clickable="true" enabled="true" bounds="[32,851][359,971]"/>'
            if include_ignore else ""
        )
        return ET.fromstring(f"""
        <hierarchy><node package="{package}">
          <node text="已允许 USB 传输数据，请切换为“仅充电”后再使用支付应用。"
                resource-id="com.coloros.securepay:id/alertTitle" package="{package}"/>
          <node text="存在被远程控制、泄露隐私的风险。"
                resource-id="com.coloros.securepay:id/tv_message" package="{package}"/>
          {ignore}
          <node text="仅充电" resource-id="android:id/button1" package="{package}"
                clickable="true" enabled="true" bounds="[361,851][688,971]"/>
        </node></hierarchy>
        """)

    def test_lookup_dismisses_exact_coloros_securepay_warning_via_ignore_element(self):
        root = self.coloros_securepay_usb_root()
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "securepay-exact"})
        runner.adb = mock.Mock(return_value="")
        runner.focus = mock.Mock(return_value=["mCurrentFocus=com.eg.android.AlipayGphone/.AlipayLogin"])
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            dismissed = runner.dismiss_coloros_securepay_usb_dialog(root, driver="unit_xml")
        self.assertTrue(dismissed)
        runner.adb.assert_called_once_with(
            ["shell", "input", "tap", "195", "911"], timeout=8,
        )
        self.assertEqual(runner.log[-1]["step"], "dismiss_coloros_securepay_usb_warning")
        self.assertEqual(runner.log[-1]["selector"]["resourceId"], "android:id/button2")
        self.assertFalse(runner.log[-1]["usbModeChanged"])

    def test_lookup_securepay_recovery_fails_closed_for_wrong_package_or_missing_ignore(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "securepay-negative"})
        runner.adb = mock.Mock(return_value="")
        wrong_package = self.coloros_securepay_usb_root(package="com.example.fake")
        missing_ignore = self.coloros_securepay_usb_root(include_ignore=False)
        self.assertFalse(runner.dismiss_coloros_securepay_usb_dialog(wrong_package))
        self.assertFalse(runner.dismiss_coloros_securepay_usb_dialog(missing_ignore))
        runner.adb.assert_not_called()

    def test_lookup_dismisses_canvas_unverified_account_modal_by_detected_close_ring(self):
        import cv2
        import numpy as np

        image = np.full((1600, 720, 3), 78, dtype=np.uint8)
        cv2.rectangle(image, (100, 470), (620, 1110), (244, 244, 244), thickness=-1)
        cv2.rectangle(image, (175, 960), (545, 1085), (245, 145, 25), thickness=-1)
        cv2.circle(image, (360, 1245), 32, (245, 245, 245), thickness=5)
        cv2.line(image, (346, 1231), (374, 1259), (245, 245, 245), thickness=5)
        cv2.line(image, (374, 1231), (346, 1259), (245, 245, 245), thickness=5)
        encoded_ok, encoded = cv2.imencode(".png", image)
        self.assertTrue(encoded_ok)

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "unverified-modal"})

        def adb(args, **kwargs):
            if args == ["exec-out", "screencap", "-p"]:
                return encoded.tobytes()
            return ""

        runner.adb = mock.Mock(side_effect=adb)
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            self.assertTrue(runner.dismiss_unverified_account_modal_visual())
        self.assertIn(
            mock.call(["shell", "input", "tap", "360", "1245"], timeout=8),
            runner.adb.mock_calls,
        )
        self.assertEqual(runner.log[-1]["step"], "dismiss_alipay_unverified_account_modal")

    def test_lookup_unverified_account_visual_probe_fails_closed_on_normal_home(self):
        import cv2
        import numpy as np

        image = np.full((1600, 720, 3), (160, 90, 30), dtype=np.uint8)
        cv2.rectangle(image, (20, 320), (700, 780), (245, 245, 245), thickness=-1)
        encoded_ok, encoded = cv2.imencode(".png", image)
        self.assertTrue(encoded_ok)

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "normal-home"})

        def adb(args, **kwargs):
            if args == ["exec-out", "screencap", "-p"]:
                return encoded.tobytes()
            raise AssertionError("normal home must not be tapped")

        runner.adb = mock.Mock(side_effect=adb)
        self.assertFalse(runner.dismiss_unverified_account_modal_visual())
        self.assertEqual(runner.adb.call_count, 1)

    def test_lookup_securepay_poco_probe_defers_quickly_when_uiautomator_conflicts(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "securepay-poco-conflict"})
        runner.focus = mock.Mock(return_value=["mCurrentFocus=com.coloros.securepay"])
        runner.dump = mock.Mock(side_effect=TimeoutError("second UiAutomation client unavailable"))
        with self.assertRaisesRegex(RuntimeError, "coloros_securepay_requires_clean_xml_fallback"):
            runner.dismiss_coloros_securepay_usb_dialog(driver="poco_target_missing_xml_probe")
        runner.dump.assert_called_once_with(
            "coloros-securepay-usb-warning",
            command_timeout=4,
            read_timeout=4,
            allow_tty_fallback=False,
        )
        self.assertEqual(runner.log[-1]["step"], "coloros_securepay_probe_deferred_to_clean_xml")
        self.assertEqual(runner.log[-1]["errorType"], "TimeoutError")

    def test_lookup_poco_checks_securepay_only_after_search_target_is_missing(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "securepay-poco-retry"})
        search = FakeNode("search", (0.5, 0.2))
        input_node = FakeNode("input", (0.5, 0.1))
        runner.poco_dismiss_known_overlay = mock.Mock(return_value=False)
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=True)
        runner.dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.poco_unique = mock.Mock(side_effect=[
            RuntimeError("poco_selector_missing:{'desc': '搜索框'}; count=0"),
            search,
            input_node,
        ])
        runner.poco_tap = mock.Mock()
        poco = object()
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_open_search(poco, "unit")
        runner.poco_dismiss_coloros_securepay_usb_dialog.assert_called_once_with(poco)
        runner.dismiss_coloros_securepay_usb_dialog.assert_not_called()
        self.assertEqual(runner.poco_unique.call_args_list[0].kwargs["timeout"], 3.0)
        self.assertEqual(runner.poco_unique.call_args_list[1].kwargs["timeout"], 5.0)
        runner.poco_tap.assert_called_once_with(search)

    def test_lookup_poco_normal_search_path_does_not_probe_securepay_xml(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "securepay-poco-normal"})
        search = FakeNode("search", (0.5, 0.2))
        input_node = FakeNode("input", (0.5, 0.1))
        runner.poco_dismiss_known_overlay = mock.Mock(return_value=False)
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.poco_unique = mock.Mock(side_effect=[search, input_node])
        runner.poco_tap = mock.Mock()
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_open_search(object(), "unit")
        runner.poco_dismiss_known_overlay.assert_not_called()
        runner.dismiss_coloros_securepay_usb_dialog.assert_not_called()
        runner.poco_dismiss_coloros_securepay_usb_dialog.assert_not_called()
        runner.poco_tap.assert_called_once_with(search)

    def test_lookup_poco_reuses_visual_unverified_modal_compatibility(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-unverified-modal"})
        search = FakeNode("search", (0.5, 0.2))
        input_node = FakeNode("input", (0.5, 0.1))
        runner.poco_unique = mock.Mock(side_effect=[
            RuntimeError("poco_selector_missing:{'desc': '搜索框'}; count=0"),
            search,
            input_node,
        ])
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.poco_dismiss_known_overlay = mock.Mock(return_value=False)
        runner.dismiss_unverified_account_modal_visual = mock.Mock(return_value=True)
        runner.dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.poco_tap = mock.Mock()

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_open_search(object(), "unit")

        runner.dismiss_unverified_account_modal_visual.assert_called_once_with()
        runner.dismiss_coloros_securepay_usb_dialog.assert_not_called()
        runner.poco_tap.assert_called_once_with(search)
        self.assertIn("retry_target_after_known_overlay", [item["step"] for item in runner.log])

    def test_lookup_poco_open_search_rechecks_a_late_restriction_after_full_target_budget(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "late-restriction"})
        missing = RuntimeError("poco_selector_missing:{'desc': '搜索框'}; count=0")
        runner.poco_unique = mock.Mock(side_effect=[missing, missing])
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.poco_dismiss_known_overlay = mock.Mock(return_value=False)
        runner.dismiss_unverified_account_modal_visual = mock.Mock(return_value=False)
        runner.dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.poco_raise_if_login_required = mock.Mock(return_value=None)
        runner.poco_raise_if_account_restricted = mock.Mock(side_effect=[
            None,
            RuntimeError("alipay_account_restriction_before_search:jigsaw_verification"),
        ])
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        first_snapshot = object()
        final_snapshot = object()
        poco = mock.Mock()
        poco.freeze.side_effect = [first_snapshot, final_snapshot]

        with self.assertRaisesRegex(
            RuntimeError, "alipay_account_restriction_before_search:jigsaw_verification",
        ):
            runner.poco_open_search(poco, "session-start")

        self.assertEqual(runner.poco_unique.call_count, 2)
        runner.poco_raise_if_account_restricted.assert_has_calls([
            mock.call(first_snapshot, "open-search-session-start"),
            mock.call(final_snapshot, "open-search-session-start"),
        ])
        self.assertEqual(
            [event["step"] for event in runner.log[-2:]],
            [
                "poco_open_search_final_restriction_probe_begin",
                "poco_open_search_final_restriction_probe_done",
            ],
        )

    def test_lookup_poco_dismisses_exact_coloros_securepay_elements_without_xml(self):
        title = FakeNode("com.coloros.securepay:id/alertTitle", (0.5, 0.45))
        title.value = self.lookup.COLOROS_USB_TRANSFER_TITLE
        message = FakeNode("com.coloros.securepay:id/tv_message", (0.5, 0.52))
        message.value = self.lookup.COLOROS_REMOTE_CONTROL_RISK
        ignore = FakeNode("android:id/button2", (0.25, 0.60))
        ignore.value = "忽略"

        class Snapshot:
            def __call__(inner_self, **selector):
                return [
                    node for node in (title, message, ignore)
                    if (not selector.get("name") or node.name == selector["name"])
                    and (not selector.get("text") or node.value == selector["text"])
                ]

        poco = types.SimpleNamespace(freeze=lambda: Snapshot())
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "securepay-poco-exact"})
        runner.focus = mock.Mock(side_effect=[
            ["mCurrentFocus=com.coloros.securepay"],
            ["mCurrentFocus=com.eg.android.AlipayGphone/.AlipayLogin"],
        ])
        runner.poco_tap = mock.Mock()
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            self.assertTrue(runner.poco_dismiss_coloros_securepay_usb_dialog(poco))
        runner.poco_tap.assert_called_once_with(ignore)
        self.assertEqual(runner.log[-1]["driver"], "poco")
        self.assertFalse(runner.log[-1]["usbModeChanged"])

    def test_lookup_poco_dismisses_coloros_ignore_with_vendor_button_id(self):
        title = FakeNode("com.coloros.securepay:id/alertTitle", (0.5, 0.45))
        title.value = self.lookup.COLOROS_USB_TRANSFER_TITLE
        message = FakeNode("com.coloros.securepay:id/tv_message", (0.5, 0.52))
        message.value = self.lookup.COLOROS_REMOTE_CONTROL_RISK
        ignore = FakeNode("com.coloros.securepay:id/vendor_negative", (0.25, 0.60))
        ignore.value = "忽略"

        class Snapshot:
            def __call__(inner_self, **selector):
                return [
                    node for node in (title, message, ignore)
                    if (not selector.get("name") or node.name == selector["name"])
                    and (not selector.get("text") or node.value == selector["text"])
                ]

        poco = types.SimpleNamespace(freeze=lambda: Snapshot())
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "securepay-vendor-button"})
        runner.focus = mock.Mock(side_effect=[
            ["mCurrentFocus=com.coloros.securepay"],
            ["mCurrentFocus=com.eg.android.AlipayGphone/.AlipayLogin"],
        ])
        runner.poco_tap = mock.Mock()

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            self.assertTrue(runner.poco_dismiss_coloros_securepay_usb_dialog(poco))

        runner.poco_tap.assert_called_once_with(ignore)
        self.assertEqual(runner.log[-1]["selector"]["text"], "忽略")
        self.assertEqual(
            runner.log[-1]["selector"]["evidence"],
            "exact_title_and_risk_message",
        )

    def test_lookup_poco_cancels_exact_securepay_focus_when_hierarchy_is_blocked(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "securepay-blocked-poco"})
        runner.focus = mock.Mock(side_effect=[
            ["mCurrentFocus=Window{abc u0 com.coloros.securepay}"],
            ["mCurrentFocus=Window{def u0 com.eg.android.AlipayGphone/.AlipayLogin}"],
        ])
        runner.adb = mock.Mock(return_value="")
        poco = mock.Mock()
        poco.freeze.side_effect = TimeoutError("Poco hierarchy blocked by system dialog")

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            dismissed = runner.poco_dismiss_coloros_securepay_usb_dialog(poco)

        self.assertTrue(dismissed)
        runner.adb.assert_called_once_with(
            ["shell", "input", "keyevent", "4"], timeout=5, check=False,
        )
        self.assertEqual(runner.log[-1]["step"], "dismiss_coloros_securepay_usb_warning")
        self.assertEqual(runner.log[-1]["driver"], "poco_focus_adb_back")
        self.assertEqual(runner.log[-1]["method"], "back")
        self.assertFalse(runner.log[-1]["usbModeChanged"])

    def test_lookup_noncritical_keep_awake_timeout_is_logged_and_does_not_fail_start(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "keep-awake-timeout"})
        runner.adb = mock.Mock(side_effect=TimeoutError("one transient OEM shell timeout"))
        self.assertFalse(runner.keep_awake_usb_best_effort())
        self.assertEqual(runner.log[-1]["step"], "keep_awake_usb_skipped")
        self.assertEqual(runner.log[-1]["reason"], "noncritical_adb_shell_unavailable")
        self.assertEqual(runner.log[-1]["errorType"], "TimeoutError")
        runner.adb.assert_called_once_with(
            ["shell", "svc", "power", "stayon", "usb"], timeout=2, check=False,
        )

    def test_lookup_start_wake_uses_power_key_only_when_wakeup_left_device_asleep(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "wake-vivo"})
        runner.adb = mock.Mock(side_effect=[
            "", "", "mWakefulness=Asleep\n", "", "",
        ])

        runner.wake_and_unlock_for_lookup_start()

        self.assertEqual(runner.adb.call_args_list, [
            mock.call(["shell", "input", "keyevent", "224"], timeout=5, check=False),
            mock.call(["shell", "wm", "dismiss-keyguard"], timeout=5, check=False),
            mock.call(["shell", "dumpsys", "power"], timeout=5, check=False),
            mock.call(["shell", "input", "keyevent", "26"], timeout=5, check=False),
            mock.call(["shell", "wm", "dismiss-keyguard"], timeout=5, check=False),
        ])
        self.assertEqual(runner.log[-1]["step"], "wake_display_power_fallback")
        self.assertEqual(runner.log[-1]["driver"], "adb_power_state_guard")

    def test_lookup_start_wake_never_toggles_an_already_awake_display(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "wake-awake"})
        runner.adb = mock.Mock(side_effect=[
            "", "", "mWakefulness=Awake\n",
        ])

        runner.wake_and_unlock_for_lookup_start()

        self.assertEqual(runner.adb.call_count, 3)
        self.assertNotIn(
            mock.call(["shell", "input", "keyevent", "26"], timeout=5, check=False),
            runner.adb.call_args_list,
        )
        self.assertEqual(runner.log[-1]["step"], "wake_display_ready")

    def test_lookup_poco_full_path_never_calls_xml_dump(self):
        class PocoRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({"serial": "LOCAL", "taskId": "poco-launch"})
                inner_self.commands = []

            def adb(inner_self, args, **kwargs):
                inner_self.commands.append(args)
                return "Status: ok"

        runner = PocoRunner()
        runner.launch = lambda reason: self.fail("Poco path must not enter XML launch/dump helpers")
        runner.poco_dismiss_known_overlay = mock.Mock(return_value=False)
        runner.poco_raise_if_account_restricted = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        runner.poco_open_search = mock.Mock()
        poco = types.SimpleNamespace(freeze=lambda: object())
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_prepare_full_path(poco, "test")
        runner.poco_dismiss_known_overlay.assert_not_called()
        runner.poco_raise_if_account_restricted.assert_not_called()
        runner.poco_open_search.assert_called_once_with(poco, "test", 0)
        self.assertTrue(any(command[:3] == ["shell", "am", "force-stop"] for command in runner.commands))

    def test_lookup_poco_solves_exact_slider_with_bounded_adb_swipe(self):
        class Node:
            def __init__(inner_self, text, position, size, node_type):
                inner_self.text = text
                inner_self.position = position
                inner_self.size = size
                inner_self.node_type = node_type

            def attr(inner_self, key):
                return {"text": inner_self.text, "desc": "", "type": inner_self.node_type}.get(key, "")

            def get_position(inner_self):
                return inner_self.position

            def get_size(inner_self):
                return inner_self.size

        class Snapshot:
            def __init__(inner_self, nodes):
                inner_self.nodes = nodes

            def __call__(inner_self, **selector):
                return [
                    node for node in inner_self.nodes
                    if not selector.get("type") or node.node_type == selector["type"]
                ]

        verifying = Snapshot([
            Node(self.lookup.VERIFICATION_TITLE, (0.5, 0.49), (0.75, 0.04), "android.widget.TextView"),
            Node(self.lookup.VERIFICATION_ACTION, (0.5, 0.568), (0.30, 0.03), "android.widget.TextView"),
            Node("", (0.5, 0.568), (0.778, 0.0625), "android.widget.FrameLayout"),
        ])
        cleared = Snapshot([])

        class Poco:
            def __init__(inner_self):
                inner_self.snapshots = [verifying, cleared]

            def freeze(inner_self):
                return inner_self.snapshots.pop(0)

        class SliderRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({"serial": "LOCAL", "taskId": "poco-slider"})
                inner_self.commands = []

            def adb(inner_self, args, **kwargs):
                inner_self.commands.append(args)
                return ""

            def display_size(inner_self):
                return (720, 1600)

        runner = SliderRunner()
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            self.assertTrue(runner.poco_solve_human_verification(Poco(), "test"))
        swipe = next(command for command in runner.commands if command[:3] == ["shell", "input", "swipe"])
        self.assertEqual(swipe[3:], ["130", "909", "710", "909", "2200"])
        self.assertIn("human_verification_passed", [item["step"] for item in runner.log])

    def test_lookup_recognizes_human_verification(self):
        root = ET.fromstring("""
        <hierarchy><node text="为保障您的正常访问请进行验证"/>
          <node text="向右滑动验证"/>
        </hierarchy>
        """)
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "test"})
        evidence = runner.verification_evidence(root)
        self.assertEqual(evidence["action"], "向右滑动验证")

    def test_lookup_slider_uses_element_track_and_verifies_success(self):
        verification = ET.fromstring('''
        <hierarchy bounds="[0,0][720,1600]"><node text="为保障您的正常访问请进行验证">
          <node bounds="[80,700][640,780]">
            <node text="向右滑动验证" bounds="[80,700][300,780]"/>
          </node>
        </node></hierarchy>
        ''')
        passed = ET.fromstring(f'<hierarchy><node resource-id="{self.lookup.SEARCH_INPUT_ID}"/></hierarchy>')

        class SliderRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({"serial": "LOCAL", "taskId": "slider"})
                inner_self.commands = []

            def adb(inner_self, args, **kwargs):
                inner_self.commands.append(args)
                return ""

            def dump(inner_self, token):
                return passed, {}

        runner = SliderRunner()
        root, _ = runner.solve_human_verification(verification, {}, "test")
        self.assertIs(root, passed)
        self.assertIn(
            ["shell", "input", "swipe", "120", "740", "710", "740", "2200"],
            runner.commands,
        )
        self.assertTrue(any(item["step"] == "human_verification_passed" for item in runner.log))

    def test_lookup_poco_search_ready_recovers_poco_blind_basic_slider_via_xml(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-blind-slider"})
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=Window{1 u0 com.eg.android.AlipayGphone/"
            "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}"
        ])
        input_node = object()
        runner.poco_unique = mock.Mock(side_effect=[
            RuntimeError("poco_selector_missing:{'name': 'search_input'}; count=0"),
            input_node,
        ])
        runner.solve_verification_from_xml_if_present = mock.Mock(return_value=True)

        actual = runner.poco_search_ready(object())

        self.assertIs(actual, input_node)
        runner.solve_verification_from_xml_if_present.assert_called_once_with(
            "poco-search-ready"
        )
        self.assertEqual(runner.poco_unique.call_count, 2)

    def test_lookup_poco_xml_handoff_solves_basic_slider_then_requires_reattach(self):
        verification = ET.fromstring('''
        <hierarchy bounds="[0,0][720,1600]"><node text="为保障您的正常访问请进行验证">
          <node bounds="[80,860][640,960]">
            <node text="向右滑动验证" bounds="[252,885][468,934]"/>
          </node>
        </node></hierarchy>
        ''')
        passed = ET.fromstring(f'''
        <hierarchy bounds="[0,0][720,1600]">
          <node resource-id="{self.lookup.SEARCH_INPUT_ID}"/>
        </hierarchy>
        ''')
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "xml-handoff"})
        runner.adb = mock.Mock(return_value="")
        runner.dump = mock.Mock(side_effect=[
            RuntimeError("uiautomator_hierarchy_missing"),
            (verification, {}),
            (passed, {}),
        ])
        release = mock.Mock()
        base = sys.modules["xhs_airtest_poco"]
        with mock.patch.object(base, "release_poco_for_confirm_xml", release, create=True), \
                mock.patch.object(self.lookup.time, "sleep", return_value=None):
            with self.assertRaisesRegex(
                RuntimeError,
                "poco_rpc_failed:basic_slider_solved_worker_reattach_required",
            ):
                runner.solve_verification_from_xml_if_present("poco-search-ready")

        release.assert_called_once_with("adb", "LOCAL", runner.log)
        runner.adb.assert_any_call([
            "shell", "input", "swipe", "130", "910", "710", "910", "2200",
        ], timeout=15)

    def test_lookup_basic_slider_exhaustion_is_not_classified_as_human(self):
        verification = ET.fromstring('''
        <hierarchy bounds="[0,0][720,1600]"><node text="为保障您的正常访问请进行验证">
          <node bounds="[80,700][640,780]">
            <node text="向右滑动验证" bounds="[80,700][300,780]"/>
          </node>
        </node></hierarchy>
        ''')

        class SliderRunner(self.lookup.Runner):
            def adb(inner_self, args, **kwargs):
                return ""

            def dump(inner_self, token, **kwargs):
                return verification, {}

        runner = SliderRunner({"serial": "LOCAL", "taskId": "slider-exhausted"})
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            with self.assertRaisesRegex(
                RuntimeError, "^alipay_basic_slider_verification_failed$"
            ):
                runner.solve_human_verification(verification, {}, "test", max_attempts=1)

    def test_lookup_waits_for_delayed_input_readback_before_searching(self):
        phone = "13800000008"
        input_empty = ET.fromstring(f'<hierarchy><node resource-id="{self.lookup.SEARCH_INPUT_ID}" text=""/></hierarchy>')
        input_ready = ET.fromstring(f'<hierarchy><node resource-id="{self.lookup.SEARCH_INPUT_ID}" text="{phone}"/></hierarchy>')
        result_ready = ET.fromstring(f'''
        <hierarchy><node>
          <node resource-id="{self.lookup.SEARCH_INPUT_ID}" text="{phone}"/>
          <node text="{phone}"/><node text="*测"/><node text="转账"/><node text="加好友"/>
        </node></hierarchy>
        ''')

        class LaggyRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({"serial": "LOCAL", "taskId": "laggy"})
                inner_self.dumps = iter([input_empty, input_ready, result_ready])

            def search_ready(inner_self):
                return input_empty, {}, next(input_empty.iter("node"))

            def clear_search_input(inner_self, root, parent, input_node):
                inner_self.emit("clear_previous_query")

            def adb(inner_self, args, **kwargs):
                return ""

            def dump(inner_self, token):
                return next(inner_self.dumps), {}

        runner = LaggyRunner()
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            result = runner.query_once(phone)
        self.assertEqual(result["realNameTailCharacter"], "测")
        input_event = next(item for item in runner.log if item["step"] == "input_phone")
        self.assertNotIn("phone", input_event)

    def test_lookup_clear_search_input_batches_delete_keyevents(self):
        root = ET.fromstring(
            f'<hierarchy><node resource-id="{self.lookup.SEARCH_INPUT_ID}" '
            'text="13800000022" clickable="true" bounds="[40,40][680,120]"/></hierarchy>'
        )
        input_node = next(root.iter("node"))

        class BatchClearRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({"serial": "LOCAL", "taskId": "batch-clear"})
                inner_self.commands = []

            def adb(inner_self, args, **kwargs):
                inner_self.commands.append(args)
                return ""

        runner = BatchClearRunner()
        runner.clear_search_input(root, {}, input_node)
        self.assertEqual(len(runner.commands), 2)
        self.assertEqual(runner.commands[0], ["shell", "input", "tap", "360", "80"])
        self.assertEqual(runner.commands[1][:4], [
            "shell", "input", "keyevent", "--delay",
        ])
        self.assertGreaterEqual(int(runner.commands[1][4]), 55)
        self.assertLessEqual(int(runner.commands[1][4]), 95)
        self.assertEqual(runner.commands[1][5:7], ["123", "67"])
        self.assertEqual(runner.commands[1].count("67"), 24)
        self.assertEqual(runner.log[-1]["method"], "element_tap_batched_keyevents")
        self.assertEqual(runner.log[-1]["keyDelayMs"], int(runner.commands[1][4]))

    def test_lookup_inputs_phone_as_humanized_digit_keyevents(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "humanized-input"})
        runner.adb = mock.Mock(return_value="")
        with mock.patch.object(self.lookup.random, "randint", return_value=111):
            runner.input_phone_humanized(
                "13800000008", "test_exact_input", timeout=5, driver="poco",
            )
        runner.adb.assert_called_once_with([
            "shell", "input", "keyevent", "--delay", "111",
            *phone_keycodes("13800000008"),
        ], timeout=5)
        event = runner.log[-1]
        self.assertEqual(event["keyDelayMs"], 111)
        self.assertEqual(event["keyCount"], 11)
        self.assertNotIn("phone", event)

    def test_lookup_focused_search_fast_path_requires_activity_field_and_editor_package(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "focus-proof"})
        runner.focus = lambda: [
            "mCurrentFocus=com.eg.android.AlipayGphone/",
            "mFocusedApp=com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity",
        ]
        exact_state = '''
        mServedView=com.alipay.mobile.antui.basic.AUEditText{abc com.alipay.mobile.antui:id/search_input_box}
        mCurrentEditorInfo:
          inputType=0x1
          packageName=com.eg.android.AlipayGphone fieldId=789184854
        '''
        runner.adb = lambda *args, **kwargs: exact_state
        self.assertTrue(runner.focused_search_input_ready())
        runner.adb = lambda *args, **kwargs: exact_state.replace(
            "search_input_box", "another_input",
        )
        self.assertFalse(runner.focused_search_input_ready())
        runner.adb = lambda *args, **kwargs: exact_state.replace(
            "packageName=com.eg.android.AlipayGphone", "packageName=another.package",
        )
        self.assertFalse(runner.focused_search_input_ready())

    def test_lookup_focused_search_input_length_uses_cursor_not_hint_digits(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "cursor-length"})
        runner.focus = lambda: [
            "mCurrentFocus=com.eg.android.AlipayGphone/MainSearchActivity",
        ]
        state = '''
        mCurrentTextBoxAttribute:
          hintText=备用金5000额度
          packageName=com.eg.android.AlipayGphone fieldId=789184854
        mCursorSelStart=0 mCursorSelEnd=0 mCursorCandStart=-1 mCursorCandEnd=-1
        mServedView=com.alipay.mobile.antui.basic.AUEditText{abc com.alipay.mobile.antui:id/search_input_box}
        '''
        runner.adb = mock.Mock(return_value=state)
        self.assertEqual(runner.focused_search_input_length(), 0)

        runner.adb.return_value = state.replace(
            "mCursorSelStart=0 mCursorSelEnd=0",
            "mCursorSelStart=11 mCursorSelEnd=11",
        )
        self.assertEqual(runner.focused_search_input_length(), 11)
    def test_lookup_xml_returns_unverified_result_from_first_input_readback(self):
        phone = "13800000022"
        search = ET.fromstring(
            f'<hierarchy><node resource-id="{self.lookup.SEARCH_INPUT_ID}" '
            'text="" clickable="true" bounds="[40,40][680,120]"/></hierarchy>'
        )
        result_ready = ET.fromstring(f'''
        <hierarchy><node>
          <node resource-id="{self.lookup.SEARCH_INPUT_ID}" text="{phone}"/>
          <node text="138******22(未实名)" bounds="[80,240][640,300]"/>
          <node text="{phone}" bounds="[80,305][640,350]"/>
          <node text="转账" bounds="[80,380][300,440]"/>
          <node text="加好友" bounds="[420,380][640,440]"/>
        </node></hierarchy>
        ''')

        class FirstReadbackRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({"serial": "LOCAL", "taskId": "first-readback"})
                inner_self.dump_tokens = []

            def focused_search_input_ready(inner_self):
                return True

            def clear_focused_search_input(inner_self, method="focused_input_resource"):
                inner_self.emit("clear_previous_query", method=method)

            def search_ready(inner_self):
                raise AssertionError("exact focused input must skip the pre-query XML dump")

            def adb(inner_self, args, **kwargs):
                return ""

            def dump(inner_self, token):
                inner_self.dump_tokens.append(token)
                return result_ready, {child: node for node in result_ready.iter() for child in node}

        runner = FirstReadbackRunner()
        result = runner.query_once(phone)
        self.assertTrue(result["notFound"])
        self.assertEqual(result["message"], "account_not_real_named")
        self.assertEqual(runner.dump_tokens, ["input-readback"])
        self.assertEqual(runner.log[0]["method"], "focused_input_resource")
        self.assertEqual(runner.log[-1]["step"], "lookup_no_name_result")

    def test_lookup_account_navigation_retries_after_late_startup_ad(self):
        home = ET.fromstring(f'''
        <hierarchy><node>
          <node resource-id="{self.lookup.TAB_DESCRIPTION_ID}" text="我的"
                clickable="true" bounds="[576,1496][720,1604]"/>
        </node></hierarchy>
        ''')
        late_ad = ET.fromstring(f'''
        <hierarchy><node>
          <node resource-id="{self.lookup.TAB_DESCRIPTION_ID}" text="我的"
                clickable="true" bounds="[576,1496][720,1604]"/>
          <node content-desc="全屏广告" clickable="true" bounds="[0,0][720,1604]">
            <node content-desc="关闭" clickable="true" bounds="[330,1224][390,1284]"/>
          </node>
        </node></hierarchy>
        ''')
        settings = ET.fromstring(f'''
        <hierarchy><node>
          <node resource-id="{self.lookup.SETTINGS_ENTRY_ID}" content-desc="设置"
                clickable="true" bounds="[648,78][696,174]"/>
        </node></hierarchy>
        ''')

        class LateAdRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({"serial": "LOCAL", "taskId": "late-ad"})
                inner_self.dumps = iter([home, late_ad, home, settings])
                inner_self.commands = []

            def dump(inner_self, token):
                root = next(inner_self.dumps)
                return root, {child: node for node in root.iter() for child in node}

            def adb(inner_self, args, **kwargs):
                inner_self.commands.append(args)
                return ""

        runner = LateAdRunner()
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.enter_my_settings("test")
        steps = [item["step"] for item in runner.log]
        self.assertEqual(steps.count("open_my_tab"), 2)
        self.assertIn("dismiss_alipay_fullscreen_ad", steps)
        self.assertIn("account_navigation_retry", steps)
        self.assertEqual(steps[-1], "open_settings")

    def test_lookup_visual_settings_fallback_requires_selected_my_tab_and_uses_rightmost_gear(self):
        import cv2
        import numpy as np

        selected_my = ET.fromstring(f'''
        <hierarchy><node>
          <node resource-id="{self.lookup.TAB_DESCRIPTION_ID}" text="我的"
                selected="true" clickable="true" bounds="[576,1420][720,1528]"/>
        </node></hierarchy>
        ''')
        image = np.full((1612, 720, 3), 235, dtype=np.uint8)
        cv2.circle(image, (584, 103), 21, (30, 30, 30), thickness=-1)
        cv2.circle(image, (670, 103), 22, (20, 20, 20), thickness=-1)
        encoded_ok, encoded = cv2.imencode(".png", image)
        self.assertTrue(encoded_ok)

        class CanvasSettingsRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({"serial": "LOCAL", "taskId": "canvas-settings"})
                inner_self.commands = []

            def adb(inner_self, args, **kwargs):
                inner_self.commands.append(args)
                if args == ["exec-out", "screencap", "-p"]:
                    return encoded.tobytes()
                return ""

        runner = CanvasSettingsRunner()
        self.assertTrue(runner.tap_visual_settings_gear(selected_my))
        tap = next(command for command in runner.commands if command[:4] == ["shell", "input", "tap", "670"])
        self.assertEqual(tap, ["shell", "input", "tap", "670", "103"])
        runner.find(selected_my, text="我的", resource_id=self.lookup.TAB_DESCRIPTION_ID)[0].set(
            "selected", "false",
        )
        with self.assertRaisesRegex(RuntimeError, "visual_settings_requires_selected_my_tab"):
            runner.tap_visual_settings_gear(selected_my)

    def test_lookup_account_picker_handles_login_other_intermediate_sheet(self):
        import cv2
        import numpy as np

        sheet = ET.fromstring('''
        <hierarchy><node>
          <node text="登录其他账号" clickable="true" bounds="[0,1100][720,1200]"/>
          <node text="退出登录" clickable="true" bounds="[0,1200][720,1300]"/>
          <node text="取消" clickable="true" bounds="[0,1300][720,1400]"/>
        </node></hierarchy>
        ''')
        picker = ET.fromstring(f'''
        <hierarchy><node>
          <node text="切换账号"/>
          <node>
            <node resource-id="{self.lookup.ACCOUNT_ID}" text="190******13"/>
            <node resource-id="{self.lookup.ACCOUNT_CURRENT_ID}" text="当前"/>
          </node>
          <node><node resource-id="{self.lookup.ACCOUNT_ID}" text="198******91"/></node>
        </node></hierarchy>
        ''')
        image = np.full((1612, 720, 3), 230, dtype=np.uint8)
        image[1180:1300, 18:702] = 255
        image[1350:1470, 18:702] = 255
        encoded_ok, encoded = cv2.imencode(".png", image)
        self.assertTrue(encoded_ok)

        class SheetRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({"serial": "LOCAL", "taskId": "account-sheet"})
                inner_self.dumps = iter([sheet, picker])
                inner_self.commands = []

            def enter_my_settings(inner_self, token, max_attempts=3):
                return None

            def dump(inner_self, token):
                root = next(inner_self.dumps)
                return root, {child: node for node in root.iter() for child in node}

            def adb(inner_self, args, **kwargs):
                inner_self.commands.append(args)
                if args == ["exec-out", "screencap", "-p"]:
                    return encoded.tobytes()
                return ""

        runner = SheetRunner()
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            rows = runner.open_account_picker("test")
        self.assertEqual([(row[0], row[1]) for row in rows], [
            ("190******13", True), ("198******91", False),
        ])
        self.assertIn(
            "open_login_other_account_sheet", [item["step"] for item in runner.log],
        )

    def test_lookup_access_denied_requires_exact_title_and_proxy_vpn_hint(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "access-denied-evidence"})
        denied = ET.fromstring('''
        <hierarchy><node>
          <node text="访问被拒绝"/>
          <node text="请检查是否使用了代理软件或 VPN"/>
        </node></hierarchy>
        ''')
        incomplete = ET.fromstring('''
        <hierarchy><node><node text="访问被拒绝"/><node text="请稍后重试"/></node></hierarchy>
        ''')
        evidence = runner.access_denied_evidence(denied)
        self.assertEqual(evidence["title"], "访问被拒绝")
        self.assertIn("VPN", evidence["hint"])
        self.assertIsNone(runner.access_denied_evidence(incomplete))

    def test_lookup_poco_detects_access_denied_from_exact_visible_text(self):
        class TextNode:
            def __init__(inner_self, text):
                inner_self.text = text

            def attr(inner_self, key):
                return inner_self.text if key == "text" else ""

        class Snapshot:
            def __call__(inner_self, **selector):
                if selector.get("type") == "android.widget.TextView":
                    return [TextNode("访问被拒绝"), TextNode("请检查是否使用了代理软件或VPN")]
                return []

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-access-denied"})
        evidence = runner.poco_access_denied_evidence(Snapshot())
        self.assertEqual(evidence["title"], "访问被拒绝")

    def test_lookup_poco_normalizes_only_the_exact_missing_visible_node_error(self):
        class MissingProxy:
            def exists(inner_self):
                return True

            def __iter__(inner_self):
                raise RuntimeError('Cannot find any visible node by query UIObjectProxy of "desc=全屏广告"')

        class MissingSnapshot:
            def __call__(inner_self, **selector):
                return MissingProxy()

        class BrokenSnapshot:
            def __call__(inner_self, **selector):
                raise RuntimeError("hrpc transport timed out")

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "optional-node"})
        self.assertEqual(runner.poco_nodes(MissingSnapshot(), desc="全屏广告"), [])
        with self.assertRaisesRegex(RuntimeError, "hrpc transport timed out"):
            runner.poco_nodes(BrokenSnapshot(), desc="全屏广告")

    def test_lookup_poco_unique_selects_from_a_frozen_snapshot_not_the_live_proxy(self):
        expected = FakeNode("target", (0.5, 0.5))
        live_proxy = object()

        class FrozenSnapshot:
            def __call__(inner_self, **selector):
                return [expected] if selector.get("name") == "target" else []

        class LivePoco:
            def __init__(inner_self):
                inner_self.freeze_count = 0
                inner_self.live_select_count = 0

            def freeze(inner_self):
                inner_self.freeze_count += 1
                return FrozenSnapshot()

            def __call__(inner_self, **selector):
                inner_self.live_select_count += 1
                self.assertEqual(selector, {"name": "target"})
                return live_proxy

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "frozen-unique"})
        poco = LivePoco()
        actual = runner.poco_unique(poco, timeout=0.1, name="target")

        self.assertIs(actual, live_proxy)
        self.assertEqual(poco.freeze_count, 1)
        self.assertEqual(poco.live_select_count, 1)

    def test_lookup_detects_the_exact_account_restrictions_observed_on_87(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "87-restrictions"})
        jigsaw = runner.verification_evidence(ET.fromstring('''
        <hierarchy><node>
          <node text="为保障您的正常访问请进行验证"/>
          <node text="请拖动滑块完成拼图"/>
        </node></hierarchy>
        '''))
        loading_jigsaw = runner.verification_evidence(ET.fromstring('''
        <hierarchy><node>
          <node text="为保障您的正常访问请进行验证"/>
          <node text="反馈码: cb4cd32d-4a69-470f-b97e-7c65979cf724"/>
        </node></hierarchy>
        '''))
        self.assertIsNone(runner.account_restriction_evidence_from_texts([
            "提示", "为保障您的正常访问请进行验证", "请拖动滑块完成拼图",
        ]))
        self.assertIsNone(runner.account_restriction_evidence_from_texts([
            "提示", "为保障您的正常访问请进行验证",
            "反馈码: cb4cd32d-4a69-470f-b97e-7c65979cf724", "@蚂蚁集团",
        ]))
        device_risk = runner.account_restriction_evidence_from_texts([
            "您的设备可能存在风险，请检查或切换设备",
            "检查或切换设备后，请等待一段时间再试",
        ])
        frequent_access = runner.account_restriction_evidence_from_texts([
            "操作频繁或访问异常，请稍后再试", "请稍后",
        ])
        self.assertTrue(jigsaw["manual"])
        self.assertTrue(loading_jigsaw["manual"])
        self.assertEqual(device_risk["reason"], "device_risk")
        self.assertEqual(frequent_access["reason"], "frequent_or_abnormal_access")
        self.assertEqual(
            runner.account_switch_reason_from_error(
                "alipay_account_restriction_switch_required:frequent_or_abnormal_access"
            ),
            "frequent_or_abnormal_access",
        )
        self.assertIsNone(runner.account_restriction_evidence_from_texts([
            "为保障您的正常访问请进行验证", "向右滑动验证",
        ]))
        self.assertIsNone(runner.account_restriction_evidence_from_texts([
            "您的设备可能存在风险，请检查或切换设备", "请稍后再试",
        ]))
        self.assertIsNone(runner.account_restriction_evidence_from_texts([
            "操作频繁或访问异常，请稍后再试",
        ]))

    def test_lookup_only_requests_account_switch_after_a_phone_query_was_started(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "submitted-gate"})
        evidence = {
            "reason": "device_risk",
            "title": "您的设备可能存在风险，请检查或切换设备",
        }
        with self.assertRaisesRegex(RuntimeError, "alipay_account_restriction_before_search") as before:
            runner.raise_account_restriction(evidence, "session-start", "poco")
        self.assertEqual(runner.account_switch_reason_from_error(before.exception), "device_risk")
        self.assertFalse(runner.log[-1]["phoneQueryStarted"])
        self.assertFalse(runner.log[-1]["accountSwitchRequired"])
        with self.assertRaisesRegex(RuntimeError, "alipay_account_restriction_switch_required") as after:
            runner.raise_account_restriction(
                evidence, "input-readback", "poco", phone_query_started=True,
            )
        self.assertEqual(runner.account_switch_reason_from_error(after.exception), "device_risk")
        self.assertTrue(runner.log[-1]["phoneQueryStarted"])
        self.assertTrue(runner.log[-1]["accountSwitchRequired"])

    def test_lookup_poco_start_keeps_an_evidenced_restriction_page_without_relaunch(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "start-restricted", "operation": "start",
        })
        runner.adb = mock.Mock(side_effect=lambda args, **kwargs: (
            "device" if args == ["get-state"] else "package:/data/app/alipay/base.apk"
        ))
        runner.keep_awake_usb_best_effort = mock.Mock()
        runner.poco_try_reuse_search_page = mock.Mock(side_effect=RuntimeError(
            "alipay_account_restriction_before_search:device_risk"
        ))
        runner.poco_prepare_full_path = mock.Mock(side_effect=AssertionError(
            "an evidenced restriction page must not relaunch Alipay"
        ))

        result = runner.run_poco(object())

        self.assertTrue(result["ok"])
        self.assertEqual(result["message"], "search_session_restricted")
        self.assertEqual(result["restrictionReason"], "device_risk")
        self.assertEqual(runner.log[-1]["step"], "lookup_session_ready_on_restriction_page")
        self.assertFalse(runner.log[-1]["phoneQueryStarted"])
        self.assertEqual(runner.log[-1]["driver"], "poco")
        runner.poco_prepare_full_path.assert_not_called()

    def test_lookup_poco_start_keeps_jigsaw_available_for_human_control(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "start-jigsaw", "operation": "start",
        })
        runner.adb = mock.Mock(side_effect=lambda args, **kwargs: (
            "device" if args == ["get-state"] else "package:/data/app/alipay/base.apk"
        ))
        runner.keep_awake_usb_best_effort = mock.Mock()
        runner.wake_and_unlock_for_lookup_start = mock.Mock()
        runner.poco_try_reuse_search_page = mock.Mock(side_effect=RuntimeError(
            "poco_alipay_human_verification_required:jigsaw_verification"
        ))
        runner.poco_prepare_full_path = mock.Mock(side_effect=AssertionError(
            "jigsaw must remain visible for human control"
        ))

        result = runner.run_poco(object())

        self.assertTrue(result["ok"])
        self.assertTrue(result["requiresHumanAction"])
        self.assertEqual(result["restrictionReason"], "jigsaw_verification")
        self.assertEqual(
            runner.log[-1]["step"],
            "lookup_session_ready_on_human_verification_page",
        )
        runner.poco_prepare_full_path.assert_not_called()

    def test_lookup_poco_reuse_probes_a_foreground_restriction_without_search_history(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-restricted"})
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=Window{123 u0 com.eg.android.AlipayGphone/"
            "com.alipay.mobile.nebulax.integration.mpaas.activity.NebulaTransActivity$Main}"
        ])
        runner.poco_raise_if_login_required = mock.Mock(return_value=None)
        runner.poco_raise_if_account_restricted = mock.Mock(side_effect=RuntimeError(
            "alipay_account_restriction_before_search:device_risk"
        ))
        runner.adb = mock.Mock(side_effect=AssertionError(
            "an evidenced foreground restriction must not inspect or resume the old task stack"
        ))
        snapshot = object()
        poco = mock.Mock()
        poco.freeze.return_value = snapshot

        with self.assertRaisesRegex(
            RuntimeError, "alipay_account_restriction_before_search:device_risk",
        ):
            runner.poco_try_reuse_search_page(poco)

        poco.freeze.assert_called_once_with()
        runner.poco_raise_if_login_required.assert_called_once_with(
            snapshot, "reuse-foreground"
        )
        runner.poco_raise_if_account_restricted.assert_called_once_with(
            snapshot, "reuse-foreground"
        )
        runner.adb.assert_not_called()
        self.assertIn(
            "poco_reuse_restriction_probe_done",
            [event["step"] for event in runner.log],
        )

    def test_lookup_poco_reuse_opens_search_directly_from_foreground_home(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-home"})
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=Window{123 u0 com.eg.android.AlipayGphone/.AlipayLogin}"
        ])
        runner.poco_raise_if_login_required = mock.Mock(return_value=None)
        runner.poco_raise_if_account_restricted = mock.Mock(return_value=None)
        runner.poco_open_search = mock.Mock(return_value=None)
        runner.adb = mock.Mock(side_effect=AssertionError(
            "a responsive foreground Alipay home must not be cold relaunched"
        ))
        snapshot = object()
        poco = mock.Mock()
        poco.freeze.return_value = snapshot

        reused = runner.poco_try_reuse_search_page(poco)

        self.assertTrue(reused)
        runner.poco_raise_if_login_required.assert_called_once_with(
            snapshot, "reuse-foreground"
        )
        runner.poco_raise_if_account_restricted.assert_called_once_with(
            snapshot, "reuse-foreground"
        )
        runner.poco_open_search.assert_called_once_with(poco, "reuse-foreground")
        runner.adb.assert_not_called()
        self.assertEqual(runner.log[-1]["step"], "reuse_existing_search_page")
        self.assertEqual(runner.log[-1]["method"], "poco_open_from_foreground")

    def test_lookup_poco_reuse_dismisses_securepay_before_alipay_hierarchy_probe(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-securepay"})
        runner.focus = mock.Mock(side_effect=[
            [
                "mCurrentFocus=Window{abc u0 com.coloros.securepay}",
                "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            ],
            ["mCurrentFocus=Window{ghi u0 com.eg.android.AlipayGphone/.AlipayLogin}"],
        ])
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=True)
        runner.poco_raise_if_login_required = mock.Mock(return_value=None)
        runner.poco_raise_if_account_restricted = mock.Mock(return_value=None)
        runner.poco_open_search = mock.Mock(return_value=None)
        snapshot = object()
        poco = mock.Mock()
        poco.freeze.return_value = snapshot

        reused = runner.poco_try_reuse_search_page(poco)

        self.assertTrue(reused)
        runner.poco_dismiss_coloros_securepay_usb_dialog.assert_called_once_with(poco)
        poco.freeze.assert_called_once_with()
        runner.poco_open_search.assert_called_once_with(poco, "reuse-foreground")
        self.assertIn(
            "retry_reuse_after_coloros_securepay_warning",
            [event["step"] for event in runner.log],
        )

    def test_lookup_poco_reuse_propagates_login_required_before_open_search(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-login-required"})
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=Window{123 u0 com.eg.android.AlipayGphone/"
            "com.ali.user.mobile.loginupgrade.activity.GuideActivity}"
        ])
        runner.poco_raise_if_login_required = mock.Mock(side_effect=RuntimeError(
            "poco_alipay_login_required"
        ))
        runner.poco_raise_if_account_restricted = mock.Mock(return_value=None)
        runner.poco_open_search = mock.Mock(side_effect=AssertionError(
            "an evidenced login surface must not probe Search"
        ))
        snapshot = object()
        poco = mock.Mock()
        poco.freeze.return_value = snapshot

        with self.assertRaisesRegex(RuntimeError, "poco_alipay_login_required"):
            runner.poco_try_reuse_search_page(poco)

        runner.poco_raise_if_login_required.assert_called_once_with(
            snapshot, "reuse-foreground"
        )
        runner.poco_raise_if_account_restricted.assert_not_called()
        runner.poco_open_search.assert_not_called()

    def test_lookup_poco_reuse_detects_exact_login_activity_without_hierarchy_probe(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-login-activity"})
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=Window{123 u0 com.eg.android.AlipayGphone/"
            "com.ali.user.mobile.loginupgrade.activity.LoginActivity}"
        ])
        runner.poco_open_search = mock.Mock(side_effect=AssertionError(
            "the exact login activity must not probe or open Search"
        ))
        poco = mock.Mock()

        with self.assertRaisesRegex(RuntimeError, "poco_alipay_login_required"):
            runner.poco_try_reuse_search_page(poco)

        poco.freeze.assert_not_called()
        runner.poco_open_search.assert_not_called()
        self.assertEqual(runner.log[-1]["step"], "alipay_login_required_detected")
        self.assertEqual(runner.log[-1]["driver"], "poco_window_focus")
        self.assertEqual(runner.log[-1]["loginSurface"], "login_activity")

    def test_lookup_poco_login_focus_does_not_confuse_normal_alipay_home(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "home-not-login"})

        runner.poco_raise_if_login_focus(
            "mCurrentFocus=Window{123 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            "unit-home",
        )

        self.assertEqual(runner.log, [])

    def test_lookup_poco_detects_the_exact_login_surface_observed_on_6(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "login-required"})
        runner.poco_snapshot_texts = mock.Mock(return_value=[
            "176 **** **17", "换号", "短信验证码登录", "其他验证方式", "注册账号", "遇到问题",
        ])

        with self.assertRaisesRegex(RuntimeError, "poco_alipay_login_required"):
            runner.poco_raise_if_login_required(object(), "reuse-foreground")

        self.assertEqual(runner.log[-1]["step"], "alipay_login_required_detected")
        self.assertEqual(runner.log[-1]["phase"], "reuse-foreground")
        self.assertFalse(runner.log[-1]["phoneQueryStarted"])
        self.assertEqual(runner.log[-1]["loginSurface"], "sms_code")

    def test_lookup_poco_detects_the_exact_carrier_login_surface_observed_on_86(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "carrier-login-required"})
        runner.poco_snapshot_texts = mock.Mock(return_value=[
            "175 **** **75", "换号", "同意支付宝向运营商获取完整本机号码", "本机号码一键登录",
        ])

        with self.assertRaisesRegex(RuntimeError, "poco_alipay_login_required"):
            runner.poco_raise_if_login_required(object(), "open-search-session-start")

        self.assertEqual(runner.log[-1]["step"], "alipay_login_required_detected")
        self.assertEqual(runner.log[-1]["phase"], "open-search-session-start")
        self.assertFalse(runner.log[-1]["phoneQueryStarted"])
        self.assertEqual(runner.log[-1]["loginSurface"], "carrier_one_tap")

    def test_lookup_poco_start_propagates_login_required_without_relaunch(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "start-login-required", "operation": "start",
        })
        runner.adb = mock.Mock(side_effect=lambda args, **kwargs: (
            "device" if args == ["get-state"] else "package:/data/app/alipay/base.apk"
        ))
        runner.keep_awake_usb_best_effort = mock.Mock()
        runner.poco_try_reuse_search_page = mock.Mock(side_effect=RuntimeError(
            "poco_alipay_login_required"
        ))
        runner.poco_prepare_full_path = mock.Mock(side_effect=AssertionError(
            "a login-required surface must not relaunch Alipay"
        ))

        with self.assertRaisesRegex(RuntimeError, "poco_alipay_login_required"):
            runner.run_poco(object())

        runner.poco_prepare_full_path.assert_not_called()

    def test_lookup_poco_start_returns_transport_failure_without_relaunch(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "start-transport-failed", "operation": "start",
        })
        runner.adb = mock.Mock(side_effect=lambda args, **kwargs: (
            "device" if args == ["get-state"] else "package:/data/app/alipay/base.apk"
        ))
        runner.keep_awake_usb_best_effort = mock.Mock()
        runner.poco_try_reuse_search_page = mock.Mock(side_effect=RuntimeError(
            "poco_rpc_failed:TimeoutError:timed out"
        ))
        runner.poco_prepare_full_path = mock.Mock(side_effect=AssertionError(
            "a failed Poco transport must rebuild the worker, not relaunch Alipay"
        ))

        with self.assertRaisesRegex(RuntimeError, "poco_rpc_failed"):
            runner.run_poco(object())

        runner.poco_prepare_full_path.assert_not_called()
        self.assertEqual(runner.log[-1]["step"], "reuse_search_transport_failed")
        self.assertEqual(runner.log[-1]["driver"], "poco")

    def test_lookup_poco_start_retries_foreground_selector_once_without_relaunch(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "start-selector-late", "operation": "start",
        })
        runner.adb = mock.Mock(side_effect=lambda args, **kwargs: (
            "device" if args == ["get-state"] else "package:/data/app/alipay/base.apk"
        ))
        runner.keep_awake_usb_best_effort = mock.Mock()
        runner.wake_and_unlock_for_lookup_start = mock.Mock()
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=Window{123 u0 com.eg.android.AlipayGphone/"
            "com.alipay.mobile.nebulax.integration.mpaas.activity.NebulaActivity}"
        ])
        runner.poco_try_reuse_search_page = mock.Mock(side_effect=[
            RuntimeError("poco_selector_missing:{'name': 'search_input'}; count=0"),
            True,
        ])
        runner.poco_prepare_full_path = mock.Mock(side_effect=AssertionError(
            "a late foreground selector must not cold relaunch Alipay"
        ))

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            result = runner.run_poco(object())

        self.assertTrue(result["ok"])
        self.assertEqual(result["message"], "search_session_ready")
        self.assertEqual(runner.poco_try_reuse_search_page.call_count, 2)
        runner.poco_prepare_full_path.assert_not_called()
        retry = next(
            event for event in runner.log
            if event["step"] == "reuse_search_selector_missing_retry"
        )
        self.assertEqual(retry["retryAttempt"], 1)
        self.assertEqual(retry["maxRetries"], 1)
        self.assertFalse(retry["relaunchesAlipay"])
        self.assertEqual(retry["driver"], "poco")

    def test_lookup_poco_stop_keeps_an_evidenced_restriction_page_without_xml_recovery(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "stop-restricted", "operation": "stop",
        })
        runner.adb = mock.Mock(side_effect=lambda args, **kwargs: (
            "device" if args == ["get-state"] else "package:/data/app/alipay/base.apk"
        ))
        runner.poco_account_restriction_evidence = mock.Mock(return_value={
            "reason": "jigsaw_verification",
            "title": "为保障您的正常访问请进行验证",
        })
        runner.poco_search_ready = mock.Mock(side_effect=AssertionError("search page must not be rebuilt"))
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=True)
        poco = mock.Mock()

        result = runner.run_poco(poco)

        self.assertTrue(result["ok"])
        runner.poco_search_ready.assert_not_called()
        self.assertEqual(runner.log[-1]["step"], "lookup_session_stopped")
        self.assertEqual(runner.log[-1]["driver"], "poco")
        self.assertTrue(runner.log[-1]["restrictionPageKeptForDiagnosis"])
        runner.poco_dismiss_coloros_securepay_usb_dialog.assert_called_once_with(poco)

    def test_lookup_poco_open_search_handles_coloros_warning_that_reappears_after_the_tap(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "late-securepay"})
        search = object()
        search_input = object()
        runner.poco_dismiss_known_overlay = mock.Mock(return_value=False)
        runner.poco_unique = mock.Mock(side_effect=[
            search,
            RuntimeError("poco_selector_missing:{'name': 'search_input'}; count=0"),
            search_input,
        ])
        runner.poco_tap = mock.Mock()
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=True)

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_open_search(object(), "session-start")

        runner.poco_tap.assert_called_once_with(search)
        runner.poco_dismiss_coloros_securepay_usb_dialog.assert_called_once()
        self.assertEqual(runner.log[-1]["step"], "retry_search_input_after_coloros_securepay_warning")

    def test_lookup_poco_search_ready_dismisses_coloros_warning_before_checking_focus(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "search-ready-securepay"})
        runner.focus = mock.Mock(side_effect=[
            ["mCurrentFocus=Window{abc u0 com.coloros.securepay}"],
            ["mCurrentFocus=Window{def u0 com.eg.android.AlipayGphone/MainSearchActivity}"],
        ])
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=True)
        expected = object()
        runner.poco_unique = mock.Mock(return_value=expected)

        actual = runner.poco_search_ready(object())

        self.assertIs(actual, expected)
        runner.poco_dismiss_coloros_securepay_usb_dialog.assert_called_once()
        self.assertIn(
            "retry_search_ready_after_coloros_securepay_warning",
            [event["step"] for event in runner.log],
        )
        self.assertEqual(runner.log[-1]["step"], "poco_search_input_probe_begin")

    def test_lookup_poco_waits_for_late_restriction_when_search_submit_never_appears(self):
        class InputNode:
            def __init__(inner_self):
                inner_self.value = ""

            def set_text(inner_self, value):
                inner_self.value = value

            def attr(inner_self, key):
                return inner_self.value if key == "text" else ""

            def get_position(inner_self):
                return (0.4, 0.08)

        input_node = InputNode()

        class Snapshot:
            def __call__(inner_self, **selector):
                if selector.get("name") == self.lookup.SEARCH_INPUT_ID:
                    return [input_node]
                return []

        class Poco:
            def freeze(inner_self):
                return Snapshot()

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "late-submit-restriction"})
        runner.poco_search_ready = mock.Mock(return_value=input_node)
        runner.poco_tap = mock.Mock()
        runner.focused_search_input_length = mock.Mock(return_value=0)
        runner.clear_focused_search_input = mock.Mock(
            side_effect=lambda method="": setattr(input_node, "value", ""),
        )
        runner.adb = mock.Mock(
            side_effect=lambda args, **kwargs: (
                setattr(input_node, "value", "13800000003")
                if is_phone_keyevent_command(args, "13800000003") else None
            ) or "",
        )
        runner.poco_wait_for_post_query_restriction = mock.Mock(
            side_effect=RuntimeError("late restriction evidence"),
        )

        with mock.patch.object(self.lookup, "POCO_NO_NAME_RESULT_SECONDS", 0.05):
            with self.assertRaisesRegex(RuntimeError, "late restriction evidence"):
                runner.query_once_poco(Poco(), "13800000003")

        runner.poco_wait_for_post_query_restriction.assert_called_once_with(
            mock.ANY, "search-submit-unavailable",
        )

    def test_lookup_poco_waits_for_late_restriction_after_submitted_page_loses_input(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "late-result-restriction"})

        class InputNode:
            def __init__(inner_self):
                inner_self.value = ""

            def set_text(inner_self, value):
                inner_self.value = value

            def attr(inner_self, key):
                return inner_self.value if key == "text" else ""

            def get_position(inner_self):
                return (0.4, 0.08)

        input_node = InputNode()
        confirm = object()
        submitted = {"value": False}

        class Snapshot:
            def __call__(inner_self, **selector):
                if submitted["value"]:
                    return []
                if selector.get("name") == self.lookup.SEARCH_INPUT_ID:
                    return [input_node]
                if selector.get("name") == "com.alipay.mobile.antui:id/search_confirm":
                    return [confirm]
                return []

        class Poco:
            def freeze(inner_self):
                return Snapshot()

        runner.poco_search_ready = mock.Mock(return_value=input_node)
        runner.focused_search_input_length = mock.Mock(return_value=0)
        runner.poco_raise_if_account_restricted = mock.Mock(return_value=None)
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        runner.parse_poco_result = mock.Mock(return_value=None)
        runner.clear_focused_search_input = mock.Mock(
            side_effect=lambda method="": setattr(input_node, "value", ""),
        )
        runner.adb = mock.Mock(
            side_effect=lambda args, **kwargs: (
                setattr(input_node, "value", "13800000003")
                if is_phone_keyevent_command(args, "13800000003") else None
            ) or "",
        )
        runner.poco_tap = mock.Mock(
            side_effect=lambda node: submitted.__setitem__("value", True)
            if node is confirm else None,
        )
        runner.poco_wait_for_post_query_restriction = mock.Mock(
            side_effect=RuntimeError(
                "poco_alipay_human_verification_required:jigsaw_verification"
            ),
        )

        with mock.patch.object(self.lookup, "POCO_NO_NAME_RESULT_SECONDS", 0.03):
            with mock.patch.object(self.lookup, "POCO_SEARCH_SUBMIT_DELAY_SECONDS", 0):
                with mock.patch.object(self.lookup.time, "sleep", return_value=None):
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "poco_alipay_human_verification_required:jigsaw_verification",
                    ):
                        runner.query_once_poco(Poco(), "13800000003")

        self.assertEqual(runner.poco_tap.call_args_list[-1], mock.call(confirm))
        runner.poco_wait_for_post_query_restriction.assert_called_once_with(
            mock.ANY, "result-page-state-changed",
        )

    def test_lookup_waits_for_a_late_webview_restriction_after_phone_input(self):
        loading = ET.fromstring("<hierarchy><node/></hierarchy>")
        jigsaw = ET.fromstring('''
        <hierarchy><node>
          <node text="为保障您的正常访问请进行验证"/>
          <node text="请拖动滑块完成拼图"/>
        </node></hierarchy>
        ''')

        class LateRestrictionRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({"serial": "LOCAL", "taskId": "late-restriction"})
                inner_self.dump_count = 0

            def dump(inner_self, token):
                inner_self.dump_count += 1
                root = loading if inner_self.dump_count == 1 else jigsaw
                return root, {child: node for node in root.iter() for child in node}

        runner = LateRestrictionRunner()
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            with self.assertRaisesRegex(
                RuntimeError, "alipay_human_verification_required:jigsaw_verification",
            ):
                runner.wait_for_post_query_restriction_xml("transition", timeout=1)
        self.assertEqual(runner.dump_count, 2)

    def test_lookup_start_never_switches_accounts(self):
        class StartRunner(self.lookup.Runner):
            def adb(inner_self, args, **kwargs):
                if args == ["get-state"]:
                    return "device"
                if args[:3] == ["shell", "pm", "path"]:
                    return "package:/alipay.apk"
                return ""

            def try_reuse_search_page(inner_self):
                return True

            def switch_account(inner_self):
                raise AssertionError("start must not switch accounts")

        runner = StartRunner({
            "serial": "LOCAL",
            "taskId": "start-restriction-gate",
            "operation": "start",
        })
        result = runner.run()
        self.assertTrue(result["ok"])
        self.assertFalse(result["accountSwitched"])

    def test_lookup_poco_detects_device_risk_from_exact_visible_text(self):
        class TextNode:
            def __init__(inner_self, text):
                inner_self.text = text

            def attr(inner_self, key):
                return inner_self.text if key == "text" else ""

        class Snapshot:
            def __call__(inner_self, **selector):
                if selector.get("type") == "android.widget.TextView":
                    return [
                        TextNode("您的设备可能存在风险，请检查或切换设备"),
                        TextNode("检查或切换设备后，请等待一段时间再试"),
                    ]
                return []

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-device-risk"})
        evidence = runner.poco_account_restriction_evidence(Snapshot())
        self.assertEqual(evidence["reason"], "device_risk")

    def test_lookup_rotates_through_all_saved_accounts_instead_of_bouncing_between_two(self):
        rows = [
            ("155******36", True, object()),
            ("190******13", False, object()),
            ("156******40", False, object()),
            ("198******82", False, object()),
            ("198******91", False, object()),
        ]
        current, target = self.lookup.Runner.rotation_account_rows(rows)
        self.assertEqual(current[0], "155******36")
        self.assertEqual(target[0], "198******91")
        reordered = [
            ("198******91", True, object()),
            ("155******36", False, object()),
            ("190******13", False, object()),
            ("156******40", False, object()),
            ("198******82", False, object()),
        ]
        _, next_target = self.lookup.Runner.rotation_account_rows(reordered)
        self.assertEqual(next_target[0], "198******82")

    def test_lookup_lists_saved_accounts_without_selecting_one(self):
        rows = [
            ("155******36", True, object()),
            ("190******13", False, object()),
            ("198******91", False, object()),
        ]

        class AccountListRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({
                    "serial": "LOCAL", "taskId": "account-list",
                    "operation": "list_accounts",
                })

            def adb(inner_self, args, **kwargs):
                return "device" if args == ["get-state"] else "package:/alipay.apk"

            def launch(inner_self, token):
                return None

            def open_account_picker(inner_self, token):
                return rows

        runner = AccountListRunner()
        result = runner.run()
        self.assertTrue(result["ok"])
        self.assertFalse(result["accountSwitched"])
        self.assertEqual(result["currentAccount"], "155******36")
        self.assertEqual(result["savedAccounts"], [
            {"account": "155******36", "current": True},
            {"account": "190******13", "current": False},
            {"account": "198******91", "current": False},
        ])
        self.assertIn("saved_account_list_ready", [item["step"] for item in runner.log])

    def test_lookup_rejects_ambiguous_masked_saved_account_labels(self):
        rows = [
            ("155******36", True, object()),
            ("155******36", False, object()),
        ]
        with self.assertRaisesRegex(RuntimeError, "alipay_saved_account_labels_not_unique"):
            self.lookup.Runner.saved_account_choices(rows)

    def test_lookup_jigsaw_is_returned_for_human_without_automatic_switch(self):
        phone = "13800000008"

        class RestrictedRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({
                    "serial": "LOCAL", "taskId": "manual-limit",
                    "operation": "query", "phoneNumber": phone,
                })
                inner_self.query_calls = []
                inner_self.switch_calls = 0

            def adb(inner_self, args, **kwargs):
                return "device" if args == ["get-state"] else "package:/alipay.apk"

            def switch_account(inner_self, reason="", excluded_accounts=None):
                inner_self.switch_calls += 1
                raise AssertionError("query must not switch accounts automatically")

            def query_once(inner_self, queried_phone, **kwargs):
                inner_self.query_calls.append(queried_phone)
                raise RuntimeError(
                    "alipay_human_verification_required:jigsaw_verification"
                )

        runner = RestrictedRunner()
        with self.assertRaisesRegex(
            RuntimeError, "alipay_human_verification_required:jigsaw_verification"
        ):
            runner.run()
        self.assertEqual(runner.query_calls, [phone])
        self.assertEqual(runner.switch_calls, 0)

    def test_lookup_exact_account_limit_auto_switches_and_retries_same_phone(self):
        phone = "13800000008"

        class AutoSwitchRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({
                    "serial": "LOCAL", "taskId": "automatic-limit",
                    "operation": "query", "phoneNumber": phone,
                })
                inner_self.query_calls = []
                inner_self.switch_reasons = []

            def adb(inner_self, args, **kwargs):
                return "device" if args == ["get-state"] else "package:/alipay.apk"

            def query_once(inner_self, queried_phone, **kwargs):
                inner_self.query_calls.append(queried_phone)
                if len(inner_self.query_calls) == 1:
                    raise RuntimeError(
                        "alipay_account_restriction_switch_required:frequent_or_abnormal_access"
                    )
                return {
                    "alipayDisplayName": "测试用户(**测)",
                    "realNameTailCharacter": "测",
                    "matchedPhone": queried_phone,
                    "matchMethod": "test",
                }

            def switch_account_for_reason(inner_self, reason):
                inner_self.switch_reasons.append(reason)
                inner_self.account_switched = True
                inner_self.account_switch_reason = reason
                inner_self.current_account_after_switch = "198******91"
                inner_self.account_switch_history.append({
                    "fromAccount": "155******36",
                    "toAccount": "198******91",
                    "reason": reason,
                })
                return inner_self.current_account_after_switch

        runner = AutoSwitchRunner()
        result = runner.run()
        self.assertTrue(result["ok"])
        self.assertEqual(runner.query_calls, [phone, phone])
        self.assertEqual(runner.switch_reasons, ["frequent_or_abnormal_access"])
        self.assertTrue(result["accountSwitched"])
        self.assertEqual(result["accountSwitchCount"], 1)

    def test_lookup_automatic_limit_switch_uses_exact_click_and_home_confirmation(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "fast-auto-switch"})
        runner.restricted_accounts.add("155******36")
        runner.switch_account = mock.Mock(return_value="198******91")

        current = runner.switch_account_for_reason("frequent_or_abnormal_access")

        self.assertEqual(current, "198******91")
        runner.switch_account.assert_called_once_with(
            reason="frequent_or_abnormal_access",
            excluded_accounts={"155******36"},
            verify_current_marker=False,
        )
        self.assertTrue(runner.account_switched)
        self.assertEqual(runner.current_account_after_switch, "198******91")

    def test_lookup_manual_switch_reuses_open_picker_and_uses_light_confirmation(self):
        class ManualSwitchRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({
                    "serial": "LOCAL", "taskId": "manual-switch",
                    "operation": "switch",
                    "targetAccount": "198******91",
                })

            def adb(inner_self, args, **kwargs):
                return "device" if args == ["get-state"] else "package:/alipay.apk"

            def switch_account(
                inner_self, reason="", excluded_accounts=None, target_account="",
                reuse_open_picker=False, verify_current_marker=True,
            ):
                self.assertEqual(target_account, "198******91")
                self.assertTrue(reuse_open_picker)
                self.assertFalse(verify_current_marker)
                inner_self.saved_account_count = 5
                inner_self.account_switch_history.append({
                    "fromAccount": "190******13", "toAccount": "198******91", "reason": reason,
                })
                return "198******91"

        runner = ManualSwitchRunner()
        result = runner.run()
        self.assertTrue(result["ok"])
        self.assertTrue(result["accountSwitched"])
        self.assertEqual(result["accountSwitchReason"], "manual")
        self.assertEqual(result["currentAccount"], "198******91")
        self.assertEqual(result["savedAccountCount"], 5)
        self.assertIn("manual_account_switch_requested", [item["step"] for item in runner.log])

    def test_lookup_manual_switch_does_not_reopen_picker_or_restart_alipay(self):
        current_node = ET.Element("node", {"bounds": "[0,100][720,200]"})
        target_node = ET.Element("node", {"bounds": "[0,300][720,400]"})
        rows = [
            ("155******36", True, current_node),
            ("198******91", False, target_node),
        ]

        class LeanManualSwitchRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({
                    "serial": "LOCAL", "taskId": "lean-manual-switch",
                    "operation": "switch", "targetAccount": "198******91",
                })
                inner_self.commands = []
                inner_self.search_opened = False

            def adb(inner_self, args, **kwargs):
                if args == ["get-state"]:
                    return "device"
                if args == ["shell", "pm", "path", self.lookup.ALIPAY_PACKAGE]:
                    return "package:/alipay.apk"
                inner_self.commands.append(args)
                return ""

            def reuse_open_account_picker(inner_self, token, timeout=4.0):
                inner_self.emit("reuse_open_account_picker", savedAccountCount=len(rows))
                return rows

            def launch(inner_self, reason):
                raise AssertionError("manual switch must not restart Alipay")

            def open_account_picker(inner_self, token):
                raise AssertionError("manual switch must not reopen the account picker")

            def wait_unique(inner_self, token, timeout=12, **selector):
                self.assertEqual(selector, {"text": "我的"})
                return ET.Element("hierarchy"), {}, ET.Element("node")

            def open_search(inner_self, reason):
                inner_self.search_opened = True

        runner = LeanManualSwitchRunner()
        result = runner.run()
        self.assertTrue(result["ok"])
        self.assertEqual(result["currentAccount"], "198******91")
        self.assertEqual(
            [command for command in runner.commands if command[:3] == ["shell", "input", "tap"]],
            [["shell", "input", "tap", "360", "350"]],
        )
        self.assertTrue(runner.search_opened)
        verification = next(item for item in runner.log if item["step"] == "account_switch_verified")
        self.assertEqual(verification["verification"], "exact_target_click_and_home_return")

    def test_lookup_success_count_200_does_not_trigger_account_switch(self):
        class CountRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({
                    "serial": "LOCAL", "taskId": "no-auto-200",
                    "operation": "query", "phoneNumber": "13800000008",
                    "successfulCountBefore": 200, "switchEvery": 200,
                })
                inner_self.switch_calls = 0

            def adb(inner_self, args, **kwargs):
                return "device" if args == ["get-state"] else "package:/alipay.apk"

            def switch_account(inner_self, reason="", excluded_accounts=None):
                inner_self.switch_calls += 1
                raise AssertionError("count must not trigger account switch")

            def query_once(inner_self, phone, **kwargs):
                return {
                    "alipayDisplayName": "测试用户(**测)",
                    "realNameTailCharacter": "测",
                    "matchedPhone": phone,
                    "matchMethod": "test",
                }

        runner = CountRunner()
        result = runner.run()
        self.assertTrue(result["ok"])
        self.assertEqual(runner.switch_calls, 0)

    def test_lookup_query_budget_is_independent_from_account_switch_time(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "budget"})
        runner.started -= 120
        observed = {}

        def fake_search_ready():
            root = ET.fromstring(f'<hierarchy><node resource-id="{self.lookup.SEARCH_INPUT_ID}"/></hierarchy>')
            node = next(root.iter("node"))
            return root, {}, node

        runner.search_ready = fake_search_ready
        runner.clear_search_input = lambda *args: None
        runner.adb = lambda *args, **kwargs: ""
        def fake_dump(token):
            observed["deadlineRemaining"] = runner_deadline[0] - self.lookup.time.perf_counter()
            phone = "13800000008"
            root = ET.fromstring(f'''
            <hierarchy><node><node resource-id="{self.lookup.SEARCH_INPUT_ID}" text="{phone}"/>
              <node text="{phone}"/><node text="*测"/><node text="转账"/><node text="加好友"/>
            </node></hierarchy>
            ''')
            return root, {}
        runner.dump = fake_dump
        runner_deadline = [self.lookup.time.perf_counter() + 55]
        result = runner.query_once("13800000008", query_deadline=runner_deadline[0])
        self.assertEqual(result["realNameTailCharacter"], "测")
        self.assertGreater(observed["deadlineRemaining"], 50)


if __name__ == "__main__":
    unittest.main()
