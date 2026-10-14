"""161 rate-limit result and 162 optional identity prompt regressions; no devices."""
import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import alipay_name_lookup as lookup
import alipay_visual_result as visual
import test_lookup_loading_guard as frames
from test_lookup_visual_result import row, card, PHONE

SIZE = (720, 1600)
LIMIT = [row(PHONE, 330, 120), row('您请求次数过于频繁', 360, 512),
         row('待会来试试', 360, 554), row('刷新', 360, 620)]
HOME = 'mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/.AlipayLogin}'
EVIDENCE = {'visible': True, 'close': [360, 1252]}
GONE = {'visible': False, 'close': None}


class RateLimitTests(unittest.TestCase):
    def run_frames(self, values, **kwargs):
        return frames.LoadingGuardTests().run_frames(values, **kwargs)

    def test_native_exact_three_markers_use_existing_account_restriction_reason(self):
        evidence = lookup.Runner.account_restriction_evidence_from_texts([r[1] for r in LIMIT])
        self.assertEqual(evidence['reason'], 'frequent_or_abnormal_access')
        for values in [LIMIT[1:2], LIMIT[1:3], [LIMIT[1], LIMIT[3]]]:
            self.assertIsNone(lookup.Runner.account_restriction_evidence_from_texts([r[1] for r in values]))

    def test_visual_exact_card_requires_phone_confidence_geometry_and_all_markers(self):
        self.assertEqual(visual.search_rate_limit(LIMIT, PHONE, SIZE)['reason'], 'frequent_or_abnormal_access')
        for values in [LIMIT[:-1], [row('10987654321',330,120)]+LIMIT[1:],
                       LIMIT[:1]+[row('您请求次数过于频繁',360,512,.89)]+LIMIT[2:],
                       LIMIT[:1]+[row('您请求次数过于频繁',360,1200)]+LIMIT[2:],
                       LIMIT[:1]+[row('您请求次数过于频繁呀',360,512)]+LIMIT[2:],
                       LIMIT+[LIMIT[2]]]:
            self.assertIsNone(visual.search_rate_limit(values, PHONE, SIZE))

    def test_native_preinput_preserves_phase_instead_of_treating_as_captcha(self):
        r=lookup.Runner({'serial':'fake','accountCooldownProtocol':1,'knownAccount':'A','accountIdentityVerified':True})
        evidence=lookup.Runner.account_restriction_evidence_from_texts([x[1] for x in LIMIT])
        with self.assertRaisesRegex(RuntimeError,'restriction_before_search:frequent_or_abnormal_access'):
            r.raise_account_restriction(evidence,'input-clear','poco',False)
        self.assertFalse(r.log[-1]['phoneQueryStarted'])

    def test_native_verification_over_a_limit_is_not_rotation_evidence(self):
        for marker in [lookup.JIGSAW_VERIFICATION_ACTION,lookup.VERIFICATION_TITLE,'短信验证码登录']:
            self.assertIsNone(lookup.Runner.account_restriction_evidence_from_texts([x[1] for x in LIMIT]+[marker]))

    def test_two_visual_frames_raise_rotation_signal_without_input_or_refresh(self):
        captured=[]
        def setup(r,p):captured.append(r)
        with self.assertRaisesRegex(RuntimeError,'restriction_switch_required:frequent_or_abnormal_access'):
            self.run_frames([LIMIT,LIMIT],setup=setup)
        r=captured[0];self.assertEqual(r.adb.call_count,2)
        events=[c for c in r.emit.call_args_list if c.args[0]=='alipay_account_restriction_detected']
        self.assertEqual(len(events),1)
        self.assertTrue(events[0].kwargs['phoneQueryStarted'])
        self.assertTrue(events[0].kwargs['accountSwitchRequired'])
        r.emit_query_result.assert_not_called()

    def test_single_limit_frame_cannot_rotate_when_next_frame_is_result(self):
        r,result,_=self.run_frames([LIMIT,card(),card()])
        self.assertEqual(result['realNameTailCharacter'],'甲')
        self.assertEqual(r.adb.call_count,3)

    def test_limit_cannot_return_a_stale_name_behind_it(self):
        with self.assertRaisesRegex(RuntimeError,'restriction_switch_required'):
            self.run_frames([LIMIT+card()[1:],LIMIT+card()[1:]])

    def test_actual_puzzle_has_priority_over_rate_limit(self):
        with self.assertRaisesRegex(RuntimeError,'human_verification_required'):
            self.run_frames([LIMIT+[row('安全验证',300,800),row('拖动滑块完成拼图',300,900)]])

    def test_other_protection_cannot_be_hidden_by_the_limit_card(self):
        with self.assertRaisesRegex(RuntimeError,'protected_visual_page'):
            self.run_frames([LIMIT+[row('请输入验证码',300,800)]])

    def test_input_change_after_ocr_prevents_rotation(self):
        def setup(r,p):
            good=r.poco_nodes.return_value;wrong=mock.Mock();wrong.attr.return_value='10987654321'
            r.poco_nodes.side_effect=[good,[wrong]]
        with self.assertRaisesRegex(RuntimeError,'input_changed'):
            self.run_frames([LIMIT,LIMIT],setup=setup)

    def test_partial_low_confidence_limit_never_becomes_no_name(self):
        with self.assertRaisesRegex(RuntimeError,'protected_visual_page'):
            self.run_frames([LIMIT[:-1]])


