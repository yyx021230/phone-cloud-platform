import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import test_lookup_cold_restriction as fixtures
lookup = fixtures.lookup

class ColdAccessDeniedTests(unittest.TestCase):
    def runner(self, **payload):
        r = fixtures.ColdRestrictionTests().runner(**payload)
        root = ET.Element('hierarchy')
        for text in ('访问被拒绝', '请检查是否使用了代理软件或VPN'):
            ET.SubElement(root, 'node', {'text': text})
        r.dump.return_value = (root, {})
        return r

    def test_unrecorded_denial_identifies_actual_account_before_cooldown_ack(self):
        r = self.runner()
        with self.assertRaisesRegex(RuntimeError, 'restriction_before_search:access_denied'):
            r.prepare_available_account()
        self.assertTrue(r.account_identity_verified)
        self.assertEqual(r.current_account_after_switch, 'A')
        r.open_account_picker.assert_called_once_with('restricted-startup-identity')
        r.launch.assert_not_called();r.switch_account.assert_not_called();r.open_search.assert_not_called()
        self.assertFalse(r.emit.call_args.kwargs['phoneQueryStarted'])

    def test_existing_cooldown_uses_current_marker_then_rotates_without_rerecording(self):
        for make in [self.runner, fixtures.ColdRestrictionTests().runner]:
            with self.subTest(make=make.__name__):
                cooldown=[{'account':'A','cooldownUntil':'2099-01-01T00:00:00Z'}]
                r=make(accountCooldowns=cooldown)
                r.raise_account_restriction=mock.Mock(side_effect=AssertionError('must not refresh existing cooldown'))
                r.prepare_available_account()
                self.assertEqual(r.payload['accountCooldowns'],cooldown)
                self.assertEqual(r.open_account_picker.call_args_list,[mock.call('restricted-startup-identity')])
                r.launch.assert_not_called()
                r.switch_account.assert_called_once_with(reason='cooldown',excluded_accounts={'A'},reuse_open_picker=True,verify_current_marker=True)
                r.open_search.assert_called_once_with('account-preflight-switch-complete')

    def test_missing_or_different_hint_never_enters_identity_navigation(self):
        for evidence in [{'reason':'access_denied','title':'访问被拒绝','hint':''},
                         {'reason':'access_denied','title':'其他提示','hint':'请检查是否使用了代理软件或VPN'},
                         {'reason':'device_risk','title':'访问被拒绝','hint':'请检查是否使用了代理软件或VPN'}]:
            r=self.runner();r.account_restriction_evidence=mock.Mock(return_value=evidence)
            expected='alipay_startup_device_risk' if evidence['reason']=='device_risk' else 'identity_unverified'
            with self.assertRaisesRegex(RuntimeError,expected):r.prepare_available_account()
            r.exit_search_activity_for_account_navigation.assert_not_called();r.open_account_picker.assert_not_called()

    def test_denial_in_foreign_or_ambiguous_window_never_navigates(self):
        for focus in ['mCurrentFocus=null','mCurrentFocus=Window{x u0 other.app/.Page}', 'mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/.Dialog}']:
            r=self.runner();r.focus_state.return_value=([],focus,'')
            with self.assertRaisesRegex(RuntimeError,'identity_unverified'):r.prepare_available_account()
            r.exit_search_activity_for_account_navigation.assert_not_called();r.open_account_picker.assert_not_called()

    def test_denial_plus_real_captcha_never_rotates_even_with_cooldown(self):
        r=self.runner(accountCooldowns=[{'account':'A','cooldownUntil':'2099-01-01T00:00:00Z'}])
        r.verification_evidence=mock.Mock(return_value={'manual':True})
        with self.assertRaisesRegex(RuntimeError,'human_verification_required'):r.prepare_available_account()
        r.open_account_picker.assert_not_called();r.switch_account.assert_not_called()

    def test_current_marker_disagrees_with_cache_or_is_ambiguous_never_rotates(self):
        r=self.runner(knownAccount='OTHER',accountIdentityVerified=False)
        with self.assertRaisesRegex(RuntimeError,'identity_unverified'):r.prepare_available_account()
        r.switch_account.assert_not_called()
        r=self.runner();r.open_account_picker.return_value=fixtures.fixtures.AccountCooldownTests().rows(current='missing')
        with self.assertRaisesRegex(RuntimeError,'alipay_saved_account_'):r.prepare_available_account()
        r.switch_account.assert_not_called()

    def test_current_cooling_and_all_accounts_cooling_never_queries(self):
        r=self.runner(accountCooldowns=[{'account':a,'cooldownUntil':'2099-01-01T00:00:00Z'} for a in ['A','B']])
        with self.assertRaisesRegex(RuntimeError,'alipay_no_available_account'):r.prepare_available_account()
        r.switch_account.assert_not_called();r.open_search.assert_not_called()

if __name__=='__main__':unittest.main()
