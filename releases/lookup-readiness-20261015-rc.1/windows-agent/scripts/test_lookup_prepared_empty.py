import unittest
from alipay_visual_result import parse_empty_rows
import test_lookup_loading_guard as fixtures
from test_lookup_visual_result import row, PHONE, card

ROWS=[row(PHONE,330,90),row('快捷功能',180,340),row('手机充值:'+PHONE,350,450)]
SIZE=(720,1600)
class PreparedEmptyTests(unittest.TestCase):
    def test_complete_recharge_only_and_split_rows(self):
        for rows in [ROWS,ROWS[:2]+[row('手机充值:',200,450),row(PHONE,420,450)]]:
            self.assertTrue(parse_empty_rows(rows,PHONE,SIZE)['notFound'])
    def test_blank_loading_risk_wrong_number_name_and_low_confidence_are_not_empty(self):
        for rows in [ROWS[:1],ROWS[:2],ROWS+[row('加载中',300,700)],ROWS+[row('操作频繁',300,700)],ROWS+[row('网络有点忙',300,700)],ROWS+[row('转账',300,700)],ROWS+card()[1:],ROWS[:2]+[row('手机充值:'+PHONE,350,450,.8)], [row('10987654321',330,90)]+ROWS[1:]]:
            self.assertIsNone(parse_empty_rows(rows,PHONE,SIZE))
    def test_runner_requires_proof_and_two_frames(self):
        def setup(r,p):r.payload['preparedEmptyResult']=True
        r,result,_=fixtures.LoadingGuardTests().run_frames([ROWS,ROWS],setup=setup)
        self.assertTrue(result['notFound']);self.assertEqual(r.adb.call_count,2)
        with self.assertRaisesRegex(RuntimeError,'observation_budget_exhausted'):
            fixtures.LoadingGuardTests().run_frames([ROWS],budget=3)
    def test_changed_page_or_nonconsecutive_frames_cannot_return_empty(self):
        def setup(r,p):r.payload['preparedEmptyResult']=True
        with self.assertRaisesRegex(RuntimeError,'visual_card_not_proven'):
            fixtures.LoadingGuardTests().run_frames([ROWS,ROWS[:1],ROWS],setup=setup)
