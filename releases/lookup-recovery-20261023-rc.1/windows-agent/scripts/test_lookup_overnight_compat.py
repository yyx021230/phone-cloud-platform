import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import alipay_name_lookup as lookup

class OvernightCompatTests(unittest.TestCase):
    def overlay_runner(self):
        r=lookup.Runner.__new__(lookup.Runner)
        r.dismiss_honor_software_update_overlay=mock.Mock(return_value=False)
        r.dismiss_vivo_wlan_risk_overlay=mock.Mock(return_value=False)
        r.focus=mock.Mock(return_value=[])
        r.dismiss_coloros_securepay_usb_dialog=mock.Mock(return_value=True)
        r.dismiss_phone_credit_promo_xml=mock.Mock(return_value=False)
        r.dismiss_real_name_prompt_xml=mock.Mock(return_value=False)
        return r

    def test_account_overlay_dispatch_uses_exact_coloros_helper_before_navigation(self):
        r=self.overlay_runner();root=ET.Element('hierarchy');parent={}
        self.assertTrue(r.dismiss_known_overlay(root,parent))
        r.dismiss_coloros_securepay_usb_dialog.assert_called_once_with(root,parent)
        r.dismiss_phone_credit_promo_xml.assert_not_called()

    def test_coloros_uncertain_dismissal_does_not_fall_through_to_underlying_home(self):
        r=self.overlay_runner();r.dismiss_coloros_securepay_usb_dialog.side_effect=RuntimeError('coloros_securepay_usb_warning_dismiss_timeout')
        with self.assertRaisesRegex(RuntimeError,'dismiss_timeout'):r.dismiss_known_overlay(ET.Element('hierarchy'),{})
        r.dismiss_phone_credit_promo_xml.assert_not_called()

    def test_cold_device_risk_has_explicit_reason_without_guessing_account_or_rotating(self):
        r=lookup.Runner.__new__(lookup.Runner);r.payload={'accountCooldownProtocol':1}
        r.focus_state=mock.Mock();r.open_account_picker=mock.Mock();r.switch_account=mock.Mock()
        with self.assertRaisesRegex(RuntimeError,'alipay_startup_device_risk'):
            r.identify_cold_search_restriction_account({'reason':'device_risk'})
        r.focus_state.assert_not_called();r.open_account_picker.assert_not_called();r.switch_account.assert_not_called()

    def test_nonempty_recommendation_text_is_not_a_proven_empty_input(self):
        r=lookup.Runner({'serial':'SYNTHETIC'})
        r.emit=mock.Mock();r.poco_raise_if_account_restricted=mock.Mock()
        r.poco_verification_evidence=mock.Mock(return_value=None)
        r.parse_poco_result=mock.Mock(return_value=None)
        r.poco_nodes=mock.Mock(return_value=[mock.Mock()])
        r.poco_text=mock.Mock(return_value='recommendation')
        r.poco_observe_result_transition=mock.Mock(return_value=None)
        r.input_phone_humanized=mock.Mock(side_effect=AssertionError('must not overwrite nonempty input'))
        r.adb=mock.Mock(side_effect=AssertionError('unexpected ADB'))
        with self.assertRaisesRegex(RuntimeError,'poco_query_resume_state_mismatch'):
            r.query_once_poco(mock.Mock(), '19900000000', resume_after_input=True)
        r.input_phone_humanized.assert_not_called()

if __name__=='__main__':unittest.main()
