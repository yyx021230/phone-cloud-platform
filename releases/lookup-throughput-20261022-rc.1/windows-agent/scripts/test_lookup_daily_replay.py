"""Redacted offline evidence: geometry/scores from 21 failure screenshots.
No phone, account, server or network operations. Personal text is synthetic.
"""
import copy
import json
from pathlib import Path
import unittest
from alipay_visual_result import _result_rows, parse_rows, parse_empty_rows
from test_lookup_visual_inline_phone import card, row, PHONE, SIZE

class DailyReplayTests(unittest.TestCase):
    def samples(self):
        return json.loads(Path(__file__).with_name('fixtures').joinpath('lookup-20261021-redacted-replay.json').read_text())

    def test_all_21_observed_layouts_with_redacted_text(self):
        for sample in self.samples():
            with self.subTest(case=sample['case']):
                rows = _result_rows(sample['raw'])
                result = parse_rows(rows, PHONE, sample['size']) or parse_empty_rows(rows, PHONE, sample['size'])
                self.assertIsNotNone(result)
                self.assertEqual(bool(result['notFound']), sample['expected']=='empty')
                if sample['expected']=='named': self.assertEqual(result['realNameTailCharacter'],'乙')
                self.assertIsNone(parse_rows(rows,'10987654321',sample['size']))
                self.assertIsNone(parse_empty_rows(rows,'10987654321',sample['size']))

    def test_every_replayed_layout_needs_two_guarded_frames(self):
        from test_lookup_loading_guard import LoadingGuardTests
        for sample in self.samples():
            rows = _result_rows(sample['raw'])
            w,h = sample['size']
            scaled=[([[x*720/w,y*1600/h] for x,y in box],text,score) for box,text,score in rows]
            runner,result,_ = LoadingGuardTests().run_frames([scaled,scaled],setup=lambda r,p:r.payload.update(preparedEmptyResult=True))
            self.assertEqual(runner.adb.call_count,2)
            self.assertEqual(result['notFound'],sample['expected']=='empty')

    def test_character_evidence_rejects_uncertain_tail_mask_or_alignment(self):
        raw = next(r for r in self.samples()[0]['raw'] if '乙' in r[1])
        self.assertGreaterEqual(_result_rows([raw])[0][2], .98)
        for part in ['tail','mask','bracket','alignment','missing','nonfinite']:
            r=copy.deepcopy(raw)
            if part=='tail':r[5][r[1].rfind('乙')]=.97
            elif part=='mask':r[5][r[1].index('*')]=.8
            elif part=='bracket':r[5][-1]=.5
            elif part=='alignment':r[4]=r[4][1:]
            elif part=='nonfinite':r[5][0]=float('nan')
            else:r=r[:3]
            self.assertLess(_result_rows([r])[0][2],.96,part)

    def test_email_ocr_domain_is_not_identity_and_weak_phone_is_rejected(self):
        raw=next(r for r in self.samples()[-1]['raw'] if '@' in r[1])
        self.assertGreaterEqual(_result_rows([raw])[0][2],.98)
        for mode in ['digit','alignment','row']:
            r=copy.deepcopy(raw)
            if mode=='digit':r[5][r[1].index(PHONE)]=.97
            elif mode=='alignment':r[4]=r[4][:-1]
            else:r[2]=.92
            self.assertLess(_result_rows([r])[0][2],.98)

    def test_long_email_requires_left_alignment_or_existing_short_card_geometry(self):
        rows=card();rows[2]=([[180,437],[690,437],[690,461],[180,461]],'a***@long.example.test('+PHONE+')',.999)
        self.assertIsNotNone(parse_rows(rows,PHONE,SIZE))
        rows[2]=([[360,437],[710,437],[710,461],[360,461]],rows[2][1],.999)
        self.assertIsNone(parse_rows(rows,PHONE,SIZE))

    def test_explicit_unverified_nickname_and_email_still_require_exact_card(self):
        for label in ['示例(未实名)','a***@example.test(未实名)']:
            rows=card();rows[1]=row(label,217,410);rows[2]=row(PHONE,240,449)
            self.assertTrue(parse_rows(rows,PHONE,SIZE)['notFound'])
            self.assertIsNone(parse_rows(rows[:-1],PHONE,SIZE))
            self.assertIsNone(parse_rows(rows,'10987654321',SIZE))
        rows=card();rows[1]=row('109****21(未实名)',217,410)
        self.assertIsNone(parse_rows(rows,PHONE,SIZE))

if __name__=='__main__':unittest.main()
