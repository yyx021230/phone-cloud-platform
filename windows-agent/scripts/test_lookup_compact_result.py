import unittest
from test_lookup_visual_result import row, PHONE
from alipay_visual_result import parse_rows
from test_lookup_loading_guard import LoadingGuardTests

def compact():
    return [row(PHONE,330,90),row('可能想找的人',160,260),row('示例(**甲)',260,330),
            row(PHONE,260,365),row('快捷功能',100,435),row('手机充值:'+PHONE,400,535)]

class CompactTests(unittest.TestCase):
    def test_original_compact_no_buttons_is_a_name(self):
        result=parse_rows(compact(),PHONE,(720,1600))
        self.assertEqual(result['realNameTailCharacter'],'甲')
        self.assertEqual(result['matchMethod'],'visual_ocr_compact_person_two_frames')

    def test_unverified_remains_empty(self):
        rows=compact();rows[2]=row('示例(未实名)',260,330)
        self.assertTrue(parse_rows(rows,PHONE,(720,1600))['notFound'])

    def test_foreign_or_incomplete_card_is_not_guessed(self):
        for mode in ['header','end','ad','wrong','button','mixed','othername','input','low','overlay','recharge','gap']:
            rows=compact()
            if mode=='header':rows.pop(1)
            if mode=='end':rows.pop(4)
            if mode=='ad':rows[1]=row('猜你喜欢',160,260)
            if mode=='wrong':rows[3]=row('10987654321',260,365)
            if mode=='button':rows.append(row('转账',250,395))
            if mode=='mixed':rows.append(row('陌生文字',250,400))
            if mode=='othername':rows.append(row('他人(**乙)',250,400))
            if mode=='input':rows[0]=row('10987654321',330,90)
            if mode=='low':rows[3]=row(PHONE,260,365,.80)
            if mode=='overlay':rows.append(row('拖动滑块完成拼图',320,800))
            if mode=='recharge':rows[-1]=row('手机充值:10987654321',400,535)
            if mode=='gap':rows[3]=row(PHONE,260,425)
            with self.subTest(mode=mode):self.assertIsNone(parse_rows(rows,PHONE,(720,1600)))

    def test_full_observer_requires_two_fresh_compact_frames_no_input(self):
        r,result,_=LoadingGuardTests().run_frames([compact(),compact()])
        self.assertEqual(result['realNameTailCharacter'],'甲')
        self.assertEqual(r.adb.call_count,2)
