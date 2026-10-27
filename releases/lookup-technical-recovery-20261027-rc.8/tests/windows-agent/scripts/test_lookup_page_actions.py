import unittest
from unittest import mock
import alipay_name_lookup as lookup
import alipay_visual_result as visual
from test_lookup_visual_result import row, card, PHONE
import test_lookup_loading_guard as loading
SIZE=loading.SIZE
def run_frames(frames,**kw):
    def setup(r,p):
        old=r.adb.side_effect
        def adb(args,**options):
            if args==["shell","input","tap","360","605"]:return ""
            return old(args,**options)
        r.adb.side_effect=adb
    return loading.LoadingGuardTests().run_frames(frames,setup=setup,**kw)

NETWORK=[row(PHONE,330,90),row('网络不太顺畅',360,495),row('请刷新页面或检查网络设置',360,538),row('刷新',360,605)]
class NetworkTests(unittest.TestCase):
    def test_real_network_variant_is_not_empty(self):
        self.assertTrue(visual.search_network_busy(NETWORK,PHONE,SIZE))
    def test_same_query_refresh_once_then_reads_two_cards(self):
        r,result,_=run_frames([NETWORK,NETWORK,card(),card()])
        taps=[c.args[0] for c in r.adb.call_args_list if c.args[0][:3]==['shell','input','tap']]
        self.assertEqual(taps,[['shell','input','tap','360','605']])
        self.assertEqual(result['realNameTailCharacter'],'甲')
    def test_persistent_network_does_not_return_empty(self):
        with self.assertRaisesRegex(RuntimeError,'alipay_account_restriction_switch_required:frequent_or_abnormal_access'):
            run_frames([NETWORK],budget=10)

    def test_persistent_network_emits_account_limit_after_one_confirmed_refresh(self):
        state={}
        def setup(r,p):
            state['r']=r;r.emit=mock.Mock();old=r.adb.side_effect
            r.adb.side_effect=lambda args,**kw: '' if args==['shell','input','tap','360','605'] else old(args,**kw)
        with self.assertRaisesRegex(RuntimeError,'alipay_account_restriction_switch_required:frequent_or_abnormal_access'):
            loading.LoadingGuardTests().run_frames([NETWORK],setup=setup,budget=10)
        r=state['r']
        self.assertEqual(len([c for c in r.adb.call_args_list if c.args[0][:3]==['shell','input','tap']]),1)
        restrictions=[c for c in r.emit.call_args_list if c.args[0]=='alipay_account_restriction_detected']
        self.assertEqual(len(restrictions),1)
        self.assertTrue(restrictions[0].kwargs['phoneQueryStarted'])
        self.assertEqual(restrictions[0].kwargs['phase'],'visual-network-after-refresh')
        r.emit_query_result.assert_not_called()

    def test_short_observation_cannot_claim_persistent_network_limit(self):
        with self.assertRaisesRegex(RuntimeError,'local_lookup_result_unconfirmed:visual_network_busy'):
            run_frames([NETWORK],budget=3)

    def test_refresh_followed_by_captcha_keeps_human_branch(self):
        challenge=NETWORK+[row('安全验证',300,700),row('拖动滑块完成拼图',300,800)]
        with self.assertRaisesRegex(RuntimeError,'human_verification_required'):
            run_frames([NETWORK,NETWORK,challenge],budget=10)

    def test_refresh_event_confirms_single_tap_and_accepts_ready_result_early(self):
        state={}
        def setup(r,p):
            state['r']=r;r.emit=mock.Mock();old=r.adb.side_effect
            r.adb.side_effect=lambda args,**kw: '' if args==['shell','input','tap','360','605'] else old(args,**kw)
        r,_,end=loading.LoadingGuardTests().run_frames([NETWORK,NETWORK,NETWORK,card(),card()],setup=setup)
        events=[c for c in r.emit.call_args_list if c.args and c.args[0]=='lookup_network_refresh']
        self.assertEqual(len(events),1);self.assertTrue(events[0].kwargs['tapConfirmed'])
        self.assertLess(end,105)
    def test_failed_refresh_is_not_recorded_as_clicked_or_no_name(self):
        state={}
        def setup(r,p):
            state['r']=r;r.emit=mock.Mock();old=r.adb.side_effect
            def adb(args,**kw):
                if args[:3]==['shell','input','tap']:raise RuntimeError('synthetic transport failure')
                return old(args,**kw)
            r.adb.side_effect=adb
        with self.assertRaisesRegex(RuntimeError,'network_refresh_unconfirmed'):
            loading.LoadingGuardTests().run_frames([NETWORK],setup=setup)
        r=state['r'];self.assertFalse(getattr(r,'_network_refreshed_phone',''))
        events=[c for c in r.emit.call_args_list if c.args and c.args[0]=='lookup_network_refresh_failed']
        self.assertEqual(len(events),1);self.assertFalse(events[0].kwargs['tapConfirmed'])



