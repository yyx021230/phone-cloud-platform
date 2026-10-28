"""Original query resume through a known overlay; simulated device I/O."""
import unittest
from unittest import mock
import alipay_name_lookup as lookup
from test_lookup_overlay_guard import clock

PHONE='19900000000'
class ResumeOverlay(unittest.TestCase):
    def fixture(self, after='name', recover=True):
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'same-query'})
        state={'closed':False,'checks':0}
        poco=mock.Mock();poco.freeze.side_effect=lambda: 'after' if state['closed'] else 'covered'
        r.emit=lambda step,**data:r.log.append({'step':step,**data})
        r.poco_nodes=lambda *a,**k:[]
        r.poco_raise_if_account_restricted=mock.Mock(side_effect=lambda snap,*a,**k: (_ for _ in ()).throw(RuntimeError('account_restriction')) if snap=='after' and after=='restricted' else None)
        r.poco_verification_evidence=lambda snap: snap=='after' and after=='captcha'
        r.poco_solve_human_verification=mock.Mock(side_effect=RuntimeError('human_verification_required'))
        r.parse_poco_result=lambda snap,phone: {'realNameTailCharacter':'甲','matchedPhone':phone} if snap=='after' and after=='name' else None
        r.emit_query_result=mock.Mock();r.input_phone_humanized=mock.Mock(side_effect=AssertionError('must not input'));r.poco_tap=mock.Mock(side_effect=AssertionError('must not tap input'))
        r.poco_observe_result_transition=lambda *a:None
        def recover_overlay(*args,**kw):
            state['checks']+=1
            if state['checks']>1:raise RuntimeError('alipay_known_overlay_reappeared')
            if after=='login':raise RuntimeError('login_required')
            if after=='close_failed':raise RuntimeError('known_overlay_not_dismissed')
            state['closed']=recover
            return recover
        r.recover_page_mismatch=mock.Mock(side_effect=recover_overlay)
        return r,poco,state
    def run_case(self,r,p):
        with clock():return r.query_once_poco(p,PHONE,resume_after_input=True,allow_empty_reinput=False)
    def test_original_query_recovers_and_reads_fresh_result_without_input(self):
        r,p,s=self.fixture();result=self.run_case(r,p)
        self.assertEqual(result['matchedPhone'],PHONE);self.assertEqual(p.freeze.call_count,2)
        self.assertTrue(r.recover_page_mismatch.call_args.kwargs['phone_query_started']);r.input_phone_humanized.assert_not_called();r.poco_tap.assert_not_called()
    def test_unknown_page_remains_mismatch_without_input(self):
        r,p,s=self.fixture(recover=False)
        with self.assertRaisesRegex(RuntimeError,'state_mismatch'):self.run_case(r,p)
        self.assertEqual(s['checks'],1);r.input_phone_humanized.assert_not_called()
    def test_closed_overlay_captcha_enters_manual_flow(self):
        r,p,s=self.fixture('captcha')
        with self.assertRaisesRegex(RuntimeError,'human_verification_required'):self.run_case(r,p)
        r.input_phone_humanized.assert_not_called()
    def test_closed_overlay_restriction_not_empty(self):
        r,p,s=self.fixture('restricted')
        with self.assertRaisesRegex(RuntimeError,'account_restriction'):self.run_case(r,p)
    def test_closed_overlay_login_not_query(self):
        r,p,s=self.fixture('login')
        with self.assertRaisesRegex(RuntimeError,'login_required'):self.run_case(r,p)
    def test_failed_close_not_input(self):
        r,p,s=self.fixture('close_failed')
        with self.assertRaisesRegex(RuntimeError,'known_overlay_not_dismissed'):self.run_case(r,p)
    def test_reappearing_overlay_bounded(self):
        r,p,s=self.fixture('unknown')
        with self.assertRaisesRegex(RuntimeError,'known_overlay_reappeared'):self.run_case(r,p)
        self.assertEqual(s['checks'],2);r.input_phone_humanized.assert_not_called()
if __name__=='__main__':unittest.main()
