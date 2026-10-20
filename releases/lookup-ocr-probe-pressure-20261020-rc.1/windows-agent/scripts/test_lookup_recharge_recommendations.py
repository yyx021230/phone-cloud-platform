import json
from pathlib import Path
import unittest
from alipay_visual_result import parse_empty_rows
from test_lookup_loading_guard import LoadingGuardTests
from test_lookup_visual_result import row, PHONE

FRAMES=json.loads((Path(__file__).parent/'fixtures/lookup_recharge_recommendations.json').read_text())
class RechargeRecommendationsTests(unittest.TestCase):
    def test_eight_redacted_production_ocr_frames(self):
        for f in FRAMES:
            with self.subTest(frame=f['index']):
                self.assertTrue(parse_empty_rows(f['rows'],PHONE,f['size'])['notFound'])
    def test_two_frames_after_account_proof_finish_without_retry(self):
        # Fixture runner's screen is 720x1600, normalize the captured 1612 height.
        frames=[[[[[x,y*1600/1612] for x,y in box],text,score] for box,text,score in f['rows']] for f in FRAMES[:2]]
        r,result,clock=LoadingGuardTests().run_frames(frames,setup=lambda r,p:r.payload.update(preparedEmptyResult=True))
        self.assertTrue(result['notFound']);self.assertEqual(r.adb.call_count,2);self.assertLess(clock-100,3)
    def test_guards_reject_overlay_name_wrong_input_and_unproven_boundary(self):
        f=FRAMES[0];rows=f['rows'];size=f['size']
        cases=[rows+[row('转账',300,700)],rows+[row('加好友',300,700)],rows+[row('安全验证',300,700),row('拖动滑块完成拼图',300,750)],rows+[row('未实名',300,700)],rows+[row('**张',300,700)],rows+[row('加载中',300,500)],rows+[row('未知内容',300,500)]]
        cases += [[[box,text,.5 if '猜你喜欢' in text else score] for box,text,score in rows],[[box,'13900000000' if text==PHONE else text,score] for box,text,score in rows],[[box,text,score] for box,text,score in rows if text!='猜你喜欢以下结果']]
        for i,case in enumerate(cases):
            with self.subTest(case=i):self.assertIsNone(parse_empty_rows(case,PHONE,size))
if __name__=='__main__':unittest.main()