from lookup_page_actions import action_box, stable_box
from test_lookup_overlay_guard import clock
USB=[row('已允许USB传输数据，请切换为仅充电后再使用支付应用',360,680),row('存在被远程控制、泄露隐私的风险',360,790),row('忽略',195,905),row('仅充电',525,905)]
UPDATE=[row('系统升级',360,1085),row('14.0.20.8已经可以安装',360,1145),row('现在安装',360,1265),row('稍后提醒',360,1390)]
class ActionSafetyTests(unittest.TestCase):
    def test_known_button_only(self):
        for rows,kind,xy in [(USB,'coloros_usb',(195,905)),(UPDATE,'vivo_update',(360,1390))]:
            from lookup_page_actions import center
            self.assertEqual(center(action_box(rows,SIZE,kind)),xy)
            self.assertIsNone(action_box(rows+rows[-1:],SIZE,kind))
            self.assertIsNone(action_box(rows[1:],SIZE,kind))
    def test_moved_button_is_rejected(self):
        self.assertFalse(stable_box((1,2,3,4),(21,22,23,24),SIZE))
    def test_wrong_phone_or_challenge_cannot_refresh(self):
        self.assertIsNone(action_box(NETWORK,SIZE,'network_refresh','19999999999'))
        self.assertIsNone(action_box(NETWORK+[row('拖动滑块完成拼图',360,900)],SIZE,'network_refresh',PHONE))
    def fixture(self,kind='coloros_usb',sticky=False,operation='post_human_check'):
        import test_post_human_closure as post
        r=post.PostHumanClosure().runner(operation=operation,result={'realNameTailCharacter':'甲','matchedPhone':'13800000000'})
        r.emit=mock.Mock();r.poco_nodes=mock.Mock(return_value=[])
        st={'closed':False,'commands':[]}
        package='com.coloros.securepay' if kind=='coloros_usb' else 'com.bbk.updater'
        def focus(**kw):
            return ['mCurrentFocus=Window{x u0 '+(lookup.ALIPAY_PACKAGE+'/.SearchActivity' if st['closed'] else package+'/.Dialog')+'}', 'mFocusedApp=ActivityRecord{x '+lookup.ALIPAY_PACKAGE+'/.SearchActivity}']
        r.focus=focus
        def adb(args,**kw):
            st['commands'].append(args)
            if args==['exec-out','screencap','-p']:return b'local-test'
            expected=['shell','input','tap']+(['195','905'] if kind=='coloros_usb' else ['360','1390'])
            if args!=expected:raise AssertionError(args)
            if not sticky:st['closed']=True
            return ''
        r.adb=mock.Mock(side_effect=adb)
        n=mock.Mock();n.attr.side_effect=lambda k:'13800000000' if k=='text' else True
        r.poco_nodes.side_effect=lambda s,**kw:[n] if st['closed'] and kw.get('name')==lookup.SEARCH_INPUT_ID else []
        return r,st
    def test_post_puzzle_missing_elements_ocr_close_reclassify_original_result(self):
        for kind,rows in [('coloros_usb',USB),('vivo_update',UPDATE)]:
            r,s=self.fixture(kind)
            with clock(),mock.patch.object(visual,'recognize',return_value=(rows,SIZE)):
                out=r.run_poco(mock.Mock())
            self.assertTrue(out['postHumanResult']);self.assertEqual(out['realNameTailCharacter'],'甲')
            self.assertEqual(len([a for a in s['commands'] if a[:3]==['shell','input','tap']]),1)
            self.assertFalse(any('text' in a or 'am' in a for a in s['commands']))
    def test_bare_system_package_two_frames_close_and_original_result_continues(self):
        r,s=self.fixture();old=r.focus
        r.focus=lambda **kw:[v.replace('com.coloros.securepay/.Dialog','com.coloros.securepay') for v in old(**kw)]
        with clock(),mock.patch.object(visual,'recognize',return_value=(USB,SIZE)) as ocr:
            out=r.run_poco(mock.Mock())
        self.assertTrue(out['postHumanResult']);self.assertEqual(ocr.call_count,2)
        self.assertEqual([a for a in s['commands'] if a[:3]==['shell','input','tap']],[['shell','input','tap','195','905']])
    def test_bare_system_package_still_present_is_not_closed(self):
        r,s=self.fixture(sticky=True);old=r.focus
        r.focus=lambda **kw:[v.replace('com.coloros.securepay/.Dialog','com.coloros.securepay') for v in old(**kw)]
        with clock(),mock.patch.object(visual,'recognize',return_value=(USB,SIZE)):
            with self.assertRaisesRegex(RuntimeError,'known_overlay_(not_dismissed|close_unverified)'):r.run_poco(mock.Mock())
        r.parse_poco_result.assert_not_called()
    def test_similar_foreign_package_cannot_use_ocr_or_tap(self):
        r,s=self.fixture();old=r.focus
        r.focus=lambda **kw:[v.replace('com.coloros.securepay/.Dialog','com.coloros.securepay.fake/.Dialog') for v in old(**kw)]
        with clock(),mock.patch.object(visual,'recognize') as ocr:self.assertFalse(r.dismiss_system_text_overlay('coloros_usb'))
        ocr.assert_not_called();self.assertFalse(s['commands'])
    def test_human_probe_remains_read_only(self):
        r,s=self.fixture(operation='human_probe')
        with mock.patch.object(visual,'recognize') as ocr:
            self.assertEqual(r.run_poco(mock.Mock())['verificationState'],'unknown')
        self.assertFalse(s['commands']);ocr.assert_not_called()
    def test_sticky_popup_does_not_claim_dismissed_or_retap(self):
        r,s=self.fixture(sticky=True)
        with clock(),mock.patch.object(visual,'recognize',return_value=(USB,SIZE)):
            with self.assertRaisesRegex(RuntimeError,'known_overlay_(not_dismissed|close_unverified)'):r.run_poco(mock.Mock())
        self.assertEqual(len([a for a in s['commands'] if a[:3]==['shell','input','tap']]),1)
    def test_foreign_focus_never_clicks_identical_text(self):
        r,s=self.fixture();r.focus=lambda **kw:['mCurrentFocus=Window{x other.app/.Dialog}']
        with mock.patch.object(visual,'recognize') as ocr:self.assertFalse(r.dismiss_system_text_overlay('coloros_usb'))
        self.assertFalse(s['commands']);ocr.assert_not_called()
    def test_two_frame_coordinates_must_agree(self):
        r,s=self.fixture();shift=[row('忽略',250,905) if v[1]=='忽略' else v for v in USB]
        with clock(),mock.patch.object(visual,'recognize',side_effect=[(USB,SIZE),(shift,SIZE)]):
            self.assertFalse(r.dismiss_system_text_overlay('coloros_usb'))
        self.assertFalse(any(a[:3]==['shell','input','tap'] for a in s['commands']))



