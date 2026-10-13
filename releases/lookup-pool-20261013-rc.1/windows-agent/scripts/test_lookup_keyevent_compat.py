"""Offline command-boundary regressions; no ADB, phone, or account access."""
import importlib.util
import json
import pathlib
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location(
    "lookup_keyevent_compat_test",
    pathlib.Path(__file__).with_name("alipay_name_lookup.py"),
)
lookup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lookup)

# Deliberately synthetic, not taken from a user batch or an account.
SYNTHETIC_PHONE = "1" + "0123456789"
EXPECTED_DIGIT_KEYS = ["8", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16"]


class KeyeventCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.no_subprocess = mock.patch.object(
            lookup.subprocess, "run", side_effect=AssertionError("no real subprocess allowed"),
        )
        self.no_subprocess.start()
        self.addCleanup(self.no_subprocess.stop)
        self.runner = lookup.Runner({"serial": "SYNTHETIC", "taskId": "keyevent-compat"})
        self.runner.adb = mock.Mock(return_value="")
        self.runner.emit = mock.Mock()

    def test_digits_are_exactly_eleven_numeric_keycodes_without_options(self):
        with mock.patch.object(lookup.random, "randint", return_value=117):
            self.runner.input_phone_humanized(SYNTHETIC_PHONE, "synthetic", driver="poco")
        self.runner.adb.assert_called_once_with(
            ["shell", "input", "keyevent", *EXPECTED_DIGIT_KEYS], timeout=8,
        )

    def test_clear_is_only_move_end_and_twenty_four_deletes(self):
        with mock.patch.object(lookup.random, "randint", return_value=82):
            self.runner.clear_focused_search_input()
        self.runner.adb.assert_called_once_with(
            ["shell", "input", "keyevent", "123", *(["67"] * 24)], timeout=8,
        )

    def test_old_parser_would_receive_only_intended_keys_not_delay_keycodes(self):
        # The legacy parser consumes every remaining token as a key code.
        # Its unknown-option mapping is represented here to expose the old bug.
        def legacy_keys(command):
            return [int(arg) if arg.isdecimal() else 0 for arg in command[3:]]

        with mock.patch.object(lookup.random, "randint", return_value=117):
            self.runner.input_phone_humanized(SYNTHETIC_PHONE, "synthetic")
        self.assertEqual(legacy_keys(self.runner.adb.call_args.args[0]),
                         [8, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
        self.runner.adb.reset_mock()
        with mock.patch.object(lookup.random, "randint", return_value=82):
            self.runner.clear_focused_search_input()
        self.assertEqual(legacy_keys(self.runner.adb.call_args.args[0]), [123] + [67] * 24)

    def test_invalid_or_non_ascii_phone_fails_before_any_command(self):
        for value in (None, True, 123, b"123", [], "", "0" * 11,
                      "1" + "0" * 9, "1" + "0" * 11,
                      " " + SYNTHETIC_PHONE, SYNTHETIC_PHONE + "\n",
                      "１" + "０" * 10, "1" + "٠" * 10,
                      "--longpress 26", SYNTHETIC_PHONE + "; input keyevent 26"):
            with self.subTest(value_type=type(value).__name__):
                with self.assertRaisesRegex(RuntimeError, "^invalid_phone_number$"):
                    self.runner.input_phone_humanized(value, "synthetic")
                self.runner.adb.assert_not_called()
                self.runner.emit.assert_not_called()

    def test_input_timeout_is_preserved_without_retry(self):
        self.runner.input_phone_humanized(SYNTHETIC_PHONE, "synthetic", timeout=5)
        self.runner.adb.assert_called_once_with(
            ["shell", "input", "keyevent", *EXPECTED_DIGIT_KEYS], timeout=5,
        )

    def test_input_failure_is_propagated_without_retry_or_success_event(self):
        self.runner.adb.side_effect = RuntimeError("synthetic_adb_failure")
        with self.assertRaisesRegex(RuntimeError, "^synthetic_adb_failure$"):
            self.runner.input_phone_humanized(SYNTHETIC_PHONE, "synthetic")
        self.assertEqual(self.runner.adb.call_count, 1)
        self.runner.emit.assert_not_called()

    def test_clear_failure_is_propagated_without_retry_or_success_event(self):
        self.runner.adb.side_effect = RuntimeError("synthetic_adb_failure")
        with self.assertRaisesRegex(RuntimeError, "^synthetic_adb_failure$"):
            self.runner.clear_focused_search_input()
        self.assertEqual(self.runner.adb.call_count, 1)
        self.runner.emit.assert_not_called()

    def test_events_describe_default_pacing_without_phone_or_command(self):
        self.runner.input_phone_humanized(SYNTHETIC_PHONE, "synthetic", driver="poco")
        self.runner.clear_focused_search_input()
        events = self.runner.emit.call_args_list
        self.assertEqual([call.args[0] for call in events], ["input_phone", "clear_previous_query"])
        self.assertEqual([call.kwargs["keyCount"] for call in events], [11, 25])
        for call in events:
            self.assertEqual(call.kwargs["keyDelayMs"], 0)
            self.assertEqual(call.kwargs["keyDelayMode"], "android_default")
            self.assertNotIn(SYNTHETIC_PHONE, json.dumps(call.kwargs))
            self.assertNotIn("command", call.kwargs)


if __name__ == "__main__":
    unittest.main()
