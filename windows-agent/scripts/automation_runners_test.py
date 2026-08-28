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
        if args and args[0] == "android.widget.EditText":
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
        sys.modules["xhs_airtest_poco"] = fake_base
        cls.publish = load_module("xhs_publish_poco_test", "xhs_publish_poco.py")
        cls.lookup = load_module("alipay_name_lookup_test", "alipay_name_lookup.py")

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
        self.assertTrue(self.publish.select_gallery_images(poco, 2, log))
        self.assertEqual(first.tapped, 1)
        self.assertEqual(second.tapped, 1)
        self.assertEqual(toolbar.tapped, 0)
        self.assertEqual(scanner.tapped, 0)
        selected = [item for item in log if item["step"] == "select_publish_image"]
        self.assertEqual([item["name"] for item in selected], ["photo-1", "photo-2"])

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
          <node text="测试用户(**测)"/><node text="13800138000"/>
          <node text="转账"/><node text="加好友"/>
        </node></hierarchy>
        """)
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "test"})
        result = runner.parse_result(root, {}, "13800138000")
        self.assertEqual(result["realNameTailCharacter"], "测")
        self.assertEqual(result["alipayDisplayName"], "测试用户(**测)")
        self.assertEqual(result["matchMethod"], "same_accessibility_result_container")
        self.assertIsNone(runner.parse_result(root, {}, "13900139000"))

    def test_lookup_poco_fast_path_extracts_only_exact_phone_result(self):
        phone = "13800138000"

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
        self.assertIsNone(runner.parse_poco_result(snapshot, "13900139000"))

    def test_lookup_poco_query_clears_and_sets_phone_once(self):
        phone = "13800138000"

        class InputNode:
            def __init__(inner_self):
                inner_self.value = "old"
                inner_self.values = []

            def set_text(inner_self, value):
                inner_self.value = value
                inner_self.values.append(value)

            def attr(inner_self, key):
                return inner_self.value if key == "text" else ""

        input_node = InputNode()
        result = {
            "alipayDisplayName": "测试用户(**测)",
            "realNameTailCharacter": "测",
            "matchedPhone": phone,
            "matchMethod": "poco_geometry_plus_exact_account_actions",
        }

        class Poco:
            def freeze(inner_self):
                return object()

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "poco-input"})
        runner.poco_search_ready = lambda poco: input_node
        runner.poco_snapshot_texts = lambda snapshot, limit=120: []
        runner.parse_poco_result = lambda snapshot, target: result if target == phone else None
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            observed = runner.query_once_poco(Poco(), phone)
        self.assertEqual(input_node.values, ["", phone])
        self.assertEqual(observed["realNameTailCharacter"], "测")
        self.assertEqual(
            [item["step"] for item in runner.log],
            ["clear_previous_query", "input_phone", "masked_real_name_tail_extracted"],
        )

    def test_lookup_poco_stable_no_name_result_returns_within_five_seconds_without_xml(self):
        phone = "18500006007"

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
        runner.poco_search_ready = lambda poco: input_node
        runner.parse_poco_result = lambda snapshot, target: None
        runner.poco_verification_evidence = lambda snapshot: None
        runner.poco_tap = mock.Mock()
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
        self.assertEqual(runner.poco_tap.call_count, 1)
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
        runner.poco_raise_if_access_denied = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        runner.poco_open_search = mock.Mock()
        poco = types.SimpleNamespace(freeze=lambda: object())
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_prepare_full_path(poco, "test")
        runner.poco_dismiss_known_overlay.assert_called_once()
        runner.poco_raise_if_access_denied.assert_called_once()
        runner.poco_open_search.assert_called_once_with(poco, "test")
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
        self.assertEqual(swipe[3:], ["130", "909", "590", "909", "1000"])
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
            ["shell", "input", "swipe", "120", "740", "600", "740", "1000"],
            runner.commands,
        )
        self.assertTrue(any(item["step"] == "human_verification_passed" for item in runner.log))

    def test_lookup_waits_for_delayed_input_readback_before_searching(self):
        phone = "13800138000"
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

    def test_lookup_access_denied_switches_once_and_retries_same_phone(self):
        phone = "13800138000"

        class AccessDeniedRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({
                    "serial": "LOCAL", "taskId": "access-denied-switch",
                    "operation": "query", "phoneNumber": phone,
                })
                inner_self.query_calls = []
                inner_self.switch_calls = 0

            def adb(inner_self, args, **kwargs):
                return "device" if args == ["get-state"] else "package:/alipay.apk"

            def switch_account(inner_self):
                inner_self.switch_calls += 1
                return "198******73"

            def query_once(inner_self, queried_phone, **kwargs):
                inner_self.query_calls.append(queried_phone)
                if len(inner_self.query_calls) == 1:
                    raise RuntimeError("alipay_access_denied_account_switch_required")
                return {
                    "alipayDisplayName": "测试用户(**测)",
                    "realNameTailCharacter": "测",
                    "matchedPhone": queried_phone,
                    "matchMethod": "test",
                }

        runner = AccessDeniedRunner()
        result = runner.run()
        self.assertEqual(runner.switch_calls, 1)
        self.assertEqual(runner.query_calls, [phone, phone])
        self.assertTrue(result["accountSwitched"])
        self.assertEqual(result["accountSwitchReason"], "access_denied")
        self.assertEqual(result["currentAccount"], "198******73")
        self.assertIn("account_switch_triggered", [item["step"] for item in runner.log])

    def test_lookup_does_not_ping_pong_when_second_account_is_also_denied(self):
        class BothDeniedRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({
                    "serial": "LOCAL", "taskId": "both-denied",
                    "operation": "query", "phoneNumber": "13800138000",
                    "forceAccountSwitchReason": "access_denied",
                })
                inner_self.switch_calls = 0

            def adb(inner_self, args, **kwargs):
                return "device" if args == ["get-state"] else "package:/alipay.apk"

            def switch_account(inner_self):
                inner_self.switch_calls += 1
                return "198******73"

            def query_once(inner_self, phone, **kwargs):
                raise RuntimeError("alipay_access_denied_account_switch_required")

        runner = BothDeniedRunner()
        with self.assertRaisesRegex(RuntimeError, "alipay_access_denied_after_account_switch"):
            runner.run()
        self.assertEqual(runner.switch_calls, 1)
        self.assertEqual(
            [item["step"] for item in runner.log].count("alipay_access_denied_after_account_switch"),
            1,
        )

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
            phone = "13800138000"
            root = ET.fromstring(f'''
            <hierarchy><node><node resource-id="{self.lookup.SEARCH_INPUT_ID}" text="{phone}"/>
              <node text="{phone}"/><node text="*测"/><node text="转账"/><node text="加好友"/>
            </node></hierarchy>
            ''')
            return root, {}
        runner.dump = fake_dump
        runner_deadline = [self.lookup.time.perf_counter() + 55]
        result = runner.query_once("13800138000", query_deadline=runner_deadline[0])
        self.assertEqual(result["realNameTailCharacter"], "测")
        self.assertGreater(observed["deadlineRemaining"], 50)


if __name__ == "__main__":
    unittest.main()
