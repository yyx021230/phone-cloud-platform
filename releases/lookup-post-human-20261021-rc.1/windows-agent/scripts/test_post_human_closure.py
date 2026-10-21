"""Local mocked state transitions: no ADB, screenshots, input or accounts."""
import unittest
from unittest import mock
from alipay_post_human_state import classify_post_human_page
from alipay_name_lookup import Runner, ALIPAY_PACKAGE, ALIPAY_LOGIN_ACTIVITY

class PostHumanClosure(unittest.TestCase):
    def runner(self, texts=(), focus=None, inputs=1, result=None, **payload):
        r=Runner({'serial':'synthetic','operation':'post_human_check','accountCooldownProtocol':1,'knownAccount':'A','accountIdentityVerified':True,'savedAccounts':[{'account':'A','current':True}],'phoneNumber':'13800000000',**payload})
        r.focus=mock.Mock(return_value=[focus or 'mCurrentFocus=Window{a u0 com.eg.android.AlipayGphone/.SearchActivity}'])
        r.poco_snapshot_texts=mock.Mock(return_value=list(texts))
        n=mock.Mock();n.attr.side_effect=lambda k:"13800000000" if k=="text" else True
        r.poco_nodes=mock.Mock(side_effect=lambda _s,**kw:[n]*inputs if kw.get('name') else [])
        r.parse_poco_result=mock.Mock(return_value=result)
        r.adb=mock.Mock(side_effect=AssertionError('No ADB action'))
        r.poco_tap=mock.Mock(side_effect=AssertionError('No tap'))
        return r
    def test_protected_states(self):
        cases=[(['您请求次数过于频繁','待会来试试','刷新'],'account_limited'),(['短信验证码登录','其他验证方式','遇到问题'],'login_required'),(['加载中...'],'loading'),(['网络不给力','重试'],'network_busy'),(['账户尚未实名认证','立即认证'],'recoverable_page')]
        for texts,state in cases:
            self.assertEqual(classify_post_human_page(texts,input_ready=True),state)
            r=self.runner(texts,operation='human_probe');self.assertEqual(r.run_poco(mock.Mock())['verificationState'],state);r.adb.assert_not_called()
    def test_fresh_limit_is_raised_before_query(self):
        r=self.runner(['您请求次数过于频繁','待会来试试','刷新'])
        with self.assertRaisesRegex(RuntimeError,'alipay_account_restriction_switch_required'):r.run_poco(mock.Mock())
        r.adb.assert_not_called();r.parse_poco_result.assert_not_called()
    def test_exact_login_focus_without_text(self):
        r=self.runner(focus='mCurrentFocus=Window{a u0 '+ALIPAY_PACKAGE+'/'+ALIPAY_LOGIN_ACTIVITY+'}')
        with self.assertRaisesRegex(RuntimeError,'poco_alipay_login_required'):r.run_poco(mock.Mock())
    def test_unknown_foreground_and_loading_do_not_trigger_input(self):
        for kwargs in [{'inputs':0},{'texts':['加载中...']},{'focus':'mCurrentFocus=Window{a other/app}'}]:
            r=self.runner(**kwargs)
            with self.assertRaisesRegex(RuntimeError,'local_lookup_result_unconfirmed:post_human_'):r.run_poco(mock.Mock())
            r.adb.assert_not_called();r.parse_poco_result.assert_not_called()
    def test_startup_unknown_identity_keeps_limit_for_real_account_preflight(self):
        r=self.runner(['您请求次数过于频繁','待会来试试','刷新'],postHumanStartup=True,accountIdentityVerified=False,knownAccount='',savedAccounts=[])
        out=r.run_poco(mock.Mock());self.assertEqual(out['postHumanState'],'account_limited');self.assertFalse(out['accountIdentityVerified']);r.adb.assert_not_called()
    def test_positive_result_has_no_reinput(self):
        r=self.runner(result={'realNameTailCharacter':'名','matchedPhone':'13800000000'})
        out=r.run_poco(mock.Mock());self.assertTrue(out['postHumanResult']);r.adb.assert_not_called();r.poco_tap.assert_not_called()
    def test_puzzle_reappearing_wins_over_stale_limit(self):
        r=self.runner(['请拖动滑块完成拼图','您请求次数过于频繁','待会来试试','刷新'])
        with self.assertRaisesRegex(RuntimeError,'human_verification_required'):r.run_poco(mock.Mock())
    def test_hierarchy_read_failure_is_explicit_not_clear(self):
        r=self.runner();p=mock.Mock();p.freeze.side_effect=RuntimeError('timeout')
        with self.assertRaisesRegex(RuntimeError,'post_human_read_failed'):r.run_poco(p)
if __name__=='__main__':unittest.main()
