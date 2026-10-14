import importlib.util
import os
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location("lookup", os.path.join(os.path.dirname(__file__), "alipay_name_lookup.py"))
lookup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lookup)


class AccountCooldownTests(unittest.TestCase):
    def rows(self, accounts=("A", "B"), current="A"):
        return [(name, name == current, ET.Element("node", {"bounds": "[0,0][100,100]"})) for name in accounts]

    def runner(self, **extra):
        r = lookup.Runner({"serial": "SYNTHETIC", "operation": "start", "accountCooldownProtocol": 1, **extra})
        r.adb = mock.Mock(return_value="device")
        r.dump = mock.Mock(return_value=(ET.Element("hierarchy"), {}))
        r.dismiss_canvas_real_name_prompt = mock.Mock(return_value=False)
        r.launch = mock.Mock()
        r.open_account_picker = mock.Mock(return_value=self.rows())
        r.open_search = mock.Mock()
        r.emit = mock.Mock()
        r.switch_account = mock.Mock()
        return r

    def test_current_eligible_account_is_identified_before_search_without_a_query(self):
        r = self.runner()
        result = r.prepare_available_account()
        self.assertEqual(result["currentAccount"], "A")
        self.assertTrue(result["accountIdentityVerified"])
        r.switch_account.assert_not_called()
        r.open_search.assert_called_once()
        r.adb.assert_not_called()

    def test_only_one_saved_account_is_a_valid_identity(self):
        self.assertEqual(lookup.Runner.saved_account_choices(self.rows(("A",))), [{"account": "A", "current": True}])

    def test_duplicate_or_unknown_current_account_is_not_all_cooling(self):
        for rows in [self.rows(("A", "A")), self.rows(current="missing"), []]:
            r = self.runner()
            r.open_account_picker.return_value = rows
            with self.assertRaisesRegex(RuntimeError, "alipay_saved_account_"):
                r.prepare_available_account()
            r.switch_account.assert_not_called()
            r.open_search.assert_not_called()

    def test_all_saved_cooling_stops_without_switching_or_input(self):
        r = self.runner(accountCooldowns=[{"account": name, "cooldownUntil": "2099-01-01T00:00:00Z"} for name in ("A", "B")])
        with self.assertRaisesRegex(RuntimeError, "alipay_no_available_account"):
            r.prepare_available_account()
        self.assertEqual(len(r.saved_accounts), 2)
        r.switch_account.assert_not_called()
        r.open_search.assert_not_called()
        r.adb.assert_not_called()

    def test_cooling_current_is_skipped_and_switch_requires_actual_marker_verification(self):
        r = self.runner(accountCooldowns=[{"account": "A", "cooldownUntil": "2099-01-01T00:00:00Z"}])
        r.prepare_available_account()
        r.switch_account.assert_called_once_with(reason="cooldown", excluded_accounts={"A"}, reuse_open_picker=True, verify_current_marker=True)

    def test_expiry_makes_account_eligible_without_erasing_record(self):
        rows = [{"account": "A", "cooldownUntil": "2020-01-01T00:00:00Z"}]
        r = self.runner(accountCooldowns=rows)
        self.assertEqual(r.prepare_available_account()["currentAccount"], "A")
        self.assertEqual(r.payload["accountCooldowns"], rows)
        r.switch_account.assert_not_called()

    def test_invalid_cooldown_never_silently_allows_a_query(self):
        for value in ["bad", "2099-01-01"]:
            with self.assertRaisesRegex(RuntimeError, "cooldown_data_invalid"):
                self.runner(accountCooldowns=[{"account": "A", "cooldownUntil": value}]).prepare_available_account()

    def test_plain_slider_is_handled_without_mislabeling_as_jigsaw(self):
        r = self.runner()
        root = ET.Element("hierarchy")
        for text in (lookup.VERIFICATION_TITLE, lookup.VERIFICATION_ACTION):
            ET.SubElement(root, "node", {"text": text})
        r.dump.return_value = (root, {})
        r.solve_human_verification = mock.Mock(return_value=(ET.Element("hierarchy"), {}))
        self.assertFalse(r.verification_evidence(root)["manual"])
        self.assertEqual(r.prepare_available_account()["currentAccount"], "A")
        r.solve_human_verification.assert_called_once()

    def test_visible_puzzle_cannot_be_dismissed_by_account_preflight(self):
        r = self.runner()
        r.verification_evidence = mock.Mock(return_value={"kind": "jigsaw_verification"})
        with self.assertRaisesRegex(RuntimeError, "human_verification_required"):
            r.prepare_available_account()
        r.launch.assert_not_called()
        r.open_account_picker.assert_not_called()

    def test_restriction_feedback_is_not_a_puzzle_and_cooling_account_can_rotate(self):
        r = self.runner(knownAccount="A", accountIdentityVerified=True,
                        savedAccounts=[{"account": "A", "current": True}],
                        accountCooldowns=[{"account": "A", "cooldownUntil": "2099-01-01T00:00:00Z"}])
        root = ET.Element("hierarchy")
        for text in (lookup.FREQUENT_OR_ABNORMAL_ACCESS_TITLE,
                     lookup.FREQUENT_OR_ABNORMAL_ACCESS_HINT, "反馈码: synthetic"):
            ET.SubElement(root, "node", {"text": text})
        r.dump.return_value = (root, {})
        self.assertIsNone(r.verification_evidence(root))
        self.assertEqual(r.account_restriction_evidence(root)["reason"], "frequent_or_abnormal_access")
        r.prepare_available_account()
        r.switch_account.assert_called_once_with(reason="cooldown", excluded_accounts={"A"},
                                                reuse_open_picker=True, verify_current_marker=True)

    def test_real_puzzle_with_shared_feedback_still_blocks_rotation(self):
        r = self.runner()
        root = ET.Element("hierarchy")
        for text in (lookup.VERIFICATION_TITLE, lookup.JIGSAW_VERIFICATION_ACTION, "反馈码: synthetic"):
            ET.SubElement(root, "node", {"text": text})
        r.dump.return_value = (root, {})
        with self.assertRaisesRegex(RuntimeError, "human_verification_required"):
            r.prepare_available_account()
        r.launch.assert_not_called()
        r.switch_account.assert_not_called()

    def test_visible_pre_input_restriction_keeps_verified_account_and_phase(self):
        r = self.runner(knownAccount="A", accountIdentityVerified=True,
                        savedAccounts=[{"account": "A", "current": True}])
        r.account_restriction_evidence = mock.Mock(return_value={"reason": "frequent_or_abnormal_access"})
        with self.assertRaisesRegex(RuntimeError, "restriction_before_search:frequent_or_abnormal_access"):
            r.prepare_available_account()
        r.launch.assert_not_called()
        r.open_account_picker.assert_not_called()
        event = r.emit.call_args.kwargs
        self.assertFalse(event["phoneQueryStarted"])
        self.assertTrue(event["accountIdentityVerified"])
        self.assertTrue(event["accountSwitchRequired"])
        self.assertEqual(event["currentAccount"], "A")

    def test_visible_restriction_with_unknown_account_never_assigns_cooldown_or_navigates(self):
        r = self.runner()
        r.account_restriction_evidence = mock.Mock(return_value={"reason": "device_risk"})
        with self.assertRaisesRegex(RuntimeError, "identity_unverified"):
            r.prepare_available_account()
        r.launch.assert_not_called()
        r.open_account_picker.assert_not_called()

    def test_unknown_cached_identity_fails_before_input(self):
        r = self.runner(knownAccount="A", accountIdentityVerified=False)
        with self.assertRaisesRegex(RuntimeError, "identity_unverified"):
            r.assert_known_account()
        r.adb.assert_not_called()

    def test_current_cooling_is_rechecked_at_execution(self):
        r = self.runner(knownAccount="A", accountIdentityVerified=True,
                        savedAccounts=[{"account": "A", "current": True}],
                        accountCooldowns=[{"account": "A", "cooldownUntil": "2099-01-01T00:00:00Z"}])
        with self.assertRaisesRegex(RuntimeError, "preflight_required"):
            r.assert_known_account()
        r.adb.assert_not_called()

    def test_ordinary_xml_recovery_keeps_verified_account_and_opens_search_directly(self):
        r = self.runner(operation="query", phoneNumber="10123456789", maxRecoveryAttempts=1,
                        knownAccount="A", accountIdentityVerified=True,
                        savedAccounts=[{"account": "A", "current": True}])
        r.query_once = mock.Mock(side_effect=[RuntimeError("selector_missing:search"), {"notFound": True}])
        r.prepare_available_account = mock.Mock(side_effect=AssertionError("account preflight on ordinary retry"))
        result = r.run()
        self.assertTrue(result["ok"])
        self.assertEqual(result["currentAccount"], "A")
        self.assertTrue(result["accountIdentityVerified"])
        self.assertEqual(result["recoveryAttempts"], 1)
        self.assertEqual(r.query_once.call_count, 2)
        r.launch.assert_called_once_with("query-recovery-1")
        r.open_search.assert_called_once_with("query-recovery-1")
        r.open_account_picker.assert_not_called()
        r.prepare_available_account.assert_not_called()

    def test_xml_human_or_account_limit_never_enters_ordinary_search_recovery(self):
        for error in ("alipay_human_verification_required:jigsaw_verification",
                      "alipay_account_restriction_before_search:device_risk"):
            with self.subTest(error=error):
                r = self.runner(operation="query", phoneNumber="10123456789", knownAccount="A",
                                accountIdentityVerified=True, savedAccounts=[{"account": "A", "current": True}])
                r.query_once = mock.Mock(side_effect=RuntimeError(error))
                with self.assertRaisesRegex(RuntimeError, error):
                    r.run()
                r.launch.assert_not_called()
                r.open_search.assert_not_called()
                r.open_account_picker.assert_not_called()
                r.switch_account.assert_not_called()


if __name__ == "__main__":
    unittest.main()
