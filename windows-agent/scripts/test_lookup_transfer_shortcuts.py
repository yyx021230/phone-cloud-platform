import unittest
from alipay_visual_result import parse_empty_rows
from test_lookup_visual_result import row, PHONE, card
import test_lookup_loading_guard as fixtures

SIZE = (720, 1600)
def layout():
    rows = [row(PHONE, 250, 121), row('快捷功能', 100, 337),
            row('转账:'+PHONE, 340, 449), row('手机充值:'+PHONE, 365, 601),
            row('大家都在搜', 115, 729)]
    labels = ['支付宝账号信息', '查询名字', '用户信息', '查名字', '账户信息', '查询快递']
    return rows + [row(label, 160 if i % 2 == 0 else 449, 807 + (i//2)*88)
                   for i, label in enumerate(labels)] + [row('自', 678, 1333)]

class TransferShortcutTests(unittest.TestCase):
    def test_complete_observed_shortcut_page_is_no_displayed_name(self):
        result = parse_empty_rows(layout(), PHONE, SIZE)
        self.assertTrue(result['notFound'])
        self.assertEqual(result['alipayDisplayName'], '')
        self.assertEqual(result['message'], 'no_name_in_completed_search')

    def test_named_account_and_standalone_transfer_remain_nonempty(self):
        for rows in [card(), layout()+card()[1:], layout()+[row('示例(**甲)', 270, 385)],
                     layout()[:2]+[row('转账', 340, 449)]+layout()[3:]]:
            with self.subTest(rows=rows):
                self.assertIsNone(parse_empty_rows(rows, PHONE, SIZE))

    def test_wrong_phone_missing_rows_and_low_confidence_fail_closed(self):
        for index in (2, 3):
            for replacement in [row(('转账:' if index == 2 else '手机充值:')+'10987654321', 350, 449 if index == 2 else 601),
                                row(layout()[index][1], 350, 449 if index == 2 else 601, .97)]:
                rows=layout();rows[index]=replacement
                self.assertIsNone(parse_empty_rows(rows, PHONE, SIZE))
        for index in (1, 2, 3, 6):
            rows=layout();del rows[index]
            self.assertIsNone(parse_empty_rows(rows, PHONE, SIZE))

    def test_duplicate_unknown_and_protected_content_fail_closed(self):
        for extra in [row('转账:'+PHONE, 340, 460), row('加载中', 350, 650),
                      row('安全验证', 350, 650), row('网络有点忙', 350, 650),
                      row('您请求次数过于频繁', 350, 650), row('未知结果', 350, 650)]:
            self.assertIsNone(parse_empty_rows(layout()+[extra], PHONE, SIZE))
        rows=layout();rows[6]=row('查询名字甲',449,807)
        self.assertIsNone(parse_empty_rows(rows,PHONE,SIZE))

    def test_wrong_order_and_spacing_fail_closed(self):
        for y in [337, 440, 800]:
            rows=layout();rows[3]=row('手机充值:'+PHONE,365,y)
            self.assertIsNone(parse_empty_rows(rows,PHONE,SIZE))

    def test_runner_requires_readiness_and_two_stable_frames(self):
        def setup(r,p):r.payload['preparedEmptyResult']=True
        runner,result,_=fixtures.LoadingGuardTests().run_frames([layout(),layout()],setup=setup)
        self.assertTrue(result['notFound']);self.assertEqual(runner.adb.call_count,2)
        with self.assertRaisesRegex(RuntimeError,'observation_budget_exhausted'):
            fixtures.LoadingGuardTests().run_frames([layout()],budget=3)
        with self.assertRaisesRegex(RuntimeError,'visual_card_not_proven'):
            fixtures.LoadingGuardTests().run_frames([layout(),layout()[:1],layout()],setup=setup)

if __name__ == '__main__':unittest.main()