class PromptTests(unittest.TestCase):
    def runner(self):
        r=lookup.Runner({'serial':'fake','taskId':'prompt'})
        r.focus_state=mock.Mock(return_value=([],HOME,''))
        r.adb=mock.Mock(return_value=b'image')
        r.dump=mock.Mock(return_value=(ET.Element('hierarchy'),{}))
        r.canvas_real_name_home_evidence=mock.Mock(return_value=True)
        r.verification_evidence=mock.Mock(return_value=None)
        return r

    def test_visual_prompt_can_close_before_blocked_xml_once(self):
        r=self.runner()
        def dump(*args):
            self.assertTrue(any(c.args[0][:3]==['shell','input','tap'] for c in r.adb.call_args_list))
            return ET.Element('hierarchy'),{}
        r.dump.side_effect=dump
        with mock.patch.object(lookup,'real_name_canvas_evidence',side_effect=[EVIDENCE,EVIDENCE,GONE]),mock.patch.object(lookup.time,'sleep'):
            self.assertTrue(r.dismiss_canvas_real_name_prompt(None,'before-overlay-dump'))
        taps=[c.args[0] for c in r.adb.call_args_list if c.args[0][:3]==['shell','input','tap']]
        self.assertEqual(taps,[['shell','input','tap','360','1252']])
        self.assertEqual(r.dump.call_count,1)

    def test_unrelated_focus_never_reads_or_taps_a_home_prompt(self):
        r=self.runner();r.focus_state.return_value=([],'mCurrentFocus=Window{x u0 other/app}','')
        self.assertFalse(r.dismiss_canvas_real_name_prompt(None,'before-overlay-dump'))
        r.adb.assert_not_called();r.dump.assert_not_called()

    def test_changed_focus_or_visual_proof_never_taps(self):
        for changed in ['focus','image']:
            r=self.runner()
            if changed=='focus':r.focus_state.side_effect=[([],HOME,''),([],'mCurrentFocus=Window{x u0 other/app}','')]
            with mock.patch.object(lookup,'real_name_canvas_evidence',side_effect=[EVIDENCE,{**EVIDENCE,'close':[480,1252]}]):
                with self.assertRaisesRegex(RuntimeError,'canvas_prompt_(foreground|evidence)_changed'):
                    r.dismiss_canvas_real_name_prompt(None,'before-overlay-dump')
            self.assertFalse(any(c.args[0][:3]==['shell','input','tap'] for c in r.adb.call_args_list))

    def test_persistent_prompt_is_not_clicked_repeatedly(self):
        r=self.runner()
        with mock.patch.object(lookup,'real_name_canvas_evidence',return_value=EVIDENCE),mock.patch.object(lookup.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'canvas_real_name_prompt_not_dismissed'):
                r.dismiss_canvas_real_name_prompt(None,'before-overlay-dump')
        self.assertEqual(sum(c.args[0][:3]==['shell','input','tap'] for c in r.adb.call_args_list),1)

    def test_following_verification_remains_human_not_home_ready(self):
        r=self.runner();r.verification_evidence.return_value={'manual':True}
        with mock.patch.object(lookup,'real_name_canvas_evidence',side_effect=[EVIDENCE,EVIDENCE,GONE]),mock.patch.object(lookup.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'human_verification_required'):
                r.dismiss_canvas_real_name_prompt(None,'before-overlay-dump')

    def test_launch_overlay_dispatches_existing_visual_handler_before_xml(self):
        r=self.runner()
        r.dismiss_honor_software_update_overlay=mock.Mock(return_value=False)
        r.dismiss_vivo_wlan_risk_overlay=mock.Mock(return_value=False)
        r.focus=mock.Mock(return_value=[HOME])
        r.dismiss_canvas_real_name_prompt=mock.Mock(return_value=True)
        r.dump.side_effect=AssertionError('blocked XML must not precede known prompt handling')
        self.assertTrue(r.dismiss_known_overlay())
        r.dismiss_canvas_real_name_prompt.assert_called_once_with(None,'before-overlay-dump')
        r.dump.assert_not_called()

    def test_initial_account_preflight_handles_modal_before_first_xml(self):
        r=self.runner();called=[]
        r.dismiss_canvas_real_name_prompt=mock.Mock(side_effect=lambda *a:called.append(a))
        def dump(*args):
            self.assertEqual(called,[(None,'account-preflight-before-dump')])
            raise RuntimeError('stop-after-first-read')
        r.dump.side_effect=dump
        with self.assertRaisesRegex(RuntimeError,'stop-after-first-read'):
            r.prepare_available_account()


if __name__=='__main__':unittest.main()
