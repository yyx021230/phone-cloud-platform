import importlib.util
import os
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("lookup", os.environ.get(
    "LOOKUP_RECOVERY_TEST_SOURCE", os.path.join(os.path.dirname(__file__), "alipay_name_lookup.py")))
lookup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lookup)


class PageRecoveryTests(unittest.TestCase):
    def runner(self, **extra):
        r = lookup.Runner({"serial": "LOCAL", "taskId": "recovery-test",
                           "operation": "query", "phoneNumber": "13800138000",
                           "recoverUnexpectedPage": True, "pageRecoveryStage": "restart_app", **extra})
        r.adb = mock.Mock(side_effect=lambda args, **kw: "device" if args == ["get-state"] else "package:fake")
        r.focus = mock.Mock(return_value=["mCurrentFocus=Window{1 u0 com.vivo.browser/.BrowserActivity}"])
        r.emit = mock.Mock()
        r.poco_raise_if_login_focus = mock.Mock()
        r.poco_raise_if_login_required = mock.Mock()
        r.poco_raise_if_account_restricted = mock.Mock()
        r.poco_verification_evidence = mock.Mock(return_value=None)
        r.poco_prepare_full_path = mock.Mock()
        r.poco_try_reuse_search_page = mock.Mock(return_value=True)
        r.poco_search_ready = mock.Mock()
        r.query_once_poco = mock.Mock(return_value={"notFound": True})
        return r

    def test_restarts_then_confirms_search_before_same_number_query(self):
        r = self.runner(pageRecoveryStage="continue_query")
        order = []
        r.poco_try_reuse_search_page.side_effect = lambda *args: order.append("reuse-after-restart") or True
        r.poco_search_ready.side_effect = lambda *args, **kw: order.append("search-ready")
        r.query_once_poco.side_effect = lambda p, phone, **kw: order.append("query") or {"notFound": True}
        self.assertTrue(r.run_poco(mock.Mock())["ok"])
        self.assertEqual(order, ["reuse-after-restart", "search-ready", "query"])
        self.assertEqual(r.query_once_poco.call_args.args[1], "13800138000")

    def test_verification_cannot_be_restarted_away(self):
        r = self.runner()
        r.poco_verification_evidence.return_value = {"kind": "verification"}
        with self.assertRaisesRegex(RuntimeError, "human_verification_required"):
            r.run_poco(mock.Mock())
        r.poco_prepare_full_path.assert_not_called()
        r.query_once_poco.assert_not_called()

    def test_restart_stage_launches_only_alipay_and_does_not_query_invalid_poco(self):
        r = self.runner()
        result = r.run_poco(mock.Mock())
        self.assertEqual(result["appRecoveryStage"], "app_restarted")
        commands = [call.args[0] for call in r.adb.call_args_list]
        stops = [args for args in commands if args[:3] == ["shell", "am", "force-stop"]]
        self.assertEqual(stops, [["shell", "am", "force-stop", lookup.ALIPAY_PACKAGE]])
        self.assertEqual(len([args for args in commands if args[:3] == ["shell", "am", "start"]]), 1)
        r.query_once_poco.assert_not_called()
        r.poco_search_ready.assert_not_called()
        r.poco_prepare_full_path.assert_not_called()

    def test_continue_failure_does_not_force_stop_alipay_again(self):
        r = self.runner(pageRecoveryStage="continue_query")
        r.poco_try_reuse_search_page.return_value = False
        with self.assertRaisesRegex(RuntimeError, "alipay_not_foreground"):
            r.run_poco(mock.Mock())
        self.assertFalse(any(call.args[0][:3] == ["shell", "am", "force-stop"] for call in r.adb.call_args_list))
        r.query_once_poco.assert_not_called()

    def test_preparation_rpc_failure_is_explicitly_tagged_before_input(self):
        r = self.runner(pageRecoveryStage="continue_query")
        r.poco_try_reuse_search_page.side_effect = RuntimeError("poco_rpc_failed:read timeout")
        with self.assertRaisesRegex(RuntimeError, "^poco_query_page_recovery_prepare_failed:poco_rpc_failed:"):
            r.run_poco(mock.Mock())
        r.query_once_poco.assert_not_called()
        self.assertFalse(any(call.args[0][:3] == ["shell", "am", "force-stop"] for call in r.adb.call_args_list))

    def test_post_input_failure_is_never_tagged_as_preparation(self):
        r = self.runner(pageRecoveryStage="continue_query")
        r.query_once_poco.side_effect = RuntimeError("poco_query_result_channel_timeout_after_input:timeout")
        with self.assertRaisesRegex(RuntimeError, "^poco_query_result_channel_timeout_after_input:"):
            r.run_poco(mock.Mock())

    def test_background_alipay_under_notification_shade_is_not_search_ready(self):
        r = self.runner()
        r.focus.return_value = [
            "mCurrentFocus=null",
            "mCurrentFocus=Window{abc u0 NotificationShade type=2040}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/MainSearchActivity}",
        ]
        r.poco_search_ready = lookup.Runner.poco_search_ready.__get__(r)
        r.poco_unique = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "search_not_foreground|keyguard_blocking_poco"):
            r.poco_search_ready(mock.Mock())
        r.poco_unique.assert_not_called()

    def test_exact_notification_shade_collapses_once_and_rechecks_foreground(self):
        r = self.runner()
        r.focus.side_effect = [
            ["mCurrentFocus=null", "mCurrentFocus=Window{abc u0 NotificationShade type=2040}"],
            ["mCurrentFocus=Window{def u0 com.eg.android.AlipayGphone/.AlipayLogin}"],
        ]
        self.assertTrue(r.dismiss_notification_shade_if_present())
        r.adb.assert_called_once_with(["shell", "cmd", "statusbar", "collapse"], timeout=5)

    def test_unknown_or_ambiguous_system_overlay_cannot_be_collapsed(self):
        for lines in [["mCurrentFocus=Window{abc u0 PermissionDialog type=2040}"],
                      ["mCurrentFocus=Window{abc u0 NotificationShade type=2040}",
                       "mCurrentFocus=Window{def u0 other.app/.Activity}"],
                      ["mCurrentFocus=null"]]:
            r = self.runner()
            r.focus.return_value = lines
            self.assertFalse(r.dismiss_notification_shade_if_present())
            r.adb.assert_not_called()

    def test_underlying_verification_blocks_restart_after_shade_collapse(self):
        r = self.runner()
        r.dismiss_notification_shade_if_present = mock.Mock(return_value=True)
        r.poco_verification_evidence.return_value = {"kind": "verification"}
        with self.assertRaisesRegex(RuntimeError, "human_verification_required"):
            r.run_poco(mock.Mock())
        self.assertFalse(any(call.args[0][:3] == ["shell", "am", "force-stop"] for call in r.adb.call_args_list))

    def test_focus_parser_does_not_use_background_apps_or_prefix_packages(self):
        self.assertEqual(lookup.focused_window_name([
            "mCurrentFocus=null", "mCurrentFocus=Window{abc u0 NotificationShade type=2040}",
            "mFocusedApp=ActivityRecord{def u0 com.eg.android.AlipayGphone/MainSearchActivity}"]), "NotificationShade")
        self.assertIsNone(lookup.focused_window_name(["mCurrentFocus=bad"] ))

    def test_collapse_failure_does_not_repeat_or_enter_query(self):
        r = self.runner()
        r.focus.return_value = ["mCurrentFocus=Window{abc u0 NotificationShade type=2040}"]
        def adb(args, **kw):
            if args[:3] == ["shell", "cmd", "statusbar"]:
                raise RuntimeError("collapse_failed")
            return "device" if args == ["get-state"] else "package:fake"
        r.adb.side_effect = adb
        with self.assertRaisesRegex(RuntimeError, "collapse_failed"):
            r.run_poco(mock.Mock())
        self.assertEqual(len([c for c in r.adb.call_args_list if c.args[0][:3] == ["shell", "cmd", "statusbar"]]), 1)
        r.query_once_poco.assert_not_called()

    def test_collapse_requires_a_new_known_window_not_an_empty_focus(self):
        r = self.runner()
        r.focus.side_effect = [["mCurrentFocus=Window{abc u0 NotificationShade type=2040}"], ["mCurrentFocus=null"]]
        with mock.patch.object(lookup.time, "monotonic", side_effect=[0.0, 0.1, 3.0]), mock.patch.object(lookup.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "collapse_unconfirmed"):
                r.dismiss_notification_shade_if_present()
        r.adb.assert_called_once_with(["shell", "cmd", "statusbar", "collapse"], timeout=5)

    def test_similar_package_name_cannot_be_search_foreground(self):
        r = self.runner()
        r.poco_search_ready = lookup.Runner.poco_search_ready.__get__(r)
        r.focus.return_value = ["mCurrentFocus=Window{abc u0 com.eg.android.AlipayGphone.fake/MainSearchActivity}"]
        r.poco_unique = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "search_not_foreground|keyguard_blocking_poco"):
            r.poco_search_ready(mock.Mock())
        r.poco_unique.assert_not_called()

    def test_restriction_and_login_cannot_be_restarted_away(self):
        for field, error in [("poco_raise_if_login_required", "login_required"),
                             ("poco_raise_if_account_restricted", "alipay_account_restriction_before_search:device_risk")]:
            r = self.runner()
            getattr(r, field).side_effect = RuntimeError(error)
            with self.assertRaisesRegex(RuntimeError, error):
                r.run_poco(mock.Mock())
            r.poco_prepare_full_path.assert_not_called()

    def test_unknown_hierarchy_does_not_trigger_blind_restart(self):
        r = self.runner()
        poco = mock.Mock()
        poco.freeze.side_effect = TimeoutError("unknown UI")
        with self.assertRaises(TimeoutError):
            r.run_poco(poco)
        r.poco_prepare_full_path.assert_not_called()

    def test_invalid_number_or_resume_cannot_restart(self):
        for payload, error in [({"phoneNumber": "invalid"}, "invalid_phone_number"),
                               ({"operation": "query_resume"}, "page_recovery_operation_invalid")]:
            r = self.runner(**payload)
            with self.assertRaisesRegex(RuntimeError, error):
                r.run_poco(mock.Mock())
            r.poco_prepare_full_path.assert_not_called()

    def test_clear_failure_is_not_mislabelled_as_after_input(self):
        r = self.runner()
        r.poco_tap = mock.Mock()
        r.focused_search_input_length = mock.Mock(side_effect=[11, None])
        r.clear_focused_search_input = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "poco_query_before_input_failed:.*editableLength=None"):
            lookup.Runner.query_once_poco(r, mock.Mock(), "13800138000")
        self.assertFalse(any("input_phone" == call.args[0] for call in r.emit.call_args_list))

    def test_page_lost_during_wait_cannot_send_digits(self):
        r = self.runner()
        r.poco_search_ready = mock.Mock(side_effect=[mock.Mock(), RuntimeError("poco_alipay_search_not_foreground")])
        r.poco_tap = mock.Mock()
        r.focused_search_input_length = mock.Mock(return_value=0)
        r.poco_nodes = mock.Mock(return_value=[mock.Mock()])
        r.wait_before_phone_input = mock.Mock()
        r.input_phone_humanized = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "poco_query_before_input_failed"):
            lookup.Runner.query_once_poco(r, mock.Mock(), "13800138000")
        r.input_phone_humanized.assert_not_called()


if __name__ == "__main__":
    unittest.main()
