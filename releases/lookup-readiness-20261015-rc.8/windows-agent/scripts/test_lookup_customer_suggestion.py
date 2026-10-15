import unittest
from alipay_visual_result import parse_empty_rows
from test_lookup_visual_result import row,PHONE
class CustomerSuggestion(unittest.TestCase):
 def test_observed_customer_info_suggestion_is_layout_only(self):
  rows=[row(PHONE,249,121),row('快捷功能',100,337),row('手机充值：'+PHONE,368,449),row('大家都在搜',115,576)]
  labels=['支付宝账号信息','查询名字','用户信息','查名字','账户信息','客户信息']
  rows += [row(label,160 if i%2==0 else 449,654+(i//2)*88) for i,label in enumerate(labels)]
  rows += [row('自',678,1333)]
  self.assertTrue(parse_empty_rows(rows,PHONE,(720,1600))['notFound'])
  rows[-2]=row('未知姓名',449,830)
  self.assertIsNone(parse_empty_rows(rows,PHONE,(720,1600)))
if __name__=='__main__':unittest.main()
