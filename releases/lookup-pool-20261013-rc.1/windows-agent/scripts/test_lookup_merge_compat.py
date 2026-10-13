"""Merge-specific offline regressions: no real device access."""
import importlib.util
import pathlib
import unittest
from unittest import mock
spec = importlib.util.spec_from_file_location("lookup_merge_compat", pathlib.Path(__file__).with_name("alipay_name_lookup.py"))
lookup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lookup)
class MergeCompatibilityTests(unittest.TestCase):
    lookup = lookup
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
