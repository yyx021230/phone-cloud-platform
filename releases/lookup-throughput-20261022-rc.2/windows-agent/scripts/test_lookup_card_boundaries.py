"""Independent negative cases: never bind an adjacent person's name."""
import unittest
import xml.etree.ElementTree as ET
import alipay_name_lookup as lookup
from alipay_visual_result import parse_rows
from test_lookup_visual_inline_phone import row, PHONE, SIZE
from test_lookup_name_formats import Node

OTHER='10987654321'
def mixed_rows():
    return [row(PHONE,250,104),row('可能想找的人',120,320),
            row('示例(**甲)',210,390),row(OTHER,245,425),row('转账',204,460),row('加好友',491,460),
            row('示例公司',215,495),row(PHONE,245,535),row('转账',204,580),row('加好友',491,580)]

class CardBoundaryTests(unittest.TestCase):
    def test_visual_never_pairs_name_from_previous_account(self):
        self.assertIsNone(parse_rows(mixed_rows(),PHONE,SIZE))
    def test_visual_never_borrows_next_cards_actions(self):
        rows=[row(PHONE,250,104),row('示例(**甲)',210,390),row(PHONE,245,425),
              row('示例公司',215,470),row(OTHER,245,505),row('转账',204,550),row('加好友',491,550)]
        self.assertIsNone(parse_rows(rows,PHONE,SIZE))
    def test_xml_search_input_or_other_card_cannot_lend_phone(self):
        runner=lookup.Runner({'serial':'SYNTHETIC'})
        for nested in [False,True]:
            root=ET.Element('hierarchy');page=ET.SubElement(root,'node')
            ET.SubElement(page,'node',text=PHONE,**{'resource-id':lookup.SEARCH_INPUT_ID})
            first=ET.SubElement(page,'node') if nested else page
            for text in ['示例(**甲)',OTHER,'转账','加好友']:ET.SubElement(first,'node',text=text)
            second=ET.SubElement(page,'node') if nested else page
            for text in ['示例公司',PHONE,'转账','加好友']:ET.SubElement(second,'node',text=text)
            self.assertIsNone(runner.parse_result(root,{},PHONE))
    def test_bounded_xml_cannot_cross_a_card_with_missing_own_phone(self):
        runner=lookup.Runner({'serial':'SYNTHETIC'})
        for bounded in [False, True]:
            with self.subTest(bounded=bounded):
                root=ET.Element('hierarchy');page=ET.SubElement(root,'node')
                for text,y in [('示例(**甲)',300),('示例公司',340),(PHONE,380),('转账',430),('加好友',430)]:
                    attrs={'bounds':f'[160,{y-10}][360,{y+10}]'} if bounded else {}
                    ET.SubElement(page,'node',text=text,**attrs)
                self.assertIsNone(runner.parse_result(root,{},PHONE))

    def test_missing_button_bounds_require_a_minimal_single_card(self):
        runner=lookup.Runner({'serial':'SYNTHETIC'})
        for display in ['示例(**甲)', '101******89(未实名)']:
            for extra in [False, True]:
                with self.subTest(display=display, extra=extra):
                    root=ET.Element('hierarchy');card=ET.SubElement(root,'node')
                    ET.SubElement(card,'node',text=display,bounds='[160,290][360,310]')
                    ET.SubElement(card,'node',text=PHONE,bounds='[160,330][360,350]')
                    if extra: ET.SubElement(card,'node',text='另一张账号卡')
                    ET.SubElement(card,'node',text='转账');ET.SubElement(card,'node',text='加好友')
                    result=runner.parse_result(root,{},PHONE)
                    if extra: self.assertIsNone(result)
                    else: self.assertIsNotNone(result)

    def test_multiple_masked_people_never_silently_pick_first(self):
        runner=lookup.Runner({'serial':'SYNTHETIC'});root=ET.Element('hierarchy');nodes=[]
        for display,y in [('示例(**甲)',.24),('示例(**乙)',.42)]:
            card=ET.SubElement(root,'node')
            for text,dy in [(display,0),(PHONE,.025),('转账',.06),('加好友',.06)]:
                ET.SubElement(card,'node',text=text);nodes.append(Node(text,y+dy))
        self.assertIsNone(runner.parse_result(root,{},PHONE))
        snapshot=lambda **selector:nodes if selector.get('type')=='android.widget.TextView' else []
        self.assertIsNone(runner.parse_poco_result(snapshot,PHONE))

    def test_poco_never_uses_phone_below_another_cards_actions(self):
        runner=lookup.Runner({'serial':'SYNTHETIC'})
        nodes=[Node('示例(**甲)',.24),Node(OTHER,.26),Node('转账',.29),Node('加好友',.29),Node('示例公司',.31),Node(PHONE,.33),Node('转账',.36),Node('加好友',.36)]
        snapshot=lambda **selector:nodes if selector.get('type')=='android.widget.TextView' else []
        self.assertIsNone(runner.parse_poco_result(snapshot,PHONE))

