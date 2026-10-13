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
    return args == ["shell", "input", "keyevent", *phone_keycodes(phone)]

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

    def test_worker_cleanup_is_bounded_to_owned_forward_and_poco_packages(self):
        packages = ("com.netease.open.pocoservice", "com.netease.open.pocoservice.test")
        for survivor in (None, *packages):
            with self.subTest(survivor=survivor):
                thread = mock.Mock()
                instrument = mock.Mock()
                instrument.poll.return_value = None
                poco = types.SimpleNamespace(_keep_running_thread=thread,
                    _instrument_proc=instrument, forward_list=["tcp:12345"])
                adb = mock.Mock(side_effect=lambda _path, _serial, args, **kwargs:
                    "123" if args == ["shell", "pidof", survivor] else "")
                with mock.patch.object(self.xhs, "run_adb", adb), mock.patch.object(self.xhs.time, "sleep"):
                    self.xhs.stop_stable_poco(poco, "fake-adb", "SYNTHETIC")
                expected = [mock.call("fake-adb", "SYNTHETIC", ["forward", "--remove", "tcp:12345"], timeout=1)]
                expected += [mock.call("fake-adb", "SYNTHETIC", ["shell", "am", "force-stop", pkg], timeout=5) for pkg in packages]
                for pkg in packages:
                    expected.append(mock.call("fake-adb", "SYNTHETIC", ["shell", "pidof", pkg], timeout=2))
                    if pkg == survivor:
                        expected.append(mock.call("fake-adb", "SYNTHETIC", ["shell", "am", "force-stop", pkg], timeout=3))
                self.assertEqual(adb.call_args_list, expected)
                self.assertEqual(poco.forward_list, [])
                thread.stop.assert_called_once_with()
                thread.join.assert_called_once_with(0)
                instrument.kill.assert_called_once_with()

    def test_lookup_jigsaw_is_returned_for_human_without_automatic_switch(self):
        phone = "13800138000"

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

    def instrument_fixture(self, states, exit_code=None):
        clock = [0.0]
        proc = mock.Mock(stdout=None, stderr=None)
        proc.poll.return_value = exit_code
        adb = mock.Mock(adb_path="adb", serialno="test-phone")
        adb.start_shell.return_value = proc
        poco = types.SimpleNamespace(adb_client=adb, device_ip="127.0.0.1", _instrument_proc=None)
        http = mock.Mock()
        values = iter(states)

        def get(*args, **kwargs):
            state = next(values, {"connected": False})
            if isinstance(state, Exception):
                raise state
            return types.SimpleNamespace(status_code=200, json=lambda: state)

        http.get.side_effect = get
        return clock, proc, poco, http

    def test_instrumentation_waits_without_launching_over_a_live_attempt(self):
        clock, proc, poco, http = self.instrument_fixture([ConnectionError("not yet"), {"connected": False}, [1080, 2412]])
        with mock.patch.object(self.xhs, "run_adb") as adb_run, mock.patch.object(self.xhs.time, "perf_counter", side_effect=lambda: clock[0]), mock.patch.object(self.xhs.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), mock.patch.object(self.xhs, "emit") as emit:
            self.assertTrue(self.xhs.start_poco_instrument_once(poco, 10080, http=http))
        poco.adb_client.start_shell.assert_called_once()
        adb_run.assert_called_once()
        proc.kill.assert_not_called()
        self.assertEqual(http.get.call_count, 3)
        self.assertEqual(emit.call_args.kwargs["instrumentationLaunches"], 1)
        self.assertEqual(emit.call_args.kwargs["probe"], "screen_size")
        self.assertIs(emit.call_args.kwargs["hierarchyVerified"], False)
        for call in http.get.call_args_list:
            self.assertEqual(call.args[0], "http://127.0.0.1:10080/screen_size")
            self.assertLessEqual(call.kwargs["timeout"], 0.5)

    def test_instrumentation_rejects_invalid_display_response(self):
        for value in ({"connected": True}, [], [1080], [1080, 2412, 1], [True, 2412], [1080, 0], [-1, 2412], ["1080", 2412], [1080.0, 2412]):
            with self.subTest(value=value):
                clock, proc, poco, http = self.instrument_fixture([value])
                with mock.patch.object(self.xhs, "run_adb"), mock.patch.object(self.xhs.time, "perf_counter", side_effect=lambda: clock[0]), mock.patch.object(self.xhs.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), mock.patch.object(self.xhs, "emit"):
                    with self.assertRaisesRegex(RuntimeError, "poco_service_invalid_screen_size"):
                        self.xhs.start_poco_instrument_once(poco, 10080, timeout_seconds=0.5, http=http)
                proc.kill.assert_called_once()

    def test_light_service_handshake_cannot_skip_worker_hrpc_probe(self):
        source = (SCRIPT_DIR / "xhs_airtest_poco.py").read_text(encoding="utf-8")
        worker = source.split("def run_worker(", 1)[1]
        self.assertLess(worker.index("verify_poco_transport_ready(poco)"), worker.index('"workerReady"'))

    def test_instrumentation_http_listener_alone_is_not_ready(self):
        clock, proc, poco, http = self.instrument_fixture([{}])
        with mock.patch.object(self.xhs, "run_adb"), mock.patch.object(self.xhs.time, "perf_counter", side_effect=lambda: clock[0]), mock.patch.object(self.xhs.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
            with self.assertRaisesRegex(RuntimeError, "instrumentation_handshake_failed:connection_deadline"):
                self.xhs.start_poco_instrument_once(poco, 10080, timeout_seconds=0.5, http=http)
        poco.adb_client.start_shell.assert_called_once()
        proc.kill.assert_called_once()
        proc.wait.assert_called_once_with(timeout=1)
        self.assertLessEqual(clock[0], 0.5)

    def test_instrumentation_failure_is_streamed_before_child_cleanup(self):
        clock, proc, poco, http = self.instrument_fixture([{}])
        events = []
        with mock.patch.object(self.xhs, "run_adb"), mock.patch.object(self.xhs.time, "perf_counter", side_effect=lambda: clock[0]), mock.patch.object(self.xhs.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), mock.patch.object(self.xhs, "emit", side_effect=lambda log, step, **detail: events.append((step, detail, proc.kill.call_count))):
            with self.assertRaisesRegex(RuntimeError, "connection_deadline"):
                self.xhs.start_poco_instrument_once(poco, 10080, timeout_seconds=0.5, http=http)
        failure = next(x for x in events if x[0] == "poco_instrumentation_handshake_failed")
        self.assertEqual(failure[2], 0)
        self.assertIn("http_status=200", failure[1]["reason"])
        self.assertEqual(failure[1]["instrumentationOutput"], {"stdout": "", "stderr": ""})

    def test_instrumentation_child_exit_is_immediate_not_retried(self):
        clock, proc, poco, http = self.instrument_fixture([], exit_code=1)
        with mock.patch.object(self.xhs, "run_adb"):
            with self.assertRaisesRegex(RuntimeError, "instrumentation_exited:code=1"):
                self.xhs.start_poco_instrument_once(poco, 10080, http=http)
        poco.adb_client.start_shell.assert_called_once()
        http.get.assert_not_called()
        proc.kill.assert_not_called()

    def test_managed_poco_never_installs_apk_or_kills_external_uiautomator(self):
        source = (SCRIPT_DIR / "xhs_airtest_poco.py").read_text(encoding="utf-8")
        managed = source.split("class ManagedAndroidPoco", 1)[1].split("    try:\n        poco =", 1)[0]
        self.assertIn('"pm", "path", "com.netease.open.pocoservice"', managed)
        self.assertNotIn("install(", managed)
        self.assertIn("external_instrumentation_owner", managed)

    def test_worker_ready_probe_accepts_a_completed_false_selector_response(self):
        class RespondingPoco:
            def __call__(self, **selector):
                self.selector = selector
                return FakeNode("missing", (0, 0), exists=False)

        poco = RespondingPoco()
        elapsed_ms = self.xhs.verify_poco_transport_ready(poco)
        self.assertEqual(poco.selector, {"type": "android.widget.FrameLayout"})
        self.assertGreaterEqual(elapsed_ms, 0)

    def test_worker_ready_probe_rejects_a_dead_hrpc_channel(self):
        class DeadPoco:
            def __call__(self, **selector):
                raise TimeoutError("hierarchy transport timed out")

        with self.assertRaisesRegex(
            RuntimeError, "poco_worker_transport_probe_failed:hierarchy transport timed out"
        ):
            self.xhs.verify_poco_transport_ready(DeadPoco())

    def test_account_navigation_leaves_exact_search_activity_before_finding_my_tab(self):
        runner = object.__new__(self.lookup.Runner)
        adb_calls = []
        events = []

        def adb(args, timeout=0, check=True, binary=False):
            adb_calls.append(list(args))
            return "Status: ok"

        search_focus = (
            [],
            "mCurrentFocus=Window{1 u0 com.eg.android.AlipayGphone/"
            "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}",
            "mFocusedApp=ActivityRecord{1 u0 com.eg.android.AlipayGphone/"
            "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}",
        )
        home_focus = (
            [],
            "mCurrentFocus=Window{2 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            "mFocusedApp=ActivityRecord{2 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        )
        focus_states = [search_focus, home_focus, home_focus]
        runner.adb = adb
        runner.emit = lambda step, **detail: events.append({"step": step, **detail})
        runner.dismiss_known_overlay = lambda *args, **kwargs: False
        runner.focus_state = lambda: focus_states.pop(0) if focus_states else home_focus

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.resume_alipay_home("account-list")

        self.assertIn(["shell", "input", "keyevent", "4"], adb_calls)
        self.assertNotIn(["shell", "am", "force-stop", self.lookup.ALIPAY_PACKAGE], adb_calls)
        self.assertTrue(any(
            event["step"] == "exit_search_for_account_navigation"
            and event["accountSelected"] is False
            for event in events
        ))

    def test_account_navigation_uses_exact_search_back_button_when_hardware_back_is_ignored(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "exact-search-back"})
        root = ET.fromstring(f'''
        <hierarchy><node>
          <node resource-id="{self.lookup.SEARCH_BACK_BUTTON_ID}"
                content-desc="返回" clickable="true" enabled="true"
                bounds="[0,72][96,168]"/>
        </node></hierarchy>
        ''')
        parent = {child: node for node in root.iter() for child in node}
        search_focus = (
            [],
            "mCurrentFocus=Window{1 u0 com.eg.android.AlipayGphone/"
            "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}",
            "mFocusedApp=ActivityRecord{1 u0 com.eg.android.AlipayGphone/"
            "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}",
        )
        home_focus = (
            [],
            "mCurrentFocus=Window{2 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            "mFocusedApp=ActivityRecord{2 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        )
        # The hardware Back exhausts its bounded poll without changing focus;
        # the exact page-owned control then exposes Home on the next poll.
        runner.focus_state = mock.Mock(side_effect=[search_focus, search_focus, home_focus])
        runner.dump = mock.Mock(return_value=(root, parent))
        runner.adb = mock.Mock(return_value="")

        with mock.patch.object(self.lookup.time, "sleep", return_value=None), mock.patch.object(
            self.lookup.time, "time", side_effect=[0.0, 2.1, 3.0, 3.1],
        ):
            current, _ = runner.exit_search_activity_for_account_navigation("account-list")

        self.assertIn(".AlipayLogin", current)
        self.assertEqual(runner.dump.call_args.kwargs["command_timeout"], 15)
        self.assertIn(
            mock.call(["shell", "input", "keyevent", "4"], timeout=5, check=False),
            runner.adb.call_args_list,
        )
        self.assertIn(
            mock.call(["shell", "input", "tap", "48", "120"], timeout=8),
            runner.adb.call_args_list,
        )
        self.assertIn(
            "exit_search_via_exact_back_button",
            [event["step"] for event in runner.log],
        )

    def test_account_search_back_rechecks_foreground_after_slow_hierarchy(self):
        runner = self.lookup.Runner({"serial":"LOCAL", "taskId":"back-focus-change"})
        search = ([], f"mCurrentFocus=Window{{1 u0 {self.lookup.ALIPAY_PACKAGE}/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}}", "")
        overlay = ([], "mCurrentFocus=Window{2 u0 com.coloros.securepay/.Warning}", "")
        root = ET.fromstring(f'<hierarchy><node resource-id="{self.lookup.SEARCH_BACK_BUTTON_ID}" content-desc="返回" clickable="true" bounds="[0,72][96,168]"/></hierarchy>')
        runner.dump = mock.Mock(return_value=(root, {}))
        runner.adb = mock.Mock(return_value="")
        runner.focus_state = mock.Mock(side_effect=[search, overlay])
        with mock.patch.object(self.lookup.time,"time",side_effect=[0.0,2.1]):
            current, _ = runner.exit_search_activity_for_account_navigation("account-list")
        self.assertIn("securepay",current)
        self.assertFalse(any("tap" in call.args[0] for call in runner.adb.call_args_list))

    def test_restriction_recovery_separates_webview_back_from_search_activity_back(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "restriction-home"})
        search = ET.fromstring('''
        <hierarchy><node>
          <node resource-id="com.alipay.mobile.antui:id/search_input_box"
                text="" bounds="[100,40][650,130]"/>
        </node></hierarchy>
        ''')
        home = ET.fromstring(f'''
        <hierarchy><node>
          <node resource-id="{self.lookup.TAB_DESCRIPTION_ID}" text="我的"
                clickable="true" bounds="[576,1496][720,1604]"/>
        </node></hierarchy>
        ''')
        dumps = iter([search, home])
        adb_calls = []

        def dump(token, **kwargs):
            root = next(dumps)
            return root, {child: node for node in root.iter() for child in node}

        def adb(args, **kwargs):
            adb_calls.append(list(args))
            return ""

        search_focus = (
            [],
            "mCurrentFocus=Window{1 u0 com.eg.android.AlipayGphone/"
            "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}",
            "mFocusedApp=ActivityRecord{1 u0 com.eg.android.AlipayGphone/"
            "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}",
        )
        home_focus = (
            [],
            "mCurrentFocus=Window{2 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            "mFocusedApp=ActivityRecord{2 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        )
        focus_states = [search_focus, home_focus, home_focus]
        runner.dump = dump
        runner.adb = adb
        runner.focus_state = lambda: focus_states.pop(0) if focus_states else home_focus

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            root, _ = runner.return_to_home_for_account_switch(
                {"reason": "jigsaw_verification"}, "list",
            )

        self.assertEqual(
            len(runner.find(root, text="我的", resource_id=self.lookup.TAB_DESCRIPTION_ID)),
            1,
        )
        self.assertEqual(
            adb_calls.count(["shell", "input", "keyevent", "4"]), 2,
        )
        steps = [item["step"] for item in runner.log]
        self.assertIn("account_restriction_surface_cleared", steps)
        self.assertIn("exit_search_for_account_navigation", steps)
        self.assertEqual(steps[-1], "account_restriction_dismissed_for_switch")

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

    def test_lookup_xml_returns_unverified_account_as_terminal_not_found(self):
        phone = "19375183430"
        root = ET.fromstring(f"""
        <hierarchy><node>
          <node text="193******30(未实名)" bounds="[20,100][300,150]"/>
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
        self.assertIsNone(runner.parse_result(root, {}, "19300000031"))

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

    def test_lookup_poco_returns_unverified_account_as_terminal_not_found(self):
        phone = "19375183430"

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
            Node("193******30(未实名)", (0.4, 0.30)),
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

    def test_lookup_poco_query_clears_and_sets_phone_once(self):
        phone = "13800138000"

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
        runner.poco_dismiss_post_input_usb_warning = mock.Mock(return_value=False)
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
        self.assertEqual(input_calls[0][3:], phone_keycodes(phone))
        self.assertEqual(
            [item["step"] for item in runner.log],
            [
                "clear_previous_query", "poco_input_clear_confirmed",
                "input_phone", "masked_real_name_tail_extracted",
            ],
        )

    def test_lookup_poco_slider_resume_never_retypes_phone(self):
        phone = "13800138000"

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
        runner.poco_dismiss_post_input_usb_warning = mock.Mock(return_value=False)
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
        phone = "13800138000"

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
        runner.poco_dismiss_post_input_usb_warning = mock.Mock(return_value=False)
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

    def test_lookup_poco_input_timeout_resumes_without_retyping_phone(self):
        phone = "13800138000"

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
        runner.poco_dismiss_post_input_usb_warning = mock.Mock(return_value=False)
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
        phone = "13800138000"

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

    def test_poco_http_transport_substitutes_a_bound_for_synchronous_rpc(self):
        source = (SCRIPT_DIR / "xhs_airtest_poco.py").read_text(encoding="utf-8")
        self.assertIn("def bounded_transport_send(request, timeout=None)", source)
        self.assertIn("timeout_seconds if timeout is None else timeout", source)
        self.assertIn("transport.send = bounded_transport_send", source)

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
        runner.poco_dismiss_post_input_usb_warning = mock.Mock(return_value=False)
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
        runner.focus = mock.Mock(return_value=[])
        search = FakeNode("search", (0.5, 0.2))
        input_node = FakeNode("input", (0.5, 0.1))
        runner.poco_dismiss_known_overlay = mock.Mock(return_value=False)
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=True)
        runner.dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.poco_home_search_target = mock.Mock(side_effect=[
            RuntimeError("poco_selector_missing:{'desc': '搜索框'}; count=0"),
            search,
        ])
        runner.poco_unique = mock.Mock(return_value=input_node)
        runner.poco_tap = mock.Mock()
        poco = object()
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_open_search(poco, "unit")
        runner.poco_dismiss_coloros_securepay_usb_dialog.assert_called_once_with(poco)
        runner.dismiss_coloros_securepay_usb_dialog.assert_not_called()
        self.assertEqual(runner.poco_home_search_target.call_args_list[0].kwargs["timeout"], 3.0)
        self.assertEqual(runner.poco_home_search_target.call_args_list[1].kwargs["timeout"], 5.0)
        runner.poco_tap.assert_called_once_with(search)

    def test_lookup_poco_normal_search_path_does_not_probe_securepay_xml(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "securepay-poco-normal"})
        runner.focus = mock.Mock(return_value=[])
        search = FakeNode("search", (0.5, 0.2))
        input_node = FakeNode("input", (0.5, 0.1))
        runner.poco_dismiss_known_overlay = mock.Mock(return_value=False)
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.poco_home_search_target = mock.Mock(return_value=search)
        runner.poco_unique = mock.Mock(return_value=input_node)
        runner.poco_tap = mock.Mock()
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_open_search(object(), "unit")
        runner.poco_dismiss_known_overlay.assert_not_called()
        runner.dismiss_coloros_securepay_usb_dialog.assert_not_called()
        runner.poco_dismiss_coloros_securepay_usb_dialog.assert_not_called()
        runner.poco_tap.assert_called_once_with(search)

    def test_lookup_poco_start_normalizes_home_once_when_tapped_search_does_not_open(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "stale-home-search", "operation": "start",
        })
        runner.focus = mock.Mock(return_value=[])
        first_search = FakeNode("first-search", (0.5, 0.2))
        fresh_search = FakeNode("fresh-search", (0.5, 0.2))
        search_input = FakeNode("input", (0.5, 0.1))
        runner.poco_home_search_target = mock.Mock(side_effect=[first_search, fresh_search])
        runner.poco_unique = mock.Mock(side_effect=[
            RuntimeError("poco_selector_missing:{'name': 'search_input'}; count=0"),
            search_input,
        ])
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.poco_dismiss_alipay_home_overlay_snapshot = mock.Mock(return_value=False)
        runner.poco_raise_if_login_required = mock.Mock(return_value=None)
        runner.poco_raise_if_account_restricted = mock.Mock(return_value=None)
        runner.poco_resume_alipay_home = mock.Mock(return_value=True)
        runner.focus_state = mock.Mock(return_value=(
            [],
            "mCurrentFocus=Window{123 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            "mFocusedApp=ActivityRecord{123 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ))
        runner.poco_tap = mock.Mock()
        snapshot = object()
        poco = mock.Mock()
        poco.freeze.return_value = snapshot

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_open_search(poco, "session-start")

        self.assertEqual(
            runner.poco_tap.call_args_list,
            [mock.call(first_search), mock.call(fresh_search)],
        )
        runner.poco_resume_alipay_home.assert_called_once_with(
            poco, "session-start-search-input-missing",
        )
        self.assertEqual(
            [item["step"] for item in runner.log].count(
                "retry_search_after_home_normalization"
            ),
            1,
        )

    def test_lookup_poco_start_preserves_restriction_after_search_tap_without_home_retry(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "late-restriction-after-tap", "operation": "start",
        })
        runner.focus = mock.Mock(return_value=[])
        runner.poco_home_search_target = mock.Mock(
            return_value=FakeNode("search", (0.5, 0.2))
        )
        runner.poco_unique = mock.Mock(side_effect=RuntimeError(
            "poco_selector_missing:{'name': 'search_input'}; count=0"
        ))
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.poco_raise_if_login_required = mock.Mock(return_value=None)
        runner.poco_raise_if_account_restricted = mock.Mock(side_effect=RuntimeError(
            "alipay_account_restriction_before_search:jigsaw_verification"
        ))
        runner.poco_resume_alipay_home = mock.Mock(side_effect=AssertionError(
            "an evidenced restriction must stay visible"
        ))
        runner.poco_tap = mock.Mock()
        runner.focus_state = mock.Mock(return_value=(
            [],
            "mCurrentFocus=Window{123 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            "",
        ))
        poco = mock.Mock()
        poco.freeze.return_value = object()

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            with self.assertRaisesRegex(
                RuntimeError, "alipay_account_restriction_before_search:jigsaw_verification",
            ):
                runner.poco_open_search(poco, "session-start")

        runner.poco_resume_alipay_home.assert_not_called()

    def test_lookup_poco_start_accepts_exact_focused_search_when_current_focus_is_null(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "null-current-search", "operation": "start",
        })
        runner.focus = mock.Mock(return_value=[])
        search = FakeNode("search", (0.5, 0.2))
        runner.poco_home_search_target = mock.Mock(return_value=search)
        runner.poco_tap = mock.Mock()
        runner.focus_state = mock.Mock(return_value=(
            [
                "mCurrentFocus=null",
                "mFocusedApp=ActivityRecord{abc u0 com.eg.android.AlipayGphone/"
                "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}",
            ],
            "mCurrentFocus=null",
            "mFocusedApp=ActivityRecord{abc u0 com.eg.android.AlipayGphone/"
            "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}",
        ))
        runner.poco_unique = mock.Mock(side_effect=AssertionError(
            "start must defer the hierarchy probe after exact activity evidence",
        ))

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_open_search(object(), "session-start")

        runner.poco_tap.assert_called_once_with(search)
        runner.poco_unique.assert_not_called()
        self.assertEqual(runner.log[-1]["step"], "open_search_ready_by_exact_activity")
        self.assertTrue(runner.log[-1]["pocoHierarchyDeferred"])

    def test_lookup_poco_query_does_not_defer_input_probe_on_exact_activity(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "query-validates-input", "operation": "query",
        })
        runner.focus = mock.Mock(return_value=[])
        search = FakeNode("search", (0.5, 0.2))
        search_input = FakeNode("input", (0.5, 0.1))
        runner.poco_home_search_target = mock.Mock(return_value=search)
        runner.poco_tap = mock.Mock()
        runner.focus_state = mock.Mock(side_effect=AssertionError(
            "query must keep using the Poco input probe",
        ))
        runner.poco_unique = mock.Mock(return_value=search_input)

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_open_search(object(), "query")

        runner.poco_unique.assert_called_once_with(
            mock.ANY, timeout=5.0, name=self.lookup.SEARCH_INPUT_ID,
        )

    def test_lookup_exact_focused_search_rejects_concrete_overlay(self):
        focused = (
            "mFocusedApp=ActivityRecord{abc u0 com.eg.android.AlipayGphone/"
            "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}"
        )
        self.assertTrue(self.lookup.Runner.exact_search_activity_visible(
            "mCurrentFocus=null", focused,
        ))
        self.assertFalse(self.lookup.Runner.exact_search_activity_visible(
            "mCurrentFocus=Window{def u0 com.coloros.securepay/.SecurePayActivity}", focused,
        ))

    def test_lookup_poco_home_search_closes_fullscreen_ad_before_background_search(self):
        search = FakeNode("search", (0.5, 0.08))
        close = FakeNode("close", (0.5, 0.78))
        unrelated_close = FakeNode("close", (0.91, 0.87))

        class Snapshot:
            def __init__(inner_self, covered):
                inner_self.covered = covered

            def __call__(inner_self, **selector):
                if selector.get("desc") == "全屏广告":
                    return [object()] if inner_self.covered else []
                if selector.get("desc") == "关闭":
                    return [close, unrelated_close] if inner_self.covered else []
                if selector.get("desc") == "搜索框":
                    return [search]
                return []

        poco = mock.Mock()
        poco.freeze.side_effect = [Snapshot(True), Snapshot(False)]
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "covered-search"})
        runner.poco_tap = mock.Mock()

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            target = runner.poco_home_search_target(poco)

        self.assertIs(target, search)
        runner.poco_tap.assert_called_once_with(close)
        self.assertEqual(runner.log[-1]["step"], "dismiss_alipay_fullscreen_ad")
        self.assertFalse(runner.log[-1]["promotedActionTapped"])

    def test_lookup_poco_home_search_uses_unique_live_target_before_full_hierarchy(self):
        class UniqueLiveSearch(FakeNode):
            def __len__(inner_self):
                return 1

        search = UniqueLiveSearch("search", (0.56, 0.08))

        class LivePoco:
            def __call__(inner_self, **selector):
                if selector == {"desc": "搜索框"}:
                    return search
                if selector == {"desc": "全屏广告"}:
                    return []
                self.assertIn(selector.get("text"), [self.lookup.ALIPAY_REAL_NAME_PROMPT_TITLE, self.lookup.ALIPAY_REAL_NAME_PROMPT_TITLE_188])
                return []

            def freeze(inner_self):
                raise AssertionError("normal home must not request the full hierarchy")

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "live-home-search"})

        target = runner.poco_home_search_target(LivePoco())

        self.assertIs(target, search)
        self.assertEqual(runner.log[-1]["step"], "poco_home_search_live_target")
        self.assertTrue(runner.log[-1]["fullHierarchyDeferred"])

    def test_lookup_188_prompt_closes_by_live_elements_and_reacquires_search(self):
        close = FakeNode("close", (0.5, 0.78))
        stale_search, fresh_search = [FakeNode("search", (0.5, 0.08)) for _ in range(2)]
        covered = [True]

        class LivePoco:
            def __call__(inner_self, **selector):
                if selector.get("desc") == "搜索框":
                    return [stale_search if covered[0] else fresh_search]
                if not covered[0]:
                    return []
                if selector.get("text") in (self.lookup.ALIPAY_REAL_NAME_PROMPT_TITLE_188, self.lookup.ALIPAY_REAL_NAME_PROMPT_ACTION):
                    return [object()]
                if selector.get("desc") == "关闭":
                    return [close]
                return []

            def freeze(inner_self):
                raise AssertionError("188 prompt must not serialize the full Home")

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "188-live-prompt"})
        runner.focus_state = mock.Mock(return_value=([], "com.eg.android.AlipayGphone/.AlipayLogin", ""))
        runner.poco_tap = mock.Mock(side_effect=lambda node: covered.__setitem__(0, False))
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            target = runner.poco_live_home_search_target(LivePoco())
        self.assertEqual(target, [fresh_search])
        runner.poco_tap.assert_called_once_with(close)
        dismissal = next(x for x in runner.log if x["step"] == "dismiss_alipay_real_name_prompt")
        self.assertFalse(dismissal["authenticationStarted"])
        self.assertFalse(dismissal["fullHierarchyRequested"])

    def test_lookup_live_image_ad_closes_without_title_or_full_hierarchy(self):
        close = FakeNode("close", (0.5, 0.78))
        search = FakeNode("search", (0.5, 0.08))
        covered = [True]
        class LivePoco:
            def __call__(inner_self, **selector):
                if selector == {"desc": "搜索框"}:
                    return [search]
                if selector == {"desc": "全屏广告"}:
                    return [object()] if covered[0] else []
                if selector == {"desc": "关闭"}:
                    return [close] if covered[0] else []
                return []
            def freeze(inner_self):
                raise AssertionError("do not dump the heavy Home")
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "188-image-prompt"})
        runner.focus_state = mock.Mock(return_value=([], "com.eg.android.AlipayGphone/.AlipayLogin", ""))
        runner.poco_tap = mock.Mock(side_effect=lambda node: covered.__setitem__(0, False))
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            self.assertEqual(runner.poco_live_home_search_target(LivePoco()), [search])
        runner.poco_tap.assert_called_once_with(close)
        event = next(x for x in runner.log if x["step"] == "dismiss_alipay_fullscreen_ad")
        self.assertFalse(event["promotedActionTapped"])
        self.assertFalse(event["authenticationStarted"])

    def test_lookup_live_image_ad_never_uses_an_unproven_close(self):
        close = FakeNode("close", (0.5, 0.78))
        for ad_count, closes, foreground in ((0, [close], "com.eg.android.AlipayGphone"), (2, [close], "com.eg.android.AlipayGphone"), (1, [], "com.eg.android.AlipayGphone"), (1, [close, close], "com.eg.android.AlipayGphone"), (1, [close], "com.android.systemui")):
            with self.subTest(ad_count=ad_count, closes=len(closes), foreground=foreground):
                def poco(**selector):
                    if selector == {"desc": "全屏广告"}:
                        return [object()] * ad_count
                    return closes if selector == {"desc": "关闭"} else []
                runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "live-ad-guard"})
                runner.poco_tap = mock.Mock()
                runner.focus_state = mock.Mock(return_value=([], foreground, ""))
                if not ad_count:
                    self.assertFalse(runner.poco_dismiss_fullscreen_ad_live(poco))
                else:
                    with self.assertRaisesRegex(RuntimeError, "poco_fullscreen_ad_(close_unavailable|foreground_changed)"):
                        runner.poco_dismiss_fullscreen_ad_live(poco)
                runner.poco_tap.assert_not_called()

    def test_lookup_live_real_name_prompt_never_taps_an_ambiguous_or_unverified_close(self):
        close = FakeNode("close", (0.5, 0.78))
        for actions, closes, foreground in (([], [close], "com.eg.android.AlipayGphone"), ([object()], [], "com.eg.android.AlipayGphone"), ([object()], [close, close], "com.eg.android.AlipayGphone"), ([object()], [close], "com.android.systemui")):
            with self.subTest(actionCount=len(actions), closeCount=len(closes), foreground=foreground):
                def poco(**selector):
                    if selector.get("text") == self.lookup.ALIPAY_REAL_NAME_PROMPT_TITLE_188:
                        return [object()]
                    if selector.get("text") == self.lookup.ALIPAY_REAL_NAME_PROMPT_ACTION:
                        return actions
                    return closes if selector.get("desc") == "关闭" else []
                runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "188-prompt-guard"})
                runner.poco_tap = mock.Mock()
                runner.focus_state = mock.Mock(return_value=([], foreground, ""))
                with self.assertRaisesRegex(RuntimeError, "poco_real_name_prompt_(close_unavailable|foreground_changed)"):
                    runner.poco_dismiss_real_name_prompt_live(poco)
                runner.poco_tap.assert_not_called()

    def test_lookup_live_real_name_prompt_observes_only_after_one_close(self):
        close = FakeNode("close", (0.5, 0.78))
        def poco(**selector):
            if selector.get("text") in (self.lookup.ALIPAY_REAL_NAME_PROMPT_TITLE_188, self.lookup.ALIPAY_REAL_NAME_PROMPT_ACTION):
                return [object()]
            return [close] if selector.get("desc") == "关闭" else []
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "188-prompt-persistent"})
        runner.poco_tap = mock.Mock()
        runner.focus_state = mock.Mock(return_value=([], "com.eg.android.AlipayGphone", ""))
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "poco_real_name_prompt_not_dismissed"):
                runner.poco_dismiss_real_name_prompt_live(poco)
        runner.poco_tap.assert_called_once_with(close)

    def test_lookup_poco_home_search_closes_exact_real_name_prompt_without_authentication(self):
        search = FakeNode("search", (0.5, 0.08))
        close = FakeNode("close", (0.5, 0.78))
        unrelated_close = FakeNode("close", (0.91, 0.87))

        class Snapshot:
            def __init__(inner_self, covered):
                inner_self.covered = covered

            def __call__(inner_self, **selector):
                if selector.get("text") == self.lookup.ALIPAY_REAL_NAME_PROMPT_TITLE:
                    return [object()] if inner_self.covered else []
                if selector.get("text") == self.lookup.ALIPAY_REAL_NAME_PROMPT_ACTION:
                    return [object()] if inner_self.covered else []
                if selector.get("desc") == "关闭":
                    return [close, unrelated_close] if inner_self.covered else []
                if selector.get("desc") == "搜索框":
                    return [search]
                return []

        poco = mock.Mock()
        poco.freeze.side_effect = [Snapshot(True), Snapshot(False)]
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "real-name-prompt"})
        runner.poco_tap = mock.Mock()

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            target = runner.poco_home_search_target(poco)

        self.assertIs(target, search)
        runner.poco_tap.assert_called_once_with(close)
        self.assertEqual(runner.log[-1]["step"], "dismiss_alipay_real_name_prompt")
        self.assertFalse(runner.log[-1]["authenticationStarted"])

    def test_lookup_poco_open_search_rechecks_a_late_restriction_after_full_target_budget(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "late-restriction"})
        runner.focus = mock.Mock(return_value=[])
        missing = RuntimeError("poco_selector_missing:{'desc': '搜索框'}; count=0")
        runner.poco_home_search_target = mock.Mock(side_effect=[missing, missing])
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.poco_dismiss_known_overlay = mock.Mock(return_value=False)
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

        self.assertEqual(runner.poco_home_search_target.call_count, 2)
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

    def test_lookup_dismisses_exact_honor_software_update_without_installing(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "honor-update"})
        runner.focus = mock.Mock(side_effect=[
            [
                "mCurrentFocus=Window{abc u0 com.hihonor.ouc/.MainActivity}",
                "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            ],
            ["mCurrentFocus=Window{def u0 com.eg.android.AlipayGphone/.AlipayLogin}"],
        ])
        runner.adb = mock.Mock(return_value="")

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            dismissed = runner.dismiss_honor_software_update_overlay()

        self.assertTrue(dismissed)
        runner.adb.assert_called_once_with(
            ["shell", "input", "keyevent", "4"], timeout=5, check=False,
        )
        self.assertEqual(runner.log[-1]["step"], "dismiss_honor_software_update_overlay")
        self.assertEqual(runner.log[-1]["selector"]["package"], "com.hihonor.ouc")
        self.assertEqual(runner.log[-1]["method"], "back")
        self.assertFalse(runner.log[-1]["installStarted"])

    def test_lookup_poco_defers_only_the_exact_honor_software_update_dialog(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "honor-update-poco"})
        overlay = [
            "mCurrentFocus=Window{abc u0 com.hihonor.ouc/.MainActivity}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ]
        runner.focus = mock.Mock(side_effect=[overlay, [
            "mCurrentFocus=Window{ghi u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ]])
        title = mock.Mock()
        message = mock.Mock()
        install = mock.Mock()
        details = mock.Mock()
        later = mock.Mock()
        later.get_position.return_value = (0.5, 0.94)
        selector_nodes = {
            "软件更新": [title],
            "下载并安装": [install],
            "详细信息": [details],
            "稍后": [later],
        }
        runner.poco_nodes = mock.Mock(
            side_effect=lambda snapshot, **selector: selector_nodes.get(selector.get("text"), [])
        )
        runner.poco_snapshot_texts = mock.Mock(return_value=[
            "软件更新",
            "包含重要系统优化，建议您立即升级体验。下载该更新需要 669 MB 流量。",
            "下载并安装",
            "详细信息",
            "稍后",
        ])
        runner.display_size = mock.Mock(return_value=(720, 1604))
        runner.adb = mock.Mock(return_value="")
        poco = mock.Mock()
        poco.freeze.return_value = object()

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            dismissed = runner.poco_dismiss_honor_software_update_dialog(poco)

        self.assertTrue(dismissed)
        runner.adb.assert_called_once_with(
            ["shell", "input", "tap", "360", "1508"], timeout=5,
        )
        self.assertEqual(runner.log[-1]["step"], "dismiss_honor_software_update_overlay")
        self.assertEqual(runner.log[-1]["method"], "later")
        self.assertFalse(runner.log[-1]["installStarted"])
        self.assertEqual(runner.log[-1]["selector"]["text"], "稍后")

    def test_lookup_poco_accepts_exact_honor_update_size_in_gb(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "honor-update-gb"})
        overlay = [
            "mCurrentFocus=Window{abc u0 com.hihonor.ouc/.MainActivity}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ]
        runner.focus = mock.Mock(side_effect=[overlay, [
            "mCurrentFocus=Window{ghi u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ]])
        title, install, details, later = mock.Mock(), mock.Mock(), mock.Mock(), mock.Mock()
        later.get_position.return_value = (0.5, 0.94)
        selector_nodes = {
            "软件更新": [title],
            "下载并安装": [install],
            "详细信息": [details],
            "稍后": [later],
        }
        runner.poco_nodes = mock.Mock(
            side_effect=lambda snapshot, **selector: selector_nodes.get(selector.get("text"), [])
        )
        runner.poco_snapshot_texts = mock.Mock(return_value=[
            "软件更新",
            "包含重要系统优化，建议您立即升级体验。下载该更新需要 6.30 GB 流量。",
            "下载并安装",
            "详细信息",
            "稍后",
        ])
        runner.display_size = mock.Mock(return_value=(1080, 2412))
        runner.adb = mock.Mock(return_value="")
        poco = mock.Mock()
        poco.freeze.return_value = object()

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            dismissed = runner.poco_dismiss_honor_software_update_dialog(poco)

        self.assertTrue(dismissed)
        runner.adb.assert_called_once_with(
            ["shell", "input", "tap", "540", "2267"], timeout=5,
        )
        self.assertEqual(runner.log[-1]["step"], "dismiss_honor_software_update_overlay")
        self.assertFalse(runner.log[-1]["installStarted"])

    def test_lookup_restarts_alipay_once_then_requires_fresh_poco_after_honor_update(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "honor-fresh-poco", "operation": "start",
        })
        runner.adb = mock.Mock(side_effect=["", "Status: ok"])

        with self.assertRaisesRegex(
            RuntimeError,
            "poco_rpc_failed:honor_update_dismissed_alipay_restarted_worker_reattach_required",
        ):
            runner.restart_alipay_for_fresh_poco_after_honor_update()

        commands = [call.args[0] for call in runner.adb.call_args_list]
        self.assertEqual(commands[0], [
            "shell", "am", "force-stop", self.lookup.ALIPAY_PACKAGE,
        ])
        self.assertEqual(commands[1], [
            "shell", "am", "start", "-W", "-f", "0x10008000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER",
            "-n", self.lookup.ALIPAY_HOME,
        ])
        self.assertEqual(
            runner.log[-1]["step"],
            "restart_alipay_after_honor_update_for_fresh_poco",
        )
        self.assertFalse(runner.log[-1]["updateInstallStarted"])
        self.assertFalse(runner.log[-1]["phoneQueryStarted"])
        self.assertTrue(runner.log[-1]["workerReattachRequired"])

    def test_lookup_start_hands_exact_honor_update_to_fresh_poco_recovery(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "honor-reuse-recovery", "operation": "start",
        })
        overlay = (
            "mCurrentFocus=Window{abc u0 com.hihonor.ouc/.MainActivity}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        )
        runner.focus_state = mock.Mock(return_value=(list(overlay), *overlay))
        runner.poco_dismiss_honor_software_update_dialog = mock.Mock(return_value=True)
        runner.restart_alipay_for_fresh_poco_after_honor_update = mock.Mock(
            side_effect=RuntimeError("poco_rpc_failed:fresh_worker_required"),
        )
        runner.dismiss_honor_software_update_overlay = mock.Mock()

        with self.assertRaisesRegex(RuntimeError, "poco_rpc_failed:fresh_worker_required"):
            runner.poco_try_reuse_search_page(object())

        runner.restart_alipay_for_fresh_poco_after_honor_update.assert_called_once_with()
        runner.dismiss_honor_software_update_overlay.assert_not_called()

    def test_lookup_resumes_alipay_when_honor_update_ignores_back(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "honor-update-stuck"})
        covered = [
            "mCurrentFocus=Window{abc u0 com.hihonor.ouc/.MainActivity}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ]
        runner.focus = mock.Mock(side_effect=[covered] * 10 + [[
            "mCurrentFocus=Window{ghi u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ]])
        runner.adb = mock.Mock(return_value="Status: ok")

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            dismissed = runner.dismiss_honor_software_update_overlay()

        self.assertTrue(dismissed)
        commands = [call.args[0] for call in runner.adb.call_args_list]
        self.assertEqual(commands[0], ["shell", "input", "keyevent", "4"])
        self.assertIn(["shell", "am", "start", "-W", "-f", "0x10200000",
                       "-a", "android.intent.action.MAIN", "-c",
                       "android.intent.category.LAUNCHER", "-n", self.lookup.ALIPAY_HOME], commands)
        self.assertFalse(any(command[:3] == ["shell", "am", "force-stop"] for command in commands))
        self.assertEqual(runner.log[-1]["step"], "resume_alipay_over_honor_software_update_overlay")
        self.assertEqual(runner.log[-1]["method"], "resume_existing_alipay_task")
        self.assertFalse(runner.log[-1]["installStarted"])
        self.assertFalse(runner.log[-1]["forceStopped"])

    def test_lookup_does_not_touch_non_honor_foreground_for_update_recovery(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "not-honor-update"})
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=Window{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ])
        runner.adb = mock.Mock(return_value="")

        self.assertFalse(runner.dismiss_honor_software_update_overlay())
        runner.adb.assert_not_called()

    def test_lookup_does_not_dismiss_standalone_honor_updater(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "honor-update-standalone"})
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=Window{abc u0 com.hihonor.ouc/.MainActivity}",
            "mFocusedApp=ActivityRecord{abc u0 com.hihonor.ouc/.MainActivity}",
        ])
        runner.adb = mock.Mock(return_value="")

        self.assertFalse(runner.dismiss_honor_software_update_overlay())
        runner.adb.assert_not_called()

    def vivo_usb_fixture(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "vivo-usb", "operation": "start"})
        covered = ["mCurrentFocus=null", "mFocusedApp=null",
                   "mCurrentFocus=Window{android:2c61777 u0 VivoUsbDialog type=2003}",
                   "mFocusedApp=ActivityRecord{abc u0 com.eg.android.AlipayGphone/com.ali.user.mobile.loginupgrade.activity.LoginActivity}"]
        login = ["mCurrentFocus=Window{abc u0 com.eg.android.AlipayGphone/com.ali.user.mobile.loginupgrade.activity.LoginActivity}"]
        runner.focus = mock.Mock(side_effect=[covered, covered, login])
        runner.adb = mock.Mock(return_value="mtp,adb\n")
        return runner, covered, login

    def test_vivo_usb_cancel_uses_one_back_and_preserves_mode(self):
        runner, _, _ = self.vivo_usb_fixture()
        self.assertTrue(runner.dismiss_vivo_usb_mode_dialog())
        self.assertEqual([c.args[0] for c in runner.adb.call_args_list], [
            ["shell", "getprop", "sys.usb.config"], ["shell", "input", "keyevent", "4"],
            ["shell", "getprop", "sys.usb.config"],
        ])
        self.assertFalse(runner.log[-1]["usbModeChanged"])
        self.assertFalse(runner.log[-1]["modeSelectionTapped"])

    def test_vivo_usb_rejects_unrelated_window_or_underlying_app(self):
        for focus in [
            ["mCurrentFocus=Window{abc u0 NotVivoUsbDialog type=2003}", "mFocusedApp=com.eg.android.AlipayGphone/.Home"],
            ["mCurrentFocus=Window{abc u0 VivoUsbDialogExtra type=2003}", "mFocusedApp=com.eg.android.AlipayGphone/.Home"],
            ["mCurrentFocus=Window{abc u0 VivoUsbDialog type=2003}", "mFocusedApp=ActivityRecord{abc u0 com.other/.Home}"],
            ["mCurrentFocus=null", "mFocusedApp=com.eg.android.AlipayGphone/.Home"],
        ]:
            with self.subTest(focus=focus):
                runner, _, _ = self.vivo_usb_fixture()
                runner.focus = mock.Mock(return_value=focus)
                self.assertFalse(runner.dismiss_vivo_usb_mode_dialog())
                runner.adb.assert_not_called()

    def test_vivo_usb_missing_mode_does_not_press_back(self):
        runner, _, _ = self.vivo_usb_fixture()
        runner.adb.return_value = ""
        with self.assertRaisesRegex(RuntimeError, "poco_vivo_usb_mode_dialog:usb_mode_unavailable"):
            runner.dismiss_vivo_usb_mode_dialog()
        self.assertEqual(runner.adb.call_count, 1)

    def test_vivo_usb_foreground_race_does_not_press_back(self):
        runner, covered, login = self.vivo_usb_fixture()
        runner.focus = mock.Mock(side_effect=[covered, login])
        with self.assertRaisesRegex(RuntimeError, "foreground_changed"):
            runner.dismiss_vivo_usb_mode_dialog()
        self.assertEqual(runner.adb.call_count, 1)

    def test_vivo_usb_persistent_dialog_never_repeats_back(self):
        runner, covered, _ = self.vivo_usb_fixture()
        runner.focus = mock.Mock(return_value=covered)
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "cancel_not_confirmed"):
                runner.dismiss_vivo_usb_mode_dialog()
        self.assertEqual(runner.adb.call_count, 2)

    def test_vivo_usb_mode_change_fails_without_setting_usb(self):
        runner, _, _ = self.vivo_usb_fixture()
        runner.adb.side_effect = ["mtp,adb", "", "adb"]
        with self.assertRaisesRegex(RuntimeError, "usb_mode_changed_after_cancel"):
            runner.dismiss_vivo_usb_mode_dialog()
        self.assertEqual(runner.adb.call_count, 3)

    def test_vivo_usb_reuse_classifies_login_after_cancel_without_poco(self):
        runner, covered, login = self.vivo_usb_fixture()
        runner.focus = mock.Mock(side_effect=[covered, covered, covered, login, login])
        poco = mock.Mock(side_effect=AssertionError("login classification must precede hierarchy"))
        with self.assertRaisesRegex(RuntimeError, "poco_alipay_login_required"):
            runner.poco_try_reuse_search_page(poco)
        poco.assert_not_called()

    def test_vivo_usb_start_error_never_relaunches(self):
        runner, _, _ = self.vivo_usb_fixture()
        runner.adb = mock.Mock(side_effect=lambda args, **kwargs: (
            "device" if args == ["get-state"] else "package:/data/app/alipay/base.apk"
        ))
        runner.keep_awake_usb_best_effort = mock.Mock()
        runner.poco_try_reuse_search_page = mock.Mock(side_effect=RuntimeError("poco_vivo_usb_mode_dialog:cancel_not_confirmed"))
        runner.poco_prepare_full_path = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "poco_vivo_usb_mode_dialog"):
            runner.run_poco(object())
        runner.poco_prepare_full_path.assert_not_called()

    def test_lookup_dismisses_vivo_wlan_warning_only_when_it_covers_alipay(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "vivo-wlan-risk"})
        runner.focus = mock.Mock(side_effect=[
            [
                "mCurrentFocus=Window{abc u0 com.vivo.safecenter/.WlanRiskActivity}",
                "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            ],
            ["mCurrentFocus=Window{ghi u0 com.eg.android.AlipayGphone/.AlipayLogin}"],
        ])
        runner.adb = mock.Mock(return_value="")

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            dismissed = runner.dismiss_vivo_wlan_risk_overlay()

        self.assertTrue(dismissed)
        runner.adb.assert_called_once_with(
            ["shell", "input", "keyevent", "4"], timeout=5, check=False,
        )
        self.assertEqual(runner.log[-1]["step"], "dismiss_vivo_wlan_risk_overlay")
        self.assertFalse(runner.log[-1]["networkChanged"])

    def test_lookup_resumes_alipay_when_vivo_warning_ignores_back(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "vivo-wlan-stuck"})
        covered = [
            "mCurrentFocus=Window{abc u0 com.vivo.safecenter/.WlanRiskActivity type=2038}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ]
        runner.focus = mock.Mock(side_effect=[covered] * 10 + [[
            "mCurrentFocus=Window{ghi u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ]])
        runner.adb = mock.Mock(return_value="Status: ok")

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            dismissed = runner.dismiss_vivo_wlan_risk_overlay()

        self.assertTrue(dismissed)
        commands = [call.args[0] for call in runner.adb.call_args_list]
        self.assertFalse(any(command[:3] == ["shell", "am", "force-stop"] for command in commands))
        self.assertEqual(runner.log[-1]["step"], "resume_alipay_over_vivo_wlan_risk_overlay")
        self.assertFalse(runner.log[-1]["networkChanged"])
        self.assertFalse(runner.log[-1]["forceStopped"])

    def test_lookup_poco_ignores_only_the_exact_vivo_wlan_risk_dialog(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "vivo-wlan-poco"})
        overlay = [
            "mCurrentFocus=Window{abc u0 com.vivo.safecenter type=2038}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ]
        runner.focus = mock.Mock(side_effect=[overlay, [
            "mCurrentFocus=Window{ghi u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ]])
        title = mock.Mock()
        message = mock.Mock()
        disconnect = mock.Mock()
        ignore = mock.Mock()
        ignore.get_position.return_value = (0.5, 0.92)
        text_by_node = {
            id(message): '"ZTQC-HYS"存在安全风险，可能导致隐私信息泄露。是否断开该网络？',
            id(disconnect): "立即断开",
            id(ignore): "忽略风险",
        }
        runner.poco_text = mock.Mock(side_effect=lambda node: text_by_node.get(id(node), ""))
        runner.poco_nodes = mock.Mock(side_effect=lambda snapshot, **selector: (
            [title] if selector.get("name") == "com.vivo.safecenter:id/alertTitle" else
            [message] if selector.get("name") == "android:id/message" else
            [disconnect] if selector.get("name") == "android:id/button1" else
            [ignore] if selector.get("name") == "android:id/button2" else []
        ))
        runner.display_size = mock.Mock(return_value=(720, 1612))
        runner.adb = mock.Mock(return_value="")
        poco = mock.Mock()
        poco.freeze.return_value = object()

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            dismissed = runner.poco_dismiss_vivo_wlan_risk_dialog(poco)

        self.assertTrue(dismissed)
        runner.adb.assert_called_once_with(
            ["shell", "input", "tap", "360", "1483"], timeout=5,
        )
        self.assertEqual(runner.log[-1]["step"], "dismiss_vivo_wlan_risk_overlay")
        self.assertEqual(runner.log[-1]["method"], "ignore_risk")
        self.assertFalse(runner.log[-1]["networkChanged"])
        self.assertEqual(runner.log[-1]["selector"]["resourceId"], "android:id/button2")

    def test_lookup_uses_home_before_resuming_alipay_under_stubborn_vivo_overlay(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "vivo-wlan-home-resume"})
        covered = [
            "mCurrentFocus=Window{abc u0 com.vivo.safecenter/.WlanRiskActivity type=2038}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ]
        alipay = [
            "mCurrentFocus=Window{ghi u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ]
        runner.focus = mock.Mock(side_effect=[covered] * 16 + [alipay])
        runner.adb = mock.Mock(return_value="Status: ok")

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            dismissed = runner.dismiss_vivo_wlan_risk_overlay()

        self.assertTrue(dismissed)
        commands = [call.args[0] for call in runner.adb.call_args_list]
        self.assertIn(["shell", "input", "keyevent", "3"], commands)
        self.assertEqual(sum(command[:3] == ["shell", "am", "start"] for command in commands), 2)
        self.assertFalse(any(command[:3] == ["shell", "am", "force-stop"] for command in commands))
        self.assertEqual(runner.log[-1]["step"],
                         "resume_alipay_over_vivo_wlan_risk_overlay_after_home")
        self.assertEqual(runner.log[-1]["method"], "home_then_resume_existing_alipay_task")
        self.assertFalse(runner.log[-1]["networkChanged"])
        self.assertFalse(runner.log[-1]["forceStopped"])

    def test_lookup_does_not_dismiss_a_standalone_vivo_security_screen(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "vivo-security-app"})
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=Window{abc u0 com.vivo.safecenter/.MainActivity}",
            "mFocusedApp=ActivityRecord{def u0 com.vivo.safecenter/.MainActivity}",
        ])
        runner.adb = mock.Mock(return_value="")

        self.assertFalse(runner.dismiss_vivo_wlan_risk_overlay())
        runner.adb.assert_not_called()

    def test_lookup_reveals_alipay_from_systemui_without_entering_credentials(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "systemui-cover"})
        runner.focus = mock.Mock(side_effect=[
            [
                "mCurrentFocus=Window{abc u0 com.android.systemui/.shade.NotificationShade}",
                "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            ],
            ["mCurrentFocus=Window{ghi u0 com.android.systemui/.shade.NotificationShade}"],
            ["mCurrentFocus=Window{jkl u0 com.eg.android.AlipayGphone/.AlipayLogin}"],
        ])
        runner.adb = mock.Mock(return_value="")

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            revealed = runner.restore_alipay_from_systemui()

        self.assertTrue(revealed)
        commands = [call.args[0] for call in runner.adb.call_args_list]
        self.assertIn(["shell", "input", "keyevent", "224"], commands)
        self.assertIn(["shell", "wm", "dismiss-keyguard"], commands)
        self.assertIn(["shell", "cmd", "statusbar", "collapse"], commands)
        self.assertFalse(any(command[:3] == ["shell", "input", "text"] for command in commands))
        self.assertEqual(runner.log[-1]["step"], "alipay_revealed_from_systemui")
        self.assertFalse(runner.log[-1]["unlockCredentialEntered"])

    def test_lookup_reveals_alipay_from_bare_oppo_notification_shade(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "oppo-bare-shade"})
        runner.focus = mock.Mock(side_effect=[
            [
                "mCurrentFocus=Window{a44a02d u0 NotificationShade}",
                "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            ],
            ["mCurrentFocus=Window{jkl u0 com.eg.android.AlipayGphone/.AlipayLogin}"],
        ])
        runner.adb = mock.Mock(return_value="")

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            revealed = runner.restore_alipay_from_systemui()

        self.assertTrue(revealed)
        commands = [call.args[0] for call in runner.adb.call_args_list]
        self.assertIn(["shell", "cmd", "statusbar", "collapse"], commands)
        self.assertEqual(runner.log[0]["step"], "systemui_covering_alipay_detected")
        self.assertEqual(runner.log[-1]["step"], "alipay_revealed_from_systemui")

    def test_lookup_does_not_treat_unrelated_notification_shade_text_as_systemui(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "shade-false-positive"})
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=Window{abc u0 com.example/.NotificationShadeHelp}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ])
        runner.adb = mock.Mock(return_value="")

        self.assertFalse(runner.restore_alipay_from_systemui())
        runner.adb.assert_not_called()

    def test_lookup_focus_components_never_treat_underlying_alipay_as_foreground(self):
        current, focused = self.lookup.Runner.focus_components([
            "mCurrentFocus=Window{abc u0 com.android.systemui/.shade.NotificationShade}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/MainSearchActivity}",
        ])
        self.assertIn("com.android.systemui", current)
        self.assertNotIn("com.eg.android.AlipayGphone", current)
        self.assertIn("com.eg.android.AlipayGphone", focused)

    def test_lookup_focus_components_skip_multidisplay_null_placeholders(self):
        current, focused = self.lookup.Runner.focus_components([
            "mCurrentFocus=null",
            "mFocusedApp=null",
            "mCurrentFocus=Window{abc u0 com.vivo.safecenter/.WlanRiskActivity type=2038}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ])

        self.assertIn("com.vivo.safecenter", current)
        self.assertNotIn("=null", current)
        self.assertIn("com.eg.android.AlipayGphone", focused)

    def test_lookup_poco_reuse_recovers_systemui_before_any_hierarchy_probe(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-systemui"})
        runner.poco_dismiss_local_service_prompt = mock.Mock(return_value=False)
        runner.focus = mock.Mock(side_effect=[
            [
                "mCurrentFocus=Window{abc u0 com.android.systemui/.shade.NotificationShade}",
                "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/MainSearchActivity}",
            ],
            ["mCurrentFocus=Window{ghi u0 com.eg.android.AlipayGphone/MainSearchActivity}"],
        ])
        runner.restore_alipay_from_systemui = mock.Mock(return_value=True)
        runner.poco_search_ready = mock.Mock(side_effect=AssertionError(
            "start must defer the redundant hierarchy probe on exact Search activity"
        ))
        runner.poco_raise_if_login_focus = mock.Mock(return_value=None)
        poco = mock.Mock()

        self.assertTrue(runner.poco_try_reuse_search_page(poco))

        runner.restore_alipay_from_systemui.assert_called_once_with()
        runner.poco_search_ready.assert_not_called()
        poco.freeze.assert_not_called()
        self.assertIn("retry_reuse_after_systemui", [item["step"] for item in runner.log])
        self.assertEqual(runner.log[-2]["step"], "reuse_search_page_by_exact_activity")
        self.assertTrue(runner.log[-2]["pocoHierarchyDeferred"])

    def test_lookup_poco_reuse_recovers_bare_notification_shade_before_hierarchy(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-bare-shade"})
        runner.poco_dismiss_local_service_prompt = mock.Mock(return_value=False)
        runner.focus = mock.Mock(side_effect=[
            [
                "mCurrentFocus=Window{a44a02d u0 NotificationShade}",
                "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/MainSearchActivity}",
            ],
            ["mCurrentFocus=Window{ghi u0 com.eg.android.AlipayGphone/MainSearchActivity}"],
        ])
        runner.restore_alipay_from_systemui = mock.Mock(return_value=True)
        runner.poco_search_ready = mock.Mock(side_effect=AssertionError(
            "bare NotificationShade must be removed before any hierarchy probe"
        ))
        runner.poco_raise_if_login_focus = mock.Mock(return_value=None)
        poco = mock.Mock()

        self.assertTrue(runner.poco_try_reuse_search_page(poco))

        runner.restore_alipay_from_systemui.assert_called_once_with()
        runner.poco_search_ready.assert_not_called()
        poco.freeze.assert_not_called()
        self.assertIn("retry_reuse_after_systemui", [item["step"] for item in runner.log])

    def test_lookup_resume_alipay_home_never_force_stops_the_app(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "resume-home"})
        runner.adb = mock.Mock(return_value="Status: ok")
        runner.dismiss_known_overlay = mock.Mock(return_value=False)

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.resume_alipay_home("account-list")

        commands = [call.args[0] for call in runner.adb.call_args_list]
        self.assertFalse(any(command[:3] == ["shell", "am", "force-stop"] for command in commands))
        self.assertTrue(any(command[:3] == ["shell", "am", "start"] for command in commands))
        self.assertEqual(runner.log[-1]["step"], "resume_alipay_home")

    def test_lookup_dismisses_exact_real_name_prompt_xml_without_authentication(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "real-name-xml"})
        runner._display_size = (720, 1600)
        root = ET.fromstring(f'''
        <hierarchy><node>
          <node text="{self.lookup.ALIPAY_REAL_NAME_PROMPT_TITLE}"/>
          <node text="{self.lookup.ALIPAY_REAL_NAME_PROMPT_ACTION}"/>
          <node class="android.widget.ImageView" clickable="true"
                bounds="[330,1210][390,1270]"/>
        </node></hierarchy>
        ''')
        runner.adb = mock.Mock(return_value="")

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            self.assertTrue(runner.dismiss_real_name_prompt_xml(root))

        runner.adb.assert_called_once_with(
            ["shell", "input", "tap", "360", "1240"], timeout=8,
        )
        self.assertEqual(runner.log[-1]["step"], "dismiss_alipay_real_name_prompt")
        self.assertFalse(runner.log[-1]["authenticationStarted"])

    def test_lookup_uses_one_back_for_canvas_modal_that_blocks_exact_my_tab(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "blocked-my"})
        root = ET.fromstring(f'''
        <hierarchy><node>
          <node resource-id="{self.lookup.TAB_SELECTED_FRAME_ID}"
                content-desc="首页" selected="true" bounds="[36,1522][108,1594]"/>
        </node></hierarchy>
        ''')
        home_focus = (
            [],
            "mCurrentFocus=Window{{1 u0 com.eg.android.AlipayGphone/.AlipayLogin}}",
            "mFocusedApp=ActivityRecord{{1 u0 com.eg.android.AlipayGphone/.AlipayLogin}}",
        )
        runner.focus_state = mock.Mock(side_effect=[home_focus, home_focus])
        runner.adb = mock.Mock(return_value="")
        runner.resume_alipay_home = mock.Mock()

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            self.assertTrue(runner.dismiss_canvas_modal_after_blocked_my_tab(root, "accounts"))

        runner.adb.assert_called_once_with(
            ["shell", "input", "keyevent", "4"], timeout=5, check=False,
        )
        runner.resume_alipay_home.assert_not_called()
        self.assertEqual(
            runner.log[-1]["step"],
            "dismiss_alipay_canvas_modal_after_blocked_my_tab",
        )
        self.assertFalse(runner.log[-1]["authenticationStarted"])

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
        runner.poco_dismiss_honor_software_update_dialog = mock.Mock(return_value=False)
        runner.dismiss_honor_software_update_overlay = mock.Mock(return_value=False)
        runner.poco_dismiss_known_overlay = mock.Mock(return_value=False)
        runner.poco_raise_if_account_restricted = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        runner.poco_open_search = mock.Mock()
        poco = types.SimpleNamespace(freeze=lambda: object())
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_prepare_full_path(poco, "test")
        runner.poco_dismiss_honor_software_update_dialog.assert_called_once_with(poco)
        runner.dismiss_honor_software_update_overlay.assert_called_once_with()
        runner.poco_dismiss_known_overlay.assert_not_called()
        runner.poco_raise_if_account_restricted.assert_not_called()
        runner.poco_open_search.assert_called_once_with(poco, "test", 0)
        self.assertFalse(any(command[:3] == ["shell", "am", "force-stop"] for command in runner.commands))
        self.assertTrue(any("0x14200000" in command for command in runner.commands))

    def test_account_transition_retries_only_hierarchy_observation(self):
        runner = self.lookup.Runner({"serial":"LOCAL", "taskId":"account-transition"})
        root = ET.fromstring('<hierarchy><node text="我的"/></hierarchy>')
        runner.dump = mock.Mock(side_effect=[RuntimeError("uiautomator_hierarchy_missing"),(root,{})])
        runner.account_switched = True
        runner.account_restriction_evidence = mock.Mock(return_value=None)
        runner.verification_evidence = mock.Mock(return_value=None)
        runner.dismiss_known_overlay = mock.Mock(return_value=False)
        runner.adb = mock.Mock(side_effect=AssertionError("observation retry must not tap an account"))
        runner.focus = mock.Mock(return_value=["mCurrentFocus=Window{test u0 com.eg.android.AlipayGphone/.AlipayLogin}"])
        with mock.patch.object(self.lookup.time,"sleep",return_value=None):
            found, _, _ = runner.wait_unique("account-switch-returned-home",timeout=20,text="我的")
        self.assertEqual(found,root)
        self.assertEqual(runner.dump.call_count,2)
        runner.adb.assert_not_called()

    def test_lookup_poco_full_path_preserves_underlying_alipay_and_handles_overlay(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "underlying-alipay-securepay",
        })
        runner.focus_state = mock.Mock(return_value=(
            [],
            "mCurrentFocus=Window{abc u0 com.netease.open.pocoservice/.TestActivity}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ))
        runner.poco_resume_alipay_home = mock.Mock(return_value=True)
        runner.poco_open_search = mock.Mock(return_value=None)
        runner.adb = mock.Mock(side_effect=AssertionError(
            "an underlying Alipay task must not be force-stopped or cold launched"
        ))
        poco = object()

        runner.poco_prepare_full_path(poco, "session-start")

        runner.poco_resume_alipay_home.assert_called_once_with(
            poco, "session-start-underlying-task",
        )
        runner.poco_open_search.assert_called_once_with(
            poco, "session-start", 0,
        )
        runner.adb.assert_not_called()
        self.assertEqual(
            runner.log[-1]["step"],
            "reuse_underlying_alipay_task_before_full_launch",
        )
        self.assertFalse(runner.log[-1]["forceStopped"])

    def test_lookup_poco_preserves_exact_slider_for_human(self):
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
            Node(self.lookup.JIGSAW_VERIFICATION_ACTION, (0.5, 0.568), (0.30, 0.03), "android.widget.TextView"),
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
            with self.assertRaisesRegex(RuntimeError, "poco_alipay_human_verification_required"):
                runner.poco_solve_human_verification(Poco(), "test")
        self.assertEqual(runner.commands, [])
        self.assertTrue(runner.log[-1]["requiresHuman"])
        self.assertEqual(runner.log[-1]["automatedAttempts"], 0)

    def test_lookup_poco_verification_read_timeout_never_retypes_or_swipes(self):
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

        class Poco:
            def __init__(inner_self):
                inner_self.calls = 0

            def freeze(inner_self):
                inner_self.calls += 1
                raise TimeoutError("bounded Poco HTTP timeout reading verification")

        class SliderRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({"serial": "LOCAL", "taskId": "poco-slider-timeout"})
                inner_self.commands = []

            def adb(inner_self, args, **kwargs):
                inner_self.commands.append(args)
                return ""

            def display_size(inner_self):
                return (720, 1600)

        runner = SliderRunner()
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            with self.assertRaisesRegex(
                RuntimeError,
                "poco_query_result_channel_timeout_after_input:slider_initial_snapshot",
            ):
                runner.poco_solve_human_verification(Poco(), "result-1")

        self.assertEqual(
            len([command for command in runner.commands if command[:3] == ["shell", "input", "swipe"]]),
            0,
        )
        timeout_event = next(
            item for item in runner.log
            if item["step"] == "human_verification_result_channel_timeout"
        )
        self.assertFalse(timeout_event["resubmitsInput"])

    def setUp(self):
        self.input_throttle_patcher = mock.patch.object(
            self.lookup.Runner, "wait_before_phone_input", return_value=0,
        )
        self.input_throttle_patcher.start()
        self.addCleanup(self.input_throttle_patcher.stop)
        self.lookup_adb_guard = mock.patch.object(self.lookup.Runner, "adb", side_effect=AssertionError("unexpected real ADB access in offline test"))
        self.lookup_adb_guard.start()
        self.addCleanup(self.lookup_adb_guard.stop)

    def test_lookup_recognizes_human_verification(self):
        root = ET.fromstring("""
        <hierarchy><node text="为保障您的正常访问请进行验证"/>
          <node text="向右滑动验证"/>
        </hierarchy>
        """)
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "test"})
        evidence = runner.verification_evidence(root)
        self.assertEqual(evidence["action"], "向右滑动验证")

    def test_lookup_xml_verification_preserves_page_and_requires_human(self):
        verification = ET.fromstring('''
        <hierarchy bounds="[0,0][720,1600]"><node text="为保障您的正常访问请进行验证">
          <node bounds="[80,700][640,780]">
            <node text="请拖动滑块完成拼图" bounds="[80,700][300,780]"/>
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
        with self.assertRaisesRegex(RuntimeError, "alipay_human_verification_required"):
            runner.solve_human_verification(verification, {}, "test")
        self.assertEqual(runner.commands, [])
        self.assertTrue(runner.log[-1]["requiresHuman"])
        self.assertFalse(runner.log[-1]["resubmitsInput"])

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

    def test_lookup_clear_search_input_batches_delete_keyevents(self):
        root = ET.fromstring(
            f'<hierarchy><node resource-id="{self.lookup.SEARCH_INPUT_ID}" '
            'text="19375183430" clickable="true" bounds="[40,40][680,120]"/></hierarchy>'
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
        self.assertEqual(runner.commands[1], [
            "shell", "input", "keyevent", "123", *(["67"] * 24),
        ])
        self.assertEqual(runner.log[-1]["method"], "element_tap_batched_keyevents")
        self.assertEqual(runner.log[-1]["keyDelayMs"], 0)
        self.assertEqual(runner.log[-1]["keyDelayMode"], "android_default")

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

    def test_lookup_xml_returns_unverified_result_from_first_input_readback(self):
        phone = "19375183430"
        search = ET.fromstring(
            f'<hierarchy><node resource-id="{self.lookup.SEARCH_INPUT_ID}" '
            'text="" clickable="true" bounds="[40,40][680,120]"/></hierarchy>'
        )
        result_ready = ET.fromstring(f'''
        <hierarchy><node>
          <node resource-id="{self.lookup.SEARCH_INPUT_ID}" text="{phone}"/>
          <node text="193******30(未实名)" bounds="[80,240][640,300]"/>
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

    def test_lookup_poco_reuse_probes_a_foreground_restriction_without_search_history(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-restricted"})
        runner.poco_dismiss_local_service_prompt = mock.Mock(return_value=False)
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=Window{123 u0 com.eg.android.AlipayGphone/"
            "com.alipay.mobile.nebulax.integration.mpaas.activity.NebulaTransActivity$Main}"
        ])
        runner.poco_raise_if_login_required = mock.Mock(return_value=None)
        runner.poco_raise_if_account_restricted = mock.Mock(side_effect=RuntimeError(
            "alipay_account_restriction_before_search:jigsaw_verification"
        ))
        runner.adb = mock.Mock(side_effect=AssertionError(
            "an evidenced foreground restriction must not inspect or resume the old task stack"
        ))
        snapshot = object()
        poco = mock.Mock()
        poco.freeze.return_value = snapshot

        with self.assertRaisesRegex(
            RuntimeError, "alipay_account_restriction_before_search:jigsaw_verification",
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

    def test_lookup_poco_reuse_normalizes_unevidenced_foreground_surface_before_search(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-home"})
        runner.poco_dismiss_local_service_prompt = mock.Mock(return_value=False)
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=Window{123 u0 com.eg.android.AlipayGphone/.AlipayLogin}"
        ])
        runner.poco_raise_if_login_required = mock.Mock(return_value=None)
        runner.poco_raise_if_account_restricted = mock.Mock(return_value=None)
        runner.poco_resume_alipay_home = mock.Mock(return_value=True)
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
        runner.poco_resume_alipay_home.assert_called_once_with(
            poco, "reuse-foreground-no-home-search"
        )
        runner.poco_open_search.assert_called_once_with(poco, "reuse-foreground")
        runner.adb.assert_not_called()
        self.assertEqual(runner.log[-1]["step"], "reuse_existing_search_page")
        self.assertEqual(runner.log[-1]["method"], "poco_resume_home_then_open_search")

    def test_lookup_poco_home_resume_never_force_stops_alipay_or_uses_xml(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "safe-home-resume"})
        calls = []

        def adb(args, **kwargs):
            calls.append(list(args))
            return "Status: ok"

        runner.adb = mock.Mock(side_effect=adb)
        runner.focus_state = mock.Mock(return_value=(
            [],
            "mCurrentFocus=Window{123 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            "mFocusedApp=ActivityRecord{123 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ))
        runner.poco_raise_if_login_focus = mock.Mock(return_value=None)
        runner.poco_activate_home_tab_if_present = mock.Mock(return_value=False)

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            poco = object()
            self.assertTrue(runner.poco_resume_alipay_home(poco, "unit"))

        self.assertTrue(any(call[:3] == ["shell", "am", "start"] for call in calls))
        self.assertTrue(any(
            call[:6] == ["shell", "am", "start", "-W", "-f", "0x14200000"]
            for call in calls
        ))
        self.assertFalse(any("force-stop" in call for call in calls))
        self.assertEqual(runner.log[-1]["step"], "resume_alipay_home")
        self.assertFalse(runner.log[-1]["forceStopped"])
        self.assertTrue(runner.log[-1]["routeClearedToHome"])
        runner.poco_activate_home_tab_if_present.assert_called_once_with(poco, "unit")

    def test_lookup_poco_home_resume_selects_exact_home_tab_without_fixed_coordinate(self):
        class HomeTab:
            def __len__(inner_self):
                return 1

        home_tab = HomeTab()
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "select-home-tab"})
        runner.poco_tap = mock.Mock(return_value=None)
        poco = mock.Mock(side_effect=lambda **selector: (
            home_tab if selector == {
                "name": self.lookup.TAB_DESCRIPTION_ID, "text": "首页",
            } else None
        ))

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            self.assertTrue(runner.poco_activate_home_tab_if_present(poco, "unit"))

        poco.assert_called_once_with(
            name=self.lookup.TAB_DESCRIPTION_ID, text="首页",
        )
        runner.poco_tap.assert_called_once_with(home_tab)
        self.assertEqual(runner.log[-1]["step"], "activate_alipay_home_tab")
        self.assertTrue(runner.log[-1]["coordinateDerivedFromPoco"])
        self.assertEqual(runner.log[-1]["driver"], "poco")

    def test_lookup_poco_reuse_live_home_skips_restriction_hierarchy_probe(self):
        class UniqueLiveSearch(FakeNode):
            def __len__(inner_self):
                return 1

        search = UniqueLiveSearch("search", (0.56, 0.08))

        class LivePoco:
            def __call__(inner_self, **selector):
                if selector == {"desc": "搜索框"}:
                    return search
                if selector == {"desc": "全屏广告"}:
                    return []
                self.assertIn(selector.get("text"), [self.lookup.ALIPAY_REAL_NAME_PROMPT_TITLE, self.lookup.ALIPAY_REAL_NAME_PROMPT_TITLE_188])
                return []

            def freeze(inner_self):
                raise AssertionError("normal home must not request the full hierarchy")

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-live-home"})
        runner.poco_dismiss_local_service_prompt = mock.Mock(return_value=False)
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=Window{123 u0 com.eg.android.AlipayGphone/.AlipayLogin}"
        ])
        runner.poco_open_search = mock.Mock(return_value=None)

        reused = runner.poco_try_reuse_search_page(LivePoco())

        self.assertTrue(reused)
        runner.poco_open_search.assert_called_once_with(
            mock.ANY, "reuse-foreground", search_target=search,
        )
        self.assertEqual(runner.log[-1]["method"], "poco_live_search_from_foreground")

    def test_lookup_poco_reuse_ignores_null_display_before_real_alipay_focus(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-multidisplay-home"})
        runner.poco_dismiss_local_service_prompt = mock.Mock(return_value=False)
        runner.focus = mock.Mock(return_value=[
            "mCurrentFocus=null",
            "mFocusedApp=null",
            "mCurrentFocus=Window{123 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            "mFocusedApp=ActivityRecord{456 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ])
        runner.poco_raise_if_login_required = mock.Mock(return_value=None)
        runner.poco_raise_if_account_restricted = mock.Mock(return_value=None)
        runner.poco_resume_alipay_home = mock.Mock(return_value=True)
        runner.poco_open_search = mock.Mock(return_value=None)
        runner.adb = mock.Mock(side_effect=AssertionError(
            "a concrete Alipay focus after a null display must not cold launch"
        ))
        snapshot = object()
        poco = mock.Mock()
        poco.freeze.return_value = snapshot

        self.assertTrue(runner.poco_try_reuse_search_page(poco))

        runner.poco_open_search.assert_called_once_with(poco, "reuse-foreground")
        runner.adb.assert_not_called()
        runner.poco_resume_alipay_home.assert_called_once_with(
            poco, "reuse-foreground-no-home-search"
        )
        self.assertEqual(runner.log[-1]["method"], "poco_resume_home_then_open_search")

    def test_lookup_poco_reuse_handles_vivo_overlay_after_null_display(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-multidisplay-vivo"})
        runner.poco_dismiss_local_service_prompt = mock.Mock(return_value=False)
        runner.focus = mock.Mock(side_effect=[[
            "mCurrentFocus=null",
            "mFocusedApp=null",
            "mCurrentFocus=Window{123 u0 com.vivo.safecenter/.WlanRiskActivity type=2038}",
            "mFocusedApp=ActivityRecord{456 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ], [
            "mCurrentFocus=Window{789 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
            "mFocusedApp=ActivityRecord{456 u0 com.eg.android.AlipayGphone/.AlipayLogin}",
        ]])
        runner.poco_dismiss_vivo_wlan_risk_dialog = mock.Mock(return_value=True)
        runner.dismiss_vivo_wlan_risk_overlay = mock.Mock(side_effect=AssertionError(
            "the evidenced Ignore Risk button should handle this overlay"
        ))
        runner.poco_raise_if_login_required = mock.Mock(return_value=None)
        runner.poco_raise_if_account_restricted = mock.Mock(return_value=None)
        runner.poco_resume_alipay_home = mock.Mock(return_value=True)
        runner.poco_open_search = mock.Mock(return_value=None)
        runner.adb = mock.Mock(side_effect=AssertionError(
            "the covered Alipay task must be reused, not cold launched"
        ))
        poco = mock.Mock()
        poco.freeze.return_value = object()

        self.assertTrue(runner.poco_try_reuse_search_page(poco))

        runner.poco_dismiss_vivo_wlan_risk_dialog.assert_called_once_with(poco)
        runner.dismiss_vivo_wlan_risk_overlay.assert_not_called()
        runner.poco_resume_alipay_home.assert_called_once_with(
            poco, "reuse-foreground-no-home-search"
        )
        runner.poco_open_search.assert_called_once_with(poco, "reuse-foreground")
        runner.adb.assert_not_called()
        self.assertIn("retry_reuse_after_vivo_wlan_risk", [item["step"] for item in runner.log])

    def test_lookup_poco_reuse_dismisses_securepay_before_alipay_hierarchy_probe(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-securepay"})
        runner.poco_dismiss_local_service_prompt = mock.Mock(return_value=False)
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
        runner.poco_resume_alipay_home = mock.Mock(return_value=True)
        runner.poco_open_search = mock.Mock(return_value=None)
        snapshot = object()
        poco = mock.Mock()
        poco.freeze.return_value = snapshot

        reused = runner.poco_try_reuse_search_page(poco)

        self.assertTrue(reused)
        runner.poco_dismiss_coloros_securepay_usb_dialog.assert_called_once_with(poco)
        poco.freeze.assert_called_once_with()
        runner.poco_resume_alipay_home.assert_called_once_with(
            poco, "reuse-foreground-no-home-search"
        )
        runner.poco_open_search.assert_called_once_with(poco, "reuse-foreground")
        self.assertIn(
            "retry_reuse_after_coloros_securepay_warning",
            [event["step"] for event in runner.log],
        )

    def test_lookup_poco_reuse_propagates_login_required_before_open_search(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "reuse-login-required"})
        runner.poco_dismiss_local_service_prompt = mock.Mock(return_value=False)
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

    def test_lookup_poco_start_retries_skip_repeating_noncritical_keep_awake(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "start-attach-retry",
            "operation": "start", "startAttachAttempt": 2,
        })
        runner.adb = mock.Mock(side_effect=lambda args, **kwargs: (
            "device" if args == ["get-state"] else "package:/data/app/alipay/base.apk"
        ))
        runner.keep_awake_usb_best_effort = mock.Mock(side_effect=AssertionError(
            "a rebuilt worker must not repeat the noncritical wake shell"
        ))
        runner.poco_try_reuse_search_page = mock.Mock(return_value=True)

        result = runner.run_poco(object())

        self.assertTrue(result["ok"])
        runner.keep_awake_usb_best_effort.assert_not_called()
        skipped = [event for event in runner.log if event["step"] == "skip_repeat_keep_awake"]
        self.assertEqual(len(skipped), 1)
        self.assertEqual(skipped[0]["startAttachAttempt"], 2)

    def test_lookup_poco_start_first_attach_still_keeps_awake(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "start-first-attach",
            "operation": "start", "startAttachAttempt": 1,
        })
        runner.adb = mock.Mock(side_effect=lambda args, **kwargs: (
            "device" if args == ["get-state"] else "package:/data/app/alipay/base.apk"
        ))
        runner.keep_awake_usb_best_effort = mock.Mock(return_value=True)
        runner.poco_try_reuse_search_page = mock.Mock(return_value=True)

        result = runner.run_poco(object())

        self.assertTrue(result["ok"])
        runner.keep_awake_usb_best_effort.assert_called_once_with()

    def test_lookup_poco_start_returns_overlay_failure_without_relaunch(self):
        runner = self.lookup.Runner({
            "serial": "LOCAL", "taskId": "start-overlay-failed", "operation": "start",
        })
        runner.adb = mock.Mock(side_effect=lambda args, **kwargs: (
            "device" if args == ["get-state"] else "package:/data/app/alipay/base.apk"
        ))
        runner.keep_awake_usb_best_effort = mock.Mock()
        runner.poco_try_reuse_search_page = mock.Mock(side_effect=RuntimeError(
            "com.vivo.safecenter_resume_alipay_timeout"
        ))
        runner.poco_prepare_full_path = mock.Mock(side_effect=AssertionError(
            "a stubborn OEM overlay must not force-stop or relaunch Alipay"
        ))

        with self.assertRaisesRegex(RuntimeError, "resume_alipay_timeout"):
            runner.run_poco(object())

        runner.poco_prepare_full_path.assert_not_called()
        self.assertEqual(runner.log[-1]["step"], "reuse_search_overlay_recovery_failed")
        self.assertEqual(runner.log[-1]["driver"], "poco_focus_adb")

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
        runner.focus = mock.Mock(return_value=[])
        search = object()
        search_input = object()
        runner.poco_dismiss_known_overlay = mock.Mock(return_value=False)
        runner.poco_home_search_target = mock.Mock(return_value=search)
        runner.poco_unique = mock.Mock(side_effect=[
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

    def test_lookup_poco_dismisses_exact_phone_credit_promo_by_bottom_x_only(self):
        class PromoNode(FakeNode):
            def __init__(inner_self, text, position, size=(0.1, 0.05)):
                super().__init__(text, position, size)
                inner_self.text = text

            def attr(inner_self, key):
                return inner_self.text if key in {"text", "desc"} else ""

        title = PromoNode("话费限时福利", (0.5, 0.4))
        offer = PromoNode("1分钱充5元话费", (0.5, 0.5))
        claim = PromoNode("立即领取", (0.5, 0.62), (0.5, 0.08))
        close = PromoNode("", (0.5, 0.79), (0.08, 0.04))

        class Snapshot:
            def __call__(inner_self, **selector):
                node_type = selector.get("type")
                if node_type == "android.widget.TextView":
                    return [title, offer, claim]
                if node_type == "android.widget.ImageView":
                    return [close]
                return []

        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "phone-credit-promo"})
        runner.poco_tap = mock.Mock()

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            self.assertTrue(runner.poco_dismiss_phone_credit_promo_snapshot(Snapshot()))

        runner.poco_tap.assert_called_once_with(close)
        self.assertEqual(runner.log[-1]["step"], "dismiss_alipay_phone_credit_promo")
        self.assertFalse(runner.log[-1]["promotedActionTapped"])

    def test_lookup_xml_dismisses_exact_phone_credit_promo_by_bottom_x_only(self):
        root = ET.fromstring("""<hierarchy><node package="com.eg.android.AlipayGphone" class="android.view.View" bounds="[0,0][720,1600]">
          <node text="话费限时福利" class="android.widget.TextView" bounds="[200,580][520,650]" />
          <node text="1分钱充5元话费" class="android.widget.TextView" bounds="[180,700][540,790]" />
          <node text="立即领取" class="android.widget.Button" bounds="[180,950][540,1080]" />
          <node text="" content-desc="" class="android.widget.ImageView" bounds="[330,1210][390,1270]" />
        </node></hierarchy>""")
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "phone-credit-promo-xml"})
        runner._display_size = (720, 1600)
        runner.adb = mock.Mock(return_value="")

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            self.assertTrue(runner.dismiss_phone_credit_promo_xml(root))

        runner.adb.assert_called_once_with(
            ["shell", "input", "tap", "360", "1240"], timeout=8,
        )
        self.assertEqual(runner.log[-1]["step"], "dismiss_alipay_phone_credit_promo")
        self.assertFalse(runner.log[-1]["promotedActionTapped"])

    def test_lookup_poco_open_search_recovers_one_exact_overlay_created_after_home_tap(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "late-known-overlay"})
        runner.focus = mock.Mock(return_value=[])
        first_search = object()
        second_search = object()
        search_input = object()
        snapshot = object()
        poco = mock.Mock()
        poco.freeze.return_value = snapshot
        runner.poco_home_search_target = mock.Mock(side_effect=[first_search, second_search])
        runner.poco_unique = mock.Mock(side_effect=[
            RuntimeError("poco_selector_missing:{'name': 'search_input'}; count=0"),
            search_input,
        ])
        runner.poco_tap = mock.Mock()
        runner.poco_dismiss_coloros_securepay_usb_dialog = mock.Mock(return_value=False)
        runner.poco_dismiss_alipay_home_overlay_snapshot = mock.Mock(return_value=True)
        runner.poco_raise_if_login_required = mock.Mock()
        runner.poco_raise_if_account_restricted = mock.Mock()

        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_open_search(poco, "session-start")

        self.assertEqual(runner.poco_tap.call_args_list, [mock.call(first_search), mock.call(second_search)])
        runner.poco_dismiss_alipay_home_overlay_snapshot.assert_called_once_with(snapshot)
        self.assertIn(
            "retry_search_after_late_known_overlay",
            [event["step"] for event in runner.log],
        )
        self.assertEqual(runner.log[-1]["step"], "open_search")
        self.assertEqual(runner.log[-1]["reason"], "session-start-after-late-overlay")

    def local_service_poco_fixture(self, missing="", duplicate_close=False, persistent=False, enabled=True):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "location-intro"})
        prefix = "com.alipay.mobile.antui:id/"
        closed = [False]

        class CloseNode(FakeNode):
            def attr(inner_self, key):
                return {"package": self.lookup.ALIPAY_PACKAGE, "enabled": enabled, "touchable": True}.get(key, "")

        close = CloseNode("cancel", (0.82, 0.35))

        def poco(**selector):
            if closed[0] and not persistent:
                return []
            name = str(selector.get("name", "")).replace(prefix, "")
            if name == missing:
                return []
            if name == "btn_close":
                return [close, close] if duplicate_close else [close]
            if name in {"title_txt_1", "title_txt_2", "buttomButtonView"}:
                return [object()]
            return []

        def tap(node):
            self.assertIs(node, close)
            closed[0] = True

        runner.poco_tap = mock.Mock(side_effect=tap)
        runner.focus_state = mock.Mock(return_value=([], self.lookup.ALIPAY_PACKAGE + "/MainSearchActivity", ""))
        return runner, poco, close

    def test_lookup_location_intro_cancels_without_permission_or_next_action(self):
        runner, poco, close = self.local_service_poco_fixture()
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            self.assertTrue(runner.poco_dismiss_local_service_prompt(poco))
        runner.poco_tap.assert_called_once_with(close)
        event = runner.log[-1]
        self.assertEqual(event["step"], "dismiss_alipay_local_service_prompt")
        self.assertFalse(event["permissionRequested"])
        self.assertFalse(event["nextButtonTapped"])
        self.assertFalse(event["phoneQueryStarted"])

    def test_lookup_location_intro_requires_all_evidence_and_unique_enabled_close(self):
        for options in ({"missing": "title_txt_1"}, {"missing": "title_txt_2"},
                        {"missing": "buttomButtonView"}, {"missing": "btn_close"},
                        {"duplicate_close": True}, {"enabled": False}):
            with self.subTest(options=options):
                runner, poco, _ = self.local_service_poco_fixture(**options)
                if options.get("missing") == "title_txt_1":
                    self.assertFalse(runner.poco_dismiss_local_service_prompt(poco))
                else:
                    with self.assertRaisesRegex(RuntimeError, "local_service_close_unverified"):
                        runner.poco_dismiss_local_service_prompt(poco)
                runner.poco_tap.assert_not_called()

    def test_lookup_location_intro_does_not_tap_after_foreground_changes(self):
        runner, poco, _ = self.local_service_poco_fixture()
        runner.focus_state.return_value = ([], "com.android.permissioncontroller/GrantPermissionsActivity", "")
        with self.assertRaisesRegex(RuntimeError, "local_service_foreground_changed"):
            runner.poco_dismiss_local_service_prompt(poco)
        runner.poco_tap.assert_not_called()

    def test_lookup_location_intro_close_is_not_repeated_if_modal_persists(self):
        runner, poco, close = self.local_service_poco_fixture(persistent=True)
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "local_service_not_dismissed"):
                runner.poco_dismiss_local_service_prompt(poco)
        runner.poco_tap.assert_called_once_with(close)

    def test_lookup_location_intro_transport_failure_does_not_click(self):
        runner, _, _ = self.local_service_poco_fixture()
        poco = mock.Mock(side_effect=TimeoutError("HTTP"))
        with self.assertRaisesRegex(RuntimeError, "poco_rpc_failed"):
            runner.poco_dismiss_local_service_prompt(poco)
        runner.poco_tap.assert_not_called()

    def test_lookup_start_rechecks_input_after_location_intro_cancel(self):
        runner, poco, close = self.local_service_poco_fixture()
        runner.poco_search_ready = mock.Mock(return_value=object())
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            self.assertTrue(runner.poco_try_reuse_search_page(poco))
        runner.poco_tap.assert_called_once_with(close)
        runner.poco_search_ready.assert_called_once_with(poco)
        self.assertEqual(runner.log[-1]["method"], "after_local_service_cancel")

    def test_lookup_query_checks_location_intro_before_input(self):
        runner, poco, close = self.local_service_poco_fixture()
        runner.poco_unique = mock.Mock(return_value=object())
        with mock.patch.object(self.lookup.time, "sleep", return_value=None):
            runner.poco_search_ready(poco)
        runner.poco_tap.assert_called_once_with(close)
        runner.poco_unique.assert_called_once_with(poco, timeout=2.0, live=True, name=self.lookup.SEARCH_INPUT_ID)

    def test_lookup_late_jigsaw_is_classified_after_single_submit_without_reinput(self):
        phone = "13800138000"
        clock = [0.0]
        input_node = FakeNode("input", (0.5, 0.1))
        input_node.set_text = mock.Mock(side_effect=lambda text: setattr(input_node, "value", text))
        input_node.attr = lambda key: input_node.value if key == "text" else ""
        confirm = FakeNode("confirm", (0.9, 0.1))
        snapshots = iter(["search", "search", "search", "search", "loading", "loading", "jigsaw"])
        poco = mock.Mock()

        def freeze():
            clock[0] += 1.0
            return next(snapshots, "jigsaw")

        poco.freeze.side_effect = freeze
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "late-jigsaw-after-submit"})
        runner.poco_search_ready = mock.Mock(return_value=input_node)
        runner.poco_tap = mock.Mock()
        runner.focused_search_input_length = mock.Mock(side_effect=[3, 0])
        runner.clear_focused_search_input = mock.Mock(side_effect=lambda **kwargs: setattr(input_node, "value", ""))
        runner.poco_dismiss_post_input_usb_warning = mock.Mock(return_value=False)
        runner.adb = mock.Mock(side_effect=lambda args, **kwargs:
            (setattr(input_node, "value", phone) if is_phone_keyevent_command(args, phone) else None) or "")
        runner.poco_nodes = lambda snapshot, **selector: (
            [input_node] if snapshot == "search" and selector.get("name") == self.lookup.SEARCH_INPUT_ID
            else [confirm] if snapshot == "search" and str(selector.get("name", "")).endswith("search_confirm") else []
        )
        runner.poco_snapshot_texts = lambda snapshot, limit=120: (
            [self.lookup.VERIFICATION_TITLE, self.lookup.JIGSAW_VERIFICATION_ACTION] if snapshot == "jigsaw" else []
        )
        runner.parse_poco_result = mock.Mock(return_value=None)
        with mock.patch.object(self.lookup.time, "time", side_effect=lambda: clock[0]), \
                mock.patch.object(self.lookup.time, "perf_counter", side_effect=lambda: clock[0]), \
                mock.patch.object(self.lookup.time, "sleep", side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)):
            with self.assertRaisesRegex(RuntimeError, "poco_alipay_human_verification_required:jigsaw_verification"):
                runner.query_once_poco(poco, phone)
        input_node.set_text.assert_not_called()
        self.assertEqual(sum(is_phone_keyevent_command(c.args[0], phone) for c in runner.adb.call_args_list), 1)
        self.assertEqual(sum(c.args[0] is confirm for c in runner.poco_tap.call_args_list), 1)
        verification = next(e for e in runner.log if e["step"] == "human_verification_detected")
        self.assertFalse(verification["resubmitsInput"])
        self.assertTrue(verification["requiresHuman"])
        self.assertEqual(verification["automatedAttempts"], 0)
        self.assertFalse(any(e["step"] == "alipay_account_restriction_detected" for e in runner.log))

    def test_lookup_transition_returns_late_result_without_taps(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "late-result"})
        runner.poco_raise_if_account_restricted = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        result = {"alipayDisplayName": "测试(**测)", "realNameTailCharacter": "测"}
        runner.parse_poco_result = mock.Mock(return_value=result)
        runner.poco_tap = mock.Mock()
        observed = runner.poco_observe_result_transition(mock.Mock(), "13800138000", float("inf"))
        self.assertEqual(observed, result)
        runner.poco_tap.assert_not_called()

    def test_lookup_transition_rpc_failure_enters_read_only_resume(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "transition-http"})
        poco = mock.Mock()
        poco.freeze.side_effect = TimeoutError("HTTP")
        with self.assertRaisesRegex(RuntimeError, "poco_query_result_channel_timeout_after_input:transition"):
            runner.poco_observe_result_transition(poco, "13800138000", float("inf"))
        poco.freeze.assert_called_once()

    def test_lookup_transition_respects_exhausted_query_deadline(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "transition-deadline"})
        poco = mock.Mock()
        self.assertIsNone(runner.poco_observe_result_transition(poco, "13800138000", 0.0))
        poco.freeze.assert_not_called()
        self.assertEqual(runner.log[-1]["step"], "query_result_transition_unresolved")

    def test_lookup_poco_search_ready_dismisses_coloros_warning_before_checking_focus(self):
        runner = self.lookup.Runner({"serial": "LOCAL", "taskId": "search-ready-securepay"})
        runner.poco_dismiss_local_service_prompt = mock.Mock(return_value=False)
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
        runner.poco_dismiss_post_input_usb_warning = mock.Mock(return_value=False)
        runner.poco_search_ready = mock.Mock(return_value=input_node)
        runner.poco_tap = mock.Mock()
        runner.focused_search_input_length = mock.Mock(return_value=0)
        runner.clear_focused_search_input = mock.Mock(
            side_effect=lambda method="": setattr(input_node, "value", ""),
        )
        runner.adb = mock.Mock(
            side_effect=lambda args, **kwargs: (
                setattr(input_node, "value", "13687366441")
                if is_phone_keyevent_command(args, "13687366441") else None
            ) or "",
        )
        runner.poco_wait_for_post_query_restriction = mock.Mock(
            side_effect=RuntimeError("late restriction evidence"),
        )

        with mock.patch.object(self.lookup, "POCO_NO_NAME_RESULT_SECONDS", 0.05):
            with self.assertRaisesRegex(RuntimeError, "late restriction evidence"):
                runner.query_once_poco(Poco(), "13687366441")

        runner.poco_wait_for_post_query_restriction.assert_called_once_with(
            mock.ANY, "search-submit-unavailable",
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

            def resume_alipay_home(inner_self, token):
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

    def test_lookup_known_restriction_is_returned_without_automatic_switch(self):
        phone = "13800138000"

        class RestrictedRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({
                    "serial": "LOCAL", "taskId": "manual-limit",
                    "operation": "query", "phoneNumber": phone,
                    "accountCooldownProtocol": 1, "knownAccount": "synthetic-account",
                    "accountIdentityVerified": True,
                    "savedAccounts": [{"account": "synthetic-account", "current": True}],
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
                    "alipay_account_restriction_switch_required:device_risk"
                )

        runner = RestrictedRunner()
        with self.assertRaisesRegex(
            RuntimeError, "alipay_account_restriction_switch_required:device_risk"
        ):
            runner.run()
        self.assertEqual(runner.query_calls, [phone])
        self.assertEqual(runner.switch_calls, 0)

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
                raise AssertionError("account switch must defer Search to the following Poco query")

        runner = LeanManualSwitchRunner()
        result = runner.run()
        self.assertTrue(result["ok"])
        self.assertEqual(result["currentAccount"], "198******91")
        self.assertEqual(
            [command for command in runner.commands if command[:3] == ["shell", "input", "tap"]],
            [["shell", "input", "tap", "360", "350"]],
        )
        self.assertFalse(result["searchReady"])
        self.assertIn("account_switch_search_prepare_deferred", [item["step"] for item in runner.log])
        verification = next(item for item in runner.log if item["step"] == "account_switch_verified")
        self.assertEqual(verification["verification"], "exact_target_click_and_home_return")

    def test_lookup_manual_switch_defers_search_without_replaying_verified_switch(self):
        current_node = ET.Element("node", {"bounds": "[0,100][720,200]"})
        target_node = ET.Element("node", {"bounds": "[0,300][720,400]"})
        rows = [
            ("155******36", True, current_node),
            ("198******91", False, target_node),
        ]

        class DeferredSearchRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({
                    "serial": "LOCAL", "taskId": "deferred-search",
                    "operation": "switch", "targetAccount": "198******91",
                })

            def adb(inner_self, args, **kwargs):
                if args == ["get-state"]:
                    return "device"
                if args == ["shell", "pm", "path", self.lookup.ALIPAY_PACKAGE]:
                    return "package:/alipay.apk"
                return ""

            def reuse_open_account_picker(inner_self, token, timeout=4.0):
                return rows

            def wait_unique(inner_self, token, timeout=12, **selector):
                return ET.Element("hierarchy"), {}, ET.Element("node")

            def open_search(inner_self, reason):
                raise AssertionError("account switch must not open Search")

        result = DeferredSearchRunner().run()
        self.assertTrue(result["ok"])
        self.assertTrue(result["accountSwitched"])
        self.assertFalse(result["searchReady"])
        deferred = next(item for item in result["log"] if item["step"] == "account_switch_search_prepare_deferred")
        self.assertTrue(deferred["accountSwitchCompleted"])
        self.assertFalse(deferred["retryAccountSwitch"])

    def test_lookup_poco_query_prepares_search_before_phone_input(self):
        class QueryRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({
                    "serial": "LOCAL", "taskId": "prepare-query",
                    "operation": "query", "phoneNumber": "13800138000",
                })
                inner_self.calls = []

            def adb(inner_self, args, **kwargs):
                if args == ["get-state"]:
                    return "device"
                if args == ["shell", "pm", "path", self.lookup.ALIPAY_PACKAGE]:
                    return "package:/alipay.apk"
                return ""

            def poco_try_reuse_search_page(inner_self, poco):
                inner_self.calls.append("prepare")
                return True

            def query_once_poco(inner_self, poco, phone, **kwargs):
                inner_self.calls.append("input")
                return {
                    "alipayDisplayName": "测试用户(**测)",
                    "realNameTailCharacter": "测",
                    "matchedPhone": phone,
                }

        runner = QueryRunner()
        result = runner.run_poco(object())
        self.assertTrue(result["ok"])
        self.assertEqual(runner.calls, ["prepare", "input"])

    def test_lookup_poco_stop_does_not_probe_package_manager(self):
        class InputNode:
            def set_text(inner_self, value):
                return None

        class StopRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({"serial": "LOCAL", "taskId": "stop-no-pm", "operation": "stop"})

            def adb(inner_self, args, **kwargs):
                if args == ["get-state"]:
                    return "device"
                if args[:3] == ["shell", "pm", "path"]:
                    raise AssertionError("stop must not query package manager")
                return ""

            def poco_search_ready(inner_self, poco, live=True):
                return InputNode()

        runner = StopRunner()
        runner.poco_tap = mock.Mock()
        runner.clear_focused_search_input = mock.Mock()
        result = runner.run_poco(object())
        runner.clear_focused_search_input.assert_called_once()
        self.assertTrue(result["ok"])

    def test_lookup_success_count_200_does_not_trigger_account_switch(self):
        class CountRunner(self.lookup.Runner):
            def __init__(inner_self):
                super().__init__({
                    "serial": "LOCAL", "taskId": "no-auto-200",
                    "operation": "query", "phoneNumber": "13800138000",
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
