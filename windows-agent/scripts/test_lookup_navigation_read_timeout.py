import unittest
from unittest import mock
import alipay_name_lookup as lookup


class NavigationReadTimeoutTests(unittest.TestCase):
    def runner(self, operation="query"):
        r = lookup.Runner({"serial": "fixture", "operation": operation,
                           "phoneNumber": "13800000000"})
        r.emit = mock.Mock()
        r.adb = mock.Mock(side_effect=lambda args, **kw:
                          "device" if args == ["get-state"] else "package:fixture")
        r.assert_known_account = mock.Mock()
        r.poco_try_reuse_search_page = mock.Mock(return_value=True)
        r.query_once_poco = mock.Mock(return_value={"realNameTailCharacter": "甲"})
        return r

    def test_real_navigation_rpc_read_timeout_is_proven_before_input(self):
        r = self.runner()
        r.poco_try_reuse_search_page.side_effect = RuntimeError(
            "poco_rpc_failed:HTTPConnectionPool(host='127.0.0.1', port=1): "
            "Read timed out. (read timeout=2.0)")
        with self.assertRaisesRegex(RuntimeError, "^poco_query_before_input_failed:"):
            r.run_poco(mock.Mock())
        r.query_once_poco.assert_not_called()
        self.assertFalse(any(c.args[0][:3] == ["shell", "am", "force-stop"]
                             for c in r.adb.call_args_list))

    def test_non_read_errors_and_protected_states_keep_original_reason(self):
        reasons = ["poco_alipay_human_verification_required",
                   "poco_alipay_login_required", "alipay_account_restriction_before_search:limit",
                   "poco_rpc_failed:connection refused", "poco_selector_missing:home",
                   "local_lookup_result_unconfirmed:adb_read_unavailable"]
        for reason in reasons:
            with self.subTest(reason=reason):
                r = self.runner()
                r.poco_try_reuse_search_page.side_effect = RuntimeError(reason)
                with self.assertRaises(RuntimeError) as raised:
                    r.run_poco(mock.Mock())
                self.assertEqual(str(raised.exception), reason)
                r.query_once_poco.assert_not_called()

    def test_missing_foreground_is_not_transport_proof(self):
        r = self.runner()
        r.poco_try_reuse_search_page.return_value = False
        with self.assertRaisesRegex(RuntimeError, "^poco_query_search_page_unavailable_before_input$"):
            r.run_poco(mock.Mock())
        r.query_once_poco.assert_not_called()

    def test_resume_never_repeats_navigation_or_receives_preinput_marker(self):
        r = self.runner("query_resume")
        r.query_once_poco.side_effect = RuntimeError("poco_rpc_failed:Read timed out")
        with self.assertRaisesRegex(RuntimeError, "^poco_rpc_failed:"):
            r.run_poco(mock.Mock())
        r.poco_try_reuse_search_page.assert_not_called()

    def test_query_reader_failure_is_not_relabelled_as_before_input(self):
        r = self.runner()
        r.query_once_poco.side_effect = RuntimeError("poco_rpc_failed:Read timed out")
        with self.assertRaisesRegex(RuntimeError, "^poco_rpc_failed:"):
            r.run_poco(mock.Mock())
        r.query_once_poco.assert_called_once()


if __name__ == "__main__":
    unittest.main()
