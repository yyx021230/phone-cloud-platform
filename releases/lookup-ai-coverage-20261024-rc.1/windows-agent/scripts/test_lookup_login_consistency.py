import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import alipay_name_lookup as lookup

class LoginConsistency(unittest.TestCase):
    def test_xml_and_poco_classify_same_carrier_and_sms_login(self):
        for labels in [('本机号码一键登录','同意支付宝向运营商获取完整本机号码','换号'),('短信验证码登录','其他验证方式','遇到问题')]:
            r=lookup.Runner({'serial':'SYNTHETIC'});r.emit=mock.Mock();root=ET.Element('hierarchy')
            for text in labels:ET.SubElement(root,'node',{'text':text})
            with self.assertRaisesRegex(RuntimeError,'poco_alipay_login_required'):r.page_overlay_protected('test',root=root)
            r.poco_snapshot_texts=mock.Mock(return_value=labels)
            with self.assertRaisesRegex(RuntimeError,'poco_alipay_login_required'):r.poco_raise_if_login_required(object(),'test')
    def test_exact_guide_focus_is_login_normal_launcher_is_not(self):
        r=lookup.Runner({'serial':'SYNTHETIC'});r.emit=mock.Mock()
        with self.assertRaisesRegex(RuntimeError,'poco_alipay_login_required'):r.poco_raise_if_login_focus('mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/com.ali.user.mobile.loginupgrade.activity.GuideActivity}','test')
        r.poco_raise_if_login_focus('mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/com.eg.android.AlipayGphone.AlipayLogin}','test')
    def test_partial_login_word_does_not_mark_account_offline(self):
        self.assertEqual(lookup.Runner.login_surface(['换号','登录其他账号']),'')
