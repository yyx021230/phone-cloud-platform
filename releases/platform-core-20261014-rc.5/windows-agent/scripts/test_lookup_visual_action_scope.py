"""A lower transfer recommendation is not a duplicate action in the result card."""
import unittest
from alipay_visual_result import parse_rows
from test_lookup_visual_result import row,card,PHONE
import test_lookup_loading_guard as frames
SIZE=(720,1600)
def recommendation():
    return [row('转账',75,595),row(PHONE,135,640),row('转账',620,610)]
class ActionScopeTests(unittest.TestCase):
    def test_lower_transfer_recommendation_does_not_hide_name_card(self):
        self.assertEqual(parse_rows(card()+recommendation(),PHONE,SIZE)['realNameTailCharacter'],'甲')
    def test_ocr_row_order_is_irrelevant(self):
        self.assertIsNotNone(parse_rows(list(reversed(card()+recommendation())),PHONE,SIZE))
    def test_real_top_card_geometry_with_lower_shortcuts(self):
        rows=[row(PHONE,250,104),row('示例(**甲)',205,201),row(PHONE,225,245),row('转账',188,308),row('加好友',490,308),row('转账',75,413),row(PHONE,135,465),row('转账',620,437)]
        self.assertIsNotNone(parse_rows(rows,PHONE,(720,1612)))
    def test_same_row_or_earlier_extra_transfer_is_still_ambiguous(self):
        for y in [460,495,510]:
            with self.subTest(y=y):self.assertIsNone(parse_rows(card()+[row('转账',100,y)],PHONE,SIZE))
    def test_extra_friend_or_duplicate_card_remains_ambiguous(self):
        for extra in [[row('加好友',530,580)],card()[1:]]:
            self.assertIsNone(parse_rows(card()+extra,PHONE,SIZE))
    def test_missing_transfer_cannot_borrow_lower_recommendation(self):
        self.assertIsNone(parse_rows(card()[:3]+[card()[-1]]+recommendation(),PHONE,SIZE))
    def test_low_confidence_wrong_phone_and_protection_still_fail(self):
        variants=[]
        a=card();a[1]=row('示例(**甲)',260,390,.90);variants.append(a)
        variants += [card(phone='10987654321'),card()+[row('操作频繁',320,740)]]
        for rows in variants:self.assertIsNone(parse_rows(rows+recommendation(),PHONE,SIZE))
    def test_runner_still_requires_two_complete_frames_without_input(self):
        r,result,_=frames.LoadingGuardTests().run_frames([card()+recommendation(),card()+recommendation()])
        self.assertEqual(result['realNameTailCharacter'],'甲');self.assertEqual(r.adb.call_count,2)
        with self.assertRaisesRegex(RuntimeError,'visual_card_not_proven'):
            frames.LoadingGuardTests().run_frames([card()+recommendation(),card()[:1]])
if __name__=='__main__':unittest.main()
