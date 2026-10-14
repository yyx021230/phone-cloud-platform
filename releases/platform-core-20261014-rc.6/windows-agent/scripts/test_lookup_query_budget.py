import unittest
from unittest import mock
import alipay_name_lookup as lookup
import alipay_visual_result as visual
from test_lookup_blank_card_guard import PHONE, RESULT, SEARCH_FOCUS

class QueryBudgetTests(unittest.TestCase):
    def run_query(self, explicit_deadline=None, slider=False, ocr_seconds=9):
        clock=[100.0]; state={'input':False,'slider':False}; node=mock.Mock();node.attr.side_effect=lambda k: PHONE if k=='text' else ''
        r=lookup.Runner({'serial':'fixture'});r.emit=mock.Mock();poco=mock.Mock();confirm=mock.Mock()
        r.poco_search_ready=mock.Mock(return_value=node);r.focused_search_input_length=mock.Mock(return_value=0)
        r.poco_tap=mock.Mock();r.wait_before_phone_input=mock.Mock()
        def advance(n):clock[0]+=n
        def input_once(*a,**kw):state['input']=True;advance(18)
        r.input_phone_humanized=mock.Mock(side_effect=input_once)
        r.poco_raise_if_account_restricted=mock.Mock()
        r.poco_verification_evidence=mock.Mock(side_effect=lambda s: {'kind':'basic'} if slider and state['input'] and not state['slider'] else None)
        def solve(*a):state['slider']=True;advance(5)
        r.poco_solve_human_verification=mock.Mock(side_effect=solve)
        r.poco_dismiss_post_input_usb_warning=mock.Mock(return_value=False);r.parse_poco_result=mock.Mock(return_value=None)
        r.poco_nodes=mock.Mock(side_effect=lambda s,**q:[confirm] if q.get('name','').endswith('search_confirm') else [node])
        r.focus=mock.Mock(return_value=SEARCH_FOCUS);r.adb=mock.Mock(return_value=b'synthetic')
        def recognize(raw,timeout):
            if timeout<ocr_seconds:advance(timeout);raise RuntimeError('lookup_ocr_worker_timeout')
            advance(ocr_seconds);return [],(720,1600)
        with mock.patch.object(lookup.time,'time',side_effect=lambda:clock[0]),mock.patch.object(lookup.time,'perf_counter',side_effect=lambda:clock[0]),mock.patch.object(lookup.time,'sleep',side_effect=advance),mock.patch.object(visual,'recognize',side_effect=recognize) as ocr,mock.patch.object(visual,'protection',return_value=''),mock.patch.object(visual,'search_loading',return_value=False),mock.patch.object(visual,'search_network_busy',return_value=False),mock.patch.object(visual,'parse_rows',return_value=RESULT):
            try:result=r.query_once_poco(poco,PHONE,query_deadline=explicit_deadline)
            finally:
                r.input_phone_humanized.assert_called_once()
                self.assertEqual(sum(c.args[0] is confirm for c in r.poco_tap.call_args_list),1)
        return result,clock[0]-100,r,ocr.call_count

    def test_slow_input_and_two_reads_finish_inside_one_budget(self):
        result,elapsed,_,frames=self.run_query()
        self.assertEqual(result,RESULT);self.assertGreater(elapsed,40);self.assertLess(elapsed,60);self.assertEqual(frames,2)

    def test_basic_slider_resumes_same_input_and_finishes_two_frames(self):
        result,elapsed,r,frames=self.run_query(slider=True)
        self.assertEqual(result,RESULT);self.assertLess(elapsed,60);self.assertEqual(frames,2);r.poco_solve_human_verification.assert_called_once()

    def test_explicit_original_deadline_is_not_reset_by_slider(self):
        with self.assertRaisesRegex(RuntimeError,'local_lookup_result_unconfirmed:ocr_reader_timeout'):
            self.run_query(explicit_deadline=140,slider=True)

    def test_slow_ocr_still_stops_instead_of_reinput(self):
        with self.assertRaisesRegex(RuntimeError,'local_lookup_result_unconfirmed:ocr_reader_timeout'):
            self.run_query(ocr_seconds=31)

if __name__=='__main__':unittest.main()
