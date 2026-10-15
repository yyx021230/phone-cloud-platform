import unittest
from alipay_visual_result import parse_empty_rows
from test_lookup_visual_result import row, PHONE

def layout():
    rows = [row(PHONE,249,121),row("快捷功能",100,337),row("手机充值："+PHONE,368,449),row("大家都在搜",115,576)]
    labels = ["支付宝账号信息","查询名字","账户信息","用户信息","查名字","支付宝信息"]
    return rows + [row(label,160 if i%2==0 else 449,654+(i//2)*88) for i,label in enumerate(labels)] + [row("自",678,1333)]

class AlipayInfoSuggestion(unittest.TestCase):
    def test_exact_complete_observed_layout(self):
        result = parse_empty_rows(layout(), PHONE, (720,1600))
        self.assertIsNotNone(result)
        self.assertTrue(result["notFound"])
        self.assertEqual(result["alipayDisplayName"], "")
    def test_unknown_name_or_near_label_is_not_empty(self):
        for label in ["示例(**甲)","支付宝信息甲","支付宝信","张三"]:
            with self.subTest(label=label):
                rows=layout();rows[9]=row(label,449,830)
                self.assertIsNone(parse_empty_rows(rows,PHONE,(720,1600)))
    def test_low_confidence_or_duplicate_is_not_empty(self):
        for replacement in [row("支付宝信息",449,830,.95),row("查名字",449,830)]:
            rows=layout();rows[9]=replacement
            self.assertIsNone(parse_empty_rows(rows,PHONE,(720,1600)))
    def test_missing_cell_or_extra_name_card_is_not_empty(self):
        self.assertIsNone(parse_empty_rows(layout()[:9]+layout()[10:],PHONE,(720,1600)))
        self.assertIsNone(parse_empty_rows(layout()+[row("示例(**甲)",260,390)],PHONE,(720,1600)))
    def test_wrong_phone_or_guard_is_not_empty(self):
        self.assertIsNone(parse_empty_rows(layout(),"10987654321",(720,1600)))
        self.assertIsNone(parse_empty_rows(layout()+[row("安全验证",320,680)],PHONE,(720,1600)))
if __name__ == "__main__":unittest.main()
