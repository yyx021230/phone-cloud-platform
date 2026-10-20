import unittest
from unittest import mock
import alipay_name_lookup as lookup
import alipay_visual_result as visual
from test_lookup_blank_card_guard import BlankCardGuardTests, PHONE

class VisualBudgetTests(unittest.TestCase):
    def test_screenshot_consumes_budget_without_starting_ocr(self):
        r,p=BlankCardGuardTests().fixture();clock=[100.0]
        def screenshot(*a,**k):clock[0]=109.0;return b'fixture'
        r.adb.side_effect=screenshot
        with mock.patch.object(lookup.time,'perf_counter',side_effect=lambda:clock[0]),mock.patch.object(visual,'recognize') as ocr:
            with self.assertRaisesRegex(RuntimeError,'observation_budget_exhausted'):r.poco_visual_result_readonly(p,PHONE,110)
            ocr.assert_not_called()
    def test_reader_deadline_is_distinguished_from_early_reader_failure(self):
        for at,reason in [(109.5,'observation_budget_exhausted'),(103,'ocr_reader_timeout')]:
            r,p=BlankCardGuardTests().fixture();clock=[100.0]
            def ocr(*a,**k):clock[0]=at;raise RuntimeError('lookup_ocr_worker_timeout')
            with mock.patch.object(lookup.time,'perf_counter',side_effect=lambda:clock[0]),mock.patch.object(visual,'recognize',side_effect=ocr):
                with self.assertRaisesRegex(RuntimeError,reason):r.poco_visual_result_readonly(p,PHONE,110)
if __name__=='__main__':unittest.main()
