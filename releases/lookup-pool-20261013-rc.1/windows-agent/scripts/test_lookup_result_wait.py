"""Offline timing regressions; no ADB or account access."""
import importlib.util
import pathlib
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("lookup_result_wait", pathlib.Path(__file__).with_name("alipay_name_lookup.py"))
lookup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lookup)


class ResultWaitTests(unittest.TestCase):
    def test_slow_input_does_not_consume_observation_after_single_submit(self):
        phone = "10123456789"
        clock = [100.0]
        submitted = []
        input_node = mock.Mock()
        input_node.attr.side_effect = lambda key: phone if key == "text" else ""
        confirm = mock.Mock()
        snapshot = mock.Mock()
        poco = mock.Mock()
        poco.freeze.return_value = snapshot
        runner = lookup.Runner({"serial": "SYNTHETIC"})
        runner.poco_search_ready = mock.Mock(return_value=input_node)
        runner.focused_search_input_length = mock.Mock(return_value=0)
        runner.clear_focused_search_input = mock.Mock()
        runner.wait_before_phone_input = mock.Mock()
        runner.poco_raise_if_account_restricted = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        runner.poco_dismiss_post_input_usb_warning = mock.Mock(return_value=False)
        runner.poco_nodes = mock.Mock(side_effect=lambda _snapshot, **selector:
                                     [confirm] if selector.get("name", "").endswith("search_confirm") else [input_node])
        runner.poco_tap = mock.Mock(side_effect=lambda node: submitted.append(clock[0]) if node is confirm else None)
        runner.input_phone_humanized = mock.Mock(side_effect=lambda *args, **kwargs: clock.__setitem__(0, clock[0] + 6.0))
        runner.adb = mock.Mock(return_value="")
        runner.poco_wait_for_post_query_restriction = mock.Mock(side_effect=AssertionError("not a page transition"))
        expected = {"alipayDisplayName": "*甲", "realNameTailCharacter": "甲", "matchedPhone": phone}
        runner.parse_poco_result = mock.Mock(side_effect=lambda *args:
                                            expected if submitted and clock[0] - submitted[0] >= 3.8 else None)
        with mock.patch.object(lookup.time, "time", side_effect=lambda: clock[0]), \
                mock.patch.object(lookup.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
            result = runner.query_once_poco(poco, phone)
        self.assertEqual(result, expected)
        self.assertEqual(len(submitted), 1)
        runner.input_phone_humanized.assert_called_once()
        runner.adb.assert_called_once_with(["shell", "input", "keyevent", "123"], timeout=5)


if __name__ == "__main__":
    unittest.main()
