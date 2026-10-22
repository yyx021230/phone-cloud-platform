import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import test_lookup_account_cooldown as fixtures
lookup = fixtures.lookup

class ColdRestrictionTests(unittest.TestCase):
    def runner(self, **payload):
        r = fixtures.AccountCooldownTests().runner(**payload)
        root = ET.Element('hierarchy')
        for text in ('您请求次数过于频繁', '待会来试试', '刷新'):
            ET.SubElement(root, 'node', {'text': text})
        r.dump.return_value = (root, {})
        r.focus_state = mock.Mock(return_value=([], 'mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}', ''))
        r.exit_search_activity_for_account_navigation = mock.Mock(return_value=('mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/com.eg.android.AlipayGphone.AlipayLogin}', ''))
        r.canvas_real_name_home_evidence = mock.Mock(return_value=True)
        return r

    def test_cold_limit_reads_current_marker_without_query_switch_or_cold_launch(self):
        r=self.runner()
        with self.assertRaisesRegex(RuntimeError, 'restriction_before_search:frequent_or_abnormal_access'):
            r.prepare_available_account()
        self.assertEqual(r.current_account_after_switch,'A')
        self.assertTrue(r.account_identity_verified)
        r.open_account_picker.assert_called_once_with('restricted-startup-identity')
        r.launch.assert_not_called();r.open_search.assert_not_called();r.switch_account.assert_not_called()
        self.assertFalse(r.emit.call_args.kwargs['phoneQueryStarted'])

    def test_foreign_or_covered_focus_never_navigates(self):
        for focus in ['mCurrentFocus=null','mCurrentFocus=Window{x u0 other.app/.Page}', 'mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/.Dialog}']:
            r=self.runner();r.focus_state.return_value=([],focus,'')
            with self.assertRaisesRegex(RuntimeError,'identity_unverified'):r.prepare_available_account()
            r.exit_search_activity_for_account_navigation.assert_not_called();r.open_account_picker.assert_not_called()

    def test_navigation_must_end_on_exact_home(self):
        r=self.runner();r.exit_search_activity_for_account_navigation.return_value=('mCurrentFocus=Window{x u0 other.app/.Page}','')
        with self.assertRaisesRegex(RuntimeError,'identity_unverified'):r.prepare_available_account()
        r.open_account_picker.assert_not_called()

    def test_home_tree_must_be_confirmed(self):
        r=self.runner();r.canvas_real_name_home_evidence.return_value=False
        with self.assertRaisesRegex(RuntimeError,'identity_unverified'):r.prepare_available_account()
        r.open_account_picker.assert_not_called()

    def test_ambiguous_marker_never_assigns_identity(self):
        r=self.runner();r.open_account_picker.return_value=fixtures.AccountCooldownTests().rows(current='missing')
        with self.assertRaisesRegex(RuntimeError,'alipay_saved_account_'):r.prepare_available_account()
        self.assertFalse(r.account_identity_verified);r.switch_account.assert_not_called()

    def test_unverified_cached_account_cannot_be_silently_reassigned(self):
        r=self.runner(knownAccount='OTHER',accountIdentityVerified=False)
        with self.assertRaisesRegex(RuntimeError,'identity_unverified'):r.prepare_available_account()
        self.assertFalse(r.account_identity_verified);r.switch_account.assert_not_called()

    def test_new_verification_after_back_blocks_picker(self):
        r=self.runner();r.verification_evidence=mock.Mock(side_effect=[None,{'manual':True}])
        with self.assertRaisesRegex(RuntimeError,'human_verification_required'):r.prepare_available_account()
        r.open_account_picker.assert_not_called()

    def test_observed_frequent_abnormal_variant_keeps_exact_identity_guards(self):
        r=self.runner()
        root=ET.Element('hierarchy')
        for text in (lookup.FREQUENT_OR_ABNORMAL_ACCESS_TITLE, lookup.FREQUENT_OR_ABNORMAL_ACCESS_HINT):
            ET.SubElement(root,'node',{'text':text})
        r.dump.return_value=(root,{})
        with self.assertRaisesRegex(RuntimeError,'restriction_before_search:frequent_or_abnormal_access'):
            r.prepare_available_account()
        self.assertTrue(r.account_identity_verified)
        r.open_account_picker.assert_called_once_with('restricted-startup-identity')
        r.launch.assert_not_called();r.open_search.assert_not_called();r.switch_account.assert_not_called()

    def test_similar_variant_or_mixed_hint_does_not_authorize_navigation(self):
        for title,hint in [('操作频繁','请稍后'),(lookup.FREQUENT_OR_ABNORMAL_ACCESS_TITLE,'待会来试试')]:
            r=self.runner()
            r.account_restriction_evidence=mock.Mock(return_value={'reason':'frequent_or_abnormal_access','title':title,'hint':hint})
            with self.assertRaisesRegex(RuntimeError,'identity_unverified'):r.prepare_available_account()
            r.exit_search_activity_for_account_navigation.assert_not_called()

if __name__=='__main__':unittest.main()