class ClosureBudgetTests(unittest.TestCase):
    fixture=ActionSafetyTests.fixture
    def test_blocked_poco_can_use_system_ocr_before_reading_it_again(self):
        r,s=self.fixture();p=mock.Mock()
        def freeze():
            if not s['closed']:raise TimeoutError('synthetic blocked hierarchy')
            return mock.Mock()
        p.freeze.side_effect=freeze
        with clock(),mock.patch.object(visual,'recognize',return_value=(USB,SIZE)):
            self.assertTrue(r.run_poco(p)['postHumanResult'])
    def test_post_human_ocr_budget_cannot_tap_after_deadline(self):
        r,s=self.fixture()
        with clock() as now:
            def read(*a,**kw):
                self.assertLessEqual(kw['timeout'],18);now[0]+=30.1;return USB,SIZE
            with mock.patch.object(visual,'recognize',side_effect=read):
                with self.assertRaisesRegex(RuntimeError,'known_overlay_close_unverified'):r.run_poco(mock.Mock())
        self.assertFalse(any(c[:3]==['shell','input','tap'] for c in s['commands']))
    def test_reappearing_puzzle_after_close_is_not_a_result(self):
        r,s=self.fixture();r.poco_verification_evidence=lambda snap:s['closed']
        with clock(),mock.patch.object(visual,'recognize',return_value=(USB,SIZE)):
            with self.assertRaisesRegex(RuntimeError,'human_verification_required'):r.run_poco(mock.Mock())
        r.parse_poco_result.assert_not_called()
    def test_ocr_reader_failure_is_page_fault_not_device_timeout(self):
        r,s=self.fixture()
        with clock(),mock.patch.object(visual,'recognize',side_effect=RuntimeError('lookup_ocr_worker_timeout')):
            with self.assertRaisesRegex(RuntimeError,'alipay_known_overlay_read_unconfirmed:coloros_usb'):r.run_poco(mock.Mock())
        self.assertFalse(any(c[:3]==['shell','input','tap'] for c in s['commands']))
    def test_xml_update_uses_exact_fresh_element_before_ocr(self):
        import xml.etree.ElementTree as ET
        r,s=self.fixture('vivo_update')
        root=ET.fromstring('<hierarchy><node package="com.bbk.updater" text="系统升级"/><node package="com.bbk.updater" text="现在安装"/><node package="com.bbk.updater" text="稍后提醒" clickable="true" enabled="true" bounds="[300,1370][420,1410]"/></hierarchy>')
        r.dump=mock.Mock(return_value=(root,{}))
        with clock(),mock.patch.object(visual,'recognize') as ocr:
            self.assertTrue(r.dismiss_system_text_overlay('vivo_update',root=root))
        ocr.assert_not_called();self.assertEqual(s['commands'],[['shell','input','tap','360','1390']])

if __name__=='__main__':unittest.main()
