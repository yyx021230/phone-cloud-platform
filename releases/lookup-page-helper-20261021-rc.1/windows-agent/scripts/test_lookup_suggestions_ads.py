import unittest
import json
from pathlib import Path
from alipay_visual_result import parse_empty_rows
from test_lookup_visual_result import row, PHONE, card
from test_lookup_loading_guard import LoadingGuardTests

SIZE = (720, 1600)

def layout(last='支付宝小程序应用'):
    return [row(PHONE, 250, 104), row('快捷功能', 100, 320),
            row('手机充值:'+PHONE, 370, 434), row('大家都在搜', 120, 560),
            row('支付宝账号信息', 165, 640), row('APP小程序', 470, 640),
            row('快速查询', 120, 726), row('查名字', 435, 726),
            row('注册认证小程序', 165, 815), row(last, 505, 815),
            row('猜你喜欢以下结果', 360, 950), row('广告', 650, 1030),
            row('广告示例内容', 200, 1080), row('点击观看', 100, 1270)]

class SuggestionsAdTests(unittest.TestCase):
    def test_transfer_recharge_ad_and_lower_clipboard(self):
        rows = [row(PHONE, 250, 120), row('快捷功能', 100, 337),
                row('转账:'+PHONE, 340, 449), row('手机充值:'+PHONE, 365, 601)]
        with_ad = rows + [row('猜你喜欢以下结果', 360, 759), row('广告内容', 230, 880)]
        for value in [with_ad, rows+[row('自', 678, 1220)]]:
            self.assertTrue(parse_empty_rows(value, PHONE, SIZE)['notFound'])
        self.assertTrue(parse_empty_rows(rows+[row('￥',100,449,.74)],PHONE,SIZE)['notFound'])
        for x,y in [(350,449),(100,550)]:
            self.assertIsNone(parse_empty_rows(rows+[row('￥',x,y,.74)],PHONE,SIZE))
        for extra in ['示例(**甲)', '加好友', '转账', '未知结果']:
            self.assertIsNone(parse_empty_rows(with_ad+[row(extra, 300, 700)], PHONE, SIZE))
        changed=with_ad.copy();changed[2]=row('转账:10987654321',340,449)
        self.assertIsNone(parse_empty_rows(changed,PHONE,SIZE))
        changed=with_ad.copy();changed[2]=row('转账:'+PHONE,340,449,.97)
        self.assertIsNone(parse_empty_rows(changed,PHONE,SIZE))
        self.assertIsNone(parse_empty_rows(rows+[row('自',400,1220)],PHONE,SIZE))

    def test_redacted_windows_native_ocr_geometry(self):
        samples = json.loads(Path(__file__).with_name('fixtures').joinpath('lookup-suggestions-ads.json').read_text())
        for sample in samples:
            self.assertTrue(parse_empty_rows(sample['rows'], '13812345678', sample['size'])['notFound'])

    def test_both_observed_complete_layouts(self):
        for last in ['支付宝小程序应用', '付款二维码']:
            result = parse_empty_rows(layout(last), PHONE, SIZE)
            self.assertIsNotNone(result)
            self.assertTrue(result['notFound'])

    def test_missing_unknown_low_confidence_wrong_phone_fail_closed(self):
        original = layout()
        for i in range(11):
            rows = original[:i] + original[i+1:]
            self.assertIsNone(parse_empty_rows(rows, PHONE, SIZE), str(i))
        for extra in ['安全验证', '加载中', '加好友', '示例(**甲)', '未知结果']:
            self.assertIsNone(parse_empty_rows(original+[row(extra, 300, 900)], PHONE, SIZE))
        for i in [0, 2, 4, 7, 10]:
            rows = layout(); rows[i] = (rows[i][0], rows[i][1], .9)
            self.assertIsNone(parse_empty_rows(rows, PHONE, SIZE))
        self.assertIsNone(parse_empty_rows(layout(), '10987654321', SIZE))
        self.assertIsNone(parse_empty_rows(layout()+card()[1:], PHONE, SIZE))

    def test_two_frames_changing_ad_but_same_complete_result(self):
        second = layout(); second[-1] = row('另一条广告', 160, 1270)
        runner, result, _ = LoadingGuardTests().run_frames(
            [layout(), second], setup=lambda r,p:r.payload.update(preparedEmptyResult=True))
        self.assertTrue(result['notFound']); self.assertEqual(runner.adb.call_count, 2)
        with self.assertRaisesRegex(RuntimeError, 'observation_budget_exhausted'):
            LoadingGuardTests().run_frames([layout()], budget=3)
        with self.assertRaisesRegex(RuntimeError, 'visual_card_not_proven'):
            LoadingGuardTests().run_frames([layout(), layout()[:4]],
                setup=lambda r,p:r.payload.update(preparedEmptyResult=True))

if __name__ == '__main__': unittest.main()
