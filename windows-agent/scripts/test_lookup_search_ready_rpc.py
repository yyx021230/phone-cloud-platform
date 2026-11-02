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
