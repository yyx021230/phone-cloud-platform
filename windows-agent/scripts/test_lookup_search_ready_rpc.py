import subprocess
import unittest
from unittest import mock

import alipay_name_lookup as lookup


class SearchReadyRpcTests(unittest.TestCase):
    def runner(self):
        runner = lookup.Runner({"serial": "fixture"})
        focus = lookup.ALIPAY_PACKAGE + "/.MainSearchActivity"
        runner.focus_state = mock.Mock(return_value=([], focus, focus))
        runner.emit = mock.Mock()
        return runner

    def test_failed_channel_is_not_read_again_before_existing_recovery(self):
        runner = self.runner()
        poco = mock.Mock()
        original = TimeoutError("fixture hierarchy deadline")
        poco.freeze.side_effect = original
        runner.recover_page_mismatch = mock.Mock(return_value=False)
        runner.poco_raise_if_account_restricted = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "^poco_rpc_failed:") as caught:
            runner.poco_search_ready(poco)
        self.assertIs(caught.exception.__cause__, original)
        poco.freeze.assert_called_once()
        runner.recover_page_mismatch.assert_called_once_with(
            "poco-unreadable:['name']", poco=poco, unreadable=True)
        runner.poco_raise_if_account_restricted.assert_not_called()

    def test_failed_frame_then_window_timeout_does_not_read_failed_channel_again(self):
        runner = self.runner()
        poco = mock.Mock()
        poco.freeze.side_effect = TimeoutError("fixture hierarchy deadline")
        window_failure = RuntimeError("poco_android_window_service_timeout")
        runner.recover_page_mismatch = mock.Mock(side_effect=window_failure)
        runner.poco_raise_if_account_restricted = mock.Mock()
        with self.assertRaises(RuntimeError) as caught:
            runner.poco_search_ready(poco)
        self.assertIs(caught.exception, window_failure)
        poco.freeze.assert_called_once()
        runner.poco_raise_if_account_restricted.assert_not_called()
        runner.emit.assert_any_call("poco_search_ready_failed_channel_deferred", driver="poco")

    def test_window_failure_reports_separate_original_and_bounded_read_costs(self):
        runner = self.runner()
        first = subprocess.TimeoutExpired(["fixture"], 10)
        second = subprocess.TimeoutExpired(["fixture"], 3)
        runner.adb = mock.Mock(side_effect=[first, second])
        with mock.patch.object(lookup.time, "perf_counter", side_effect=[0, 10, 10, 13]):
            with self.assertRaisesRegex(RuntimeError, "^poco_android_window_service_timeout$") as caught:
                runner.focus()
        self.assertIs(caught.exception.__cause__, second)
        self.assertEqual(runner.adb.call_count, 2)
        self.assertEqual(runner.adb.call_args_list[0].kwargs["timeout"], 10)
        self.assertEqual(runner.adb.call_args_list[1].kwargs["timeout"], 3)
        events = {call.args[0]: call.kwargs for call in runner.emit.call_args_list}
        self.assertEqual(events["android_window_service_read_timeout"]["durationMs"], 10000)
        self.assertEqual(events["android_window_service_recovery_failed"]["durationMs"], 3000)
        self.assertNotIn("stdout", events["android_window_service_recovery_failed"])

    def test_missing_selector_still_checks_restriction(self):
        runner = self.runner()
        poco = mock.Mock()
        runner.poco_unique = mock.Mock(side_effect=RuntimeError("poco_selector_missing:fixture"))
        runner.solve_verification_from_xml_if_present = mock.Mock(return_value=False)
        restricted = RuntimeError("alipay_account_restriction_switch_required:frequent_or_abnormal_access")
        runner.poco_raise_if_account_restricted = mock.Mock(side_effect=restricted)
        with self.assertRaises(RuntimeError) as caught:
            runner.poco_search_ready(poco)
        self.assertIs(caught.exception, restricted)
        poco.freeze.assert_called_once()

    def test_readable_input_returns_without_extra_frame(self):
        runner = self.runner()
        poco = mock.Mock()
        runner.poco_nodes = mock.Mock(return_value=[object()])
        runner.page_overlay_kind = mock.Mock(return_value=None)
        self.assertIs(runner.poco_search_ready(poco), poco.return_value)
        poco.freeze.assert_called_once()


if __name__ == "__main__":
    unittest.main()