class MissingOwnActionsTests(unittest.TestCase):
    def test_poco_does_not_borrow_next_account_buttons(self):
        runner=lookup.Runner({'serial':'SYNTHETIC'})
        nodes=[Node('示例(**甲)',.24),Node(PHONE,.26),Node('示例公司',.29),Node(OTHER,.31),Node('转账',.34),Node('加好友',.34)]
        snapshot=lambda **selector:nodes if selector.get('type')=='android.widget.TextView' else []
        self.assertIsNone(runner.parse_poco_result(snapshot,PHONE))
    def test_xml_geometry_does_not_borrow_next_account_buttons(self):
        runner=lookup.Runner({'serial':'SYNTHETIC'});root=ET.Element('hierarchy')
        for text,y in [('示例(**甲)',300),(PHONE,340),('示例公司',390),(OTHER,430),('转账',470),('加好友',470)]:
            ET.SubElement(root,'node',text=text,bounds=f'[160,{y-10}][360,{y+10}]')
        self.assertIsNone(runner.parse_result(root,{},PHONE))

class IndependentFrameMutationTests(unittest.TestCase):
    def test_second_frame_failures_never_become_name_or_empty(self):
        import json,copy
        from pathlib import Path
        from alipay_visual_result import _result_rows
        from test_lookup_loading_guard import LoadingGuardTests
        samples=json.loads(Path(__file__).with_name('fixtures').joinpath('lookup-20261021-redacted-replay.json').read_text())
        mutations=0
        for sample in samples:
            w,h=sample['size'];rows=[([[x*720/w,y*1600/h] for x,y in b],t,c) for b,t,c in _result_rows(sample['raw'])]
            first=next(i for i,r in enumerate(rows) if r[1]==PHONE and sum(y for x,y in r[0])/4<224)
            variants={}
            changed=copy.deepcopy(rows);changed[first]=(changed[first][0],OTHER,.999);variants['wrong_input']=changed
            changed=copy.deepcopy(rows);changed[first]=(changed[first][0],PHONE,.5);variants['uncertain_input']=changed
            variants['missing_input']=rows[:first]+rows[first+1:]
            variants['captcha']=rows+[row('安全验证',300,600),row('拖动滑块完成拼图',300,650)]
            variants['limit']=rows+[row('操作频繁或访问异常',300,600)]
            variants['loading']=rows+[row('搜索中',387,214)]
            for name,changed in variants.items():
                with self.subTest(case=sample['case'],mutation=name):
                    with self.assertRaisesRegex(RuntimeError,'local_lookup_result_unconfirmed|human_verification_required'):
                        LoadingGuardTests().run_frames([rows,changed],setup=lambda r,p:r.payload.update(preparedEmptyResult=True))
                mutations+=1
        self.assertEqual(mutations,126)

if __name__=='__main__':unittest.main()
