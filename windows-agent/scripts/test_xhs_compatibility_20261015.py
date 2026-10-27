"""Regression cases from the 2026-10-15 phone failures; no device access."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch, Mock
import xml.etree.ElementTree as ET
SCRIPTS = Path(__file__).parent
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('compat_sync', SCRIPTS / '小红书数据同步.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

class ObservedOverlayTests(unittest.TestCase):
    def fixture(self, name):
        return ET.parse(SCRIPTS / 'fixtures/xhs' / name).getroot()

    def test_vivo_exact_cancel_without_window_type(self):
        root = self.fixture('vivo-notification.xml')
        with patch.object(sync, 'focus', return_value='mCurrentFocus=Window{x u0 com.vivo.pushservice}'), patch.object(sync, 'navigation_capture', return_value=ET.Element('hierarchy')), patch.object(sync.time, 'sleep'), patch.object(sync, 'adb') as adb:
            events = []
            self.assertTrue(sync.recover_known_overlay('adb', 'serial', root, lambda: None, events))
        self.assertEqual(adb.call_args.args[2:], ('shell', 'input', 'tap', '540', '2061'))
        self.assertEqual(events, ['vivo_notification_cancelled'])

    def test_vivo_never_taps_allow_or_an_unproven_cancel(self):
        root = self.fixture('vivo-notification.xml')
        for node in root.iter('node'):
            if node.get('resource-id') == 'android:id/button2':node.set('resource-id', 'other')
        with patch.object(sync, 'focus', return_value='mCurrentFocus=Window{x u0 com.vivo.pushservice}'), patch.object(sync, 'adb') as adb:
            with self.assertRaisesRegex(RuntimeError, 'safe cancel'):
                sync.recover_known_overlay('adb', 'serial', root, lambda: None, [])
        adb.assert_not_called()

    def test_milestone_sharing_copy_closes_only_observed_icon(self):
        root = self.fixture('milestone-sharing.xml')
        with patch.object(sync, 'focus', return_value='mCurrentFocus=Window{x u999 com.xingin.xhs/.index.v2.IndexActivityV2}'), patch.object(sync, 'navigation_capture', return_value=ET.Element('hierarchy')), patch.object(sync.time, 'sleep'), patch.object(sync, 'adb') as adb:
            self.assertTrue(sync.recover_known_overlay('adb', 'serial', root, lambda: None, []))
        self.assertEqual(adb.call_args.args[2:], ('shell', 'input', 'tap', '686', '821'))

    def test_154_new_sharing_copy_closes_only_the_proven_top_right_icon(self):
        root = self.fixture('milestone-sharing-154.xml')
        events = []
        with patch.object(sync, 'focus', return_value='mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}'), patch.object(sync, 'navigation_capture', return_value=ET.Element('hierarchy')), patch.object(sync.time, 'sleep'), patch.object(sync, 'adb') as adb:
            self.assertTrue(sync.recover_known_overlay('adb', 'serial', root, lambda: None, events))
        adb.assert_called_once_with('adb', 'serial', 'shell', 'input', 'tap', '686', '863', timeout=7)
        self.assertEqual(events, ['milestone_close_selected'])

    def test_154_unknown_copy_is_still_rejected_without_tapping_publish_or_close(self):
        root = self.fixture('milestone-sharing-154.xml')
        root[0][2].set('text', '分享喜悦，获得更多人的关注❤️')
        with patch.object(sync, 'focus', return_value='com.xingin.xhs/.index.v2.IndexActivityV2'), patch.object(sync, 'adb') as adb:
            with self.assertRaisesRegex(RuntimeError, 'close layout is not proven'):
                sync.recover_known_overlay('adb', 'serial', root, lambda: None, [])
        adb.assert_not_called()

class LoginTests(unittest.TestCase):
    def test_halfwelcome_and_welcome_require_exact_slot_foreground(self):
        for user, slot, activity in [('0','app1','halfwelcome.HalfWelcomeActivity'),('999','app2','activity.WelcomeActivity')]:
            current = f'mCurrentFocus=Window{{x u{user} com.xingin.xhs/com.xingin.login.{activity}}}'
            self.assertTrue(sync.login_activity(current))
            events = ['collection_slot_requested:' + slot] + (['clone_user_requested:999'] if slot == 'app2' else [])
            sync.assert_requested_foreground(current, events)
            with self.assertRaisesRegex(RuntimeError, 'requested slot'):
                sync.assert_requested_foreground(current, ['collection_slot_requested:app2','clone_user_requested:128'])

    def test_background_login_activity_does_not_classify_foreground(self):
        self.assertFalse(sync.login_activity('mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}\nmFocusedApp=ActivityRecord{x u0 com.xingin.xhs/com.xingin.login.activity.WelcomeActivity}'))

class KeyguardTests(unittest.TestCase):
    locked = 'mKeyguardOccluded=false\nKeyguardServiceDelegate\n showing=true\n secure=false\nKeyguardStateMonitor\n'
    def test_oem_swipe_only_on_unsecured_lock_and_confirm_after(self):
        def command(_adb, _serial, *args, **kwargs):
            if args[-1] == 'policy':return next(policies)
            if args[-1] == 'size':return 'Physical size: 720x1600\n'
            return ''
        policies = iter([self.locked]*3 + [self.locked.replace('showing=true','showing=false')])
        with patch.object(sync, 'focus', return_value='mCurrentFocus=Window{x u0 NotificationShade}'), patch.object(sync, 'adb', side_effect=command) as adb, patch.object(sync.time, 'sleep'):
            self.assertTrue(sync.dismiss_unsecured_keyguard('adb','serial',lambda: None,[]))
        self.assertIn(('shell','input','swipe','360','1360','360','480','350'), [c.args[2:] for c in adb.call_args_list])

    def test_no_swipe_over_other_foreground_or_changed_security(self):
        for changed in [False,True]:
            policies = iter([self.locked, self.locked.replace('secure=false','secure=true') if changed else self.locked, self.locked])
            def command(_adb,_serial,*args,**kwargs):return next(policies,self.locked) if args[-1]=='policy' else ''
            with patch.object(sync,'focus',return_value='mCurrentFocus=Window{x u0 com.android.settings/.Settings}'), patch.object(sync,'adb',side_effect=command) as adb, patch.object(sync.time,'sleep'):
                with self.assertRaises(RuntimeError):sync.dismiss_unsecured_keyguard('adb','serial',lambda:None,[])
            self.assertFalse(any('swipe' in c.args for c in adb.call_args_list))


class OcrCompatibilityTests(unittest.TestCase):
    def test_observed_720_counts_match_verified_glyphs_and_reject_missing_ink(self):
        import cv2
        import json
        import xhs_list_ocr as ocr
        frame = cv2.imread(str(SCRIPTS/'fixtures/xhs/counts-720.png'))
        for sample in json.loads((SCRIPTS/'fixtures/xhs/counts-720.json').read_text()):
            value, needs_native = ocr.numeric_cell(frame,sample['box'],allow_candidate=True)
            self.assertEqual(value,sample['value'])
        with self.assertRaisesRegex(RuntimeError,'no proven numeral'):
            ocr.numeric_cell(frame*0+255,[0,0,100,30],allow_candidate=True)

    def test_observed_1080_three_matches_in_training_and_independent_cells(self):
        import cv2
        import json
        import xhs_list_ocr as ocr
        frame = cv2.imread(str(SCRIPTS/'fixtures/xhs/counts-1080-47.png'))
        samples = json.loads((SCRIPTS/'fixtures/xhs/counts-1080-47.json').read_text())
        for sample in samples:
            with self.subTest(value=sample['value']):
                value, _ = ocr.numeric_cell(frame,sample['box'],allow_candidate=True)
                self.assertEqual(value,sample['value'])
        with self.assertRaisesRegex(RuntimeError,'no proven numeral'):
            ocr.numeric_cell(frame*0+255,samples[0]['box'],allow_candidate=True)

    def test_observed_1080_decimal_unit_keeps_native_corroboration_mandatory(self):
        import cv2,json,xhs_list_ocr as o
        frame = cv2.imread(str(SCRIPTS/'fixtures/xhs/counts-1080-47.png'))
        sample = next(x for x in json.loads((SCRIPTS/'fixtures/xhs/counts-1080-47.json').read_text()) if x['value']=='1.9万')
        self.assertEqual(o.numeric_cell(frame,sample['box'],allow_candidate=True),('1.9万',True))
        with self.assertRaisesRegex(RuntimeError,'requires native corroboration'):
            o.numeric_cell(frame,sample['box'])
        with self.assertRaisesRegex(RuntimeError,'unproven'):
            o.corroborate_counts({'verifiedCounts':['1.9万'],'weakCountFields':[0]},0,{})

    def test_observed_720_metric_order_and_missing_heart(self):
        import cv2
        import xhs_list_ocr as ocr
        frame = cv2.imread(str(SCRIPTS/'fixtures/xhs/metric-row-720.png'))
        icons = ocr.metric_icons(frame,0,55,194)
        self.assertEqual(len(icons),3)
        self.assertLess(abs((icons[1][0]+icons[1][2])/2-295.5),3)
        frame[:,275:314] = 255
        with self.assertRaisesRegex(RuntimeError,'icon is not proven: like'):
            ocr.metric_icons(frame,0,55,194)

    def test_hint_is_only_recognized_between_exact_center_and_filter(self):
        import numpy as np
        import xhs_list_ocr as ocr
        from test_xhs_list_ocr import line
        frame=np.full((1600,720,3),255,np.uint8)
        full={'width':720,'height':1600,'language':'zh-Hans-CN','lines':[line('数据中心',(300,110,420,145)),line('支持多维筛选排序啦',(40,216,285,245)),line('全部笔记',(30,280,140,310))]}
        with self.assertRaises(ocr.WorksListHint):ocr.prepare_frame(frame,full)
        full['lines'][1]=line('支持多维筛选排序啦',(400,216,645,245))
        with self.assertRaisesRegex(RuntimeError,'header is not unique'):ocr.prepare_frame(frame,full)


class AdditionalBoundaryTests(unittest.TestCase):
    def test_huawei_clone_requires_the_observed_profile_and_installed_package(self):
        with patch.object(sync,'adb',side_effect=['HUAWEI','UserInfo{0:机主:4c13} running\nUserInfo{128:分身应用:4000410} running','package:com.xingin.xhs\n']):
            self.assertEqual(sync.explicit_clone_user('adb','serial'),'128')
        with patch.object(sync,'adb',side_effect=['HUAWEI','UserInfo{999:分身应用:4000410} running']):
            with self.assertRaisesRegex(RuntimeError,'not uniquely proven'):
                sync.explicit_clone_user('adb','serial')

    def test_tty_timeout_can_use_only_a_new_file_dump(self):
        import subprocess
        def command(_adb,_serial,*args,**kwargs):
            if args[:3]==('exec-out','uiautomator','dump'):raise subprocess.TimeoutExpired('adb',15)
            if args[:2]==('exec-out','cat'):return '<hierarchy rotation="0"></hierarchy>'
            return ''
        with patch.object(sync,'adb',side_effect=command) as adb,patch.object(sync,'focus',return_value='mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}'),patch.object(sync.time,'sleep'):
            self.assertEqual(sync.capture('adb','serial').tag,'hierarchy')
        paths=[c.args[-1] for c in adb.call_args_list if c.args[2:5]==('shell','uiautomator','dump')]
        self.assertEqual(len(paths),1)
        self.assertTrue(paths[0].startswith('/sdcard/phonecloud-xhs-capture-'))

    def test_transport_error_does_not_turn_into_a_capture_retry(self):
        with patch.object(sync,'adb',side_effect=RuntimeError('device offline')) as adb:
            with self.assertRaisesRegex(RuntimeError,'device offline'):sync.capture('adb','serial')
        self.assertEqual(adb.call_count,1)

    def test_login_profile_stops_without_touching_login_or_agreement(self):
        root=ET.fromstring('<hierarchy>'+''.join('<node package="com.xingin.xhs" text="'+text+'" bounds="[10,100][600,200]"/>' for text in ['登录后展示自己','微信登录','手机号登录'])+'</hierarchy>')
        current='mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}'
        with patch.object(sync,'focus',return_value=current),patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'recover_known_overlay',return_value=False),patch.object(sync,'adb') as adb:
            with self.assertRaisesRegex(RuntimeError,'manual login is required'):
                sync.ensure_creator_list('adb','serial',root,'app1',lambda:None,['collection_slot_requested:app1'])
        adb.assert_not_called()


class FilterNavigationTests(unittest.TestCase):
    def observed(self):
        import json
        import numpy as np
        import xhs_list_ocr as ocr
        full=json.loads((SCRIPTS/'fixtures/xhs/filter-navigation-ocr.json').read_text())
        frame=np.full((full['height'],full['width'],3),255,np.uint8)
        works=next(ocr.line_box(l) for l in full['lines'] if ocr.compact(l['text'])=='作品分析')
        frame[works[3]+8:works[3]+12,works[0]:works[2]]=(40,30,240)
        return frame,full

    def test_observed_open_panel_is_navigation_only_with_no_cards_or_empty_marker(self):
        import xhs_list_ocr as ocr
        frame,full=self.observed();data=ocr.filter_navigation_frame(frame,full)
        self.assertTrue(data['navigationOnly']);self.assertEqual(data['cards'],[]);self.assertEqual(data['markers'],{})
        root=ocr.hierarchy_for_frame(data)
        self.assertEqual(root.get('data-source'),'windows_native_ocr_navigation')
        with self.assertRaises(sync.ElementListReadError):sync.note_cards(root)
        self.assertTrue(sync.label(root,'收起'))
        self.assertFalse(sync.label(root,'重置'))

    def test_partial_duplicated_wrong_language_and_unselected_panel_are_rejected(self):
        import copy
        import xhs_list_ocr as ocr
        frame,full=self.observed()
        for mutation in ['missing','duplicate','language','underline']:
            candidate=copy.deepcopy(full);pixels=frame.copy()
            if mutation=='missing':candidate['lines']=candidate['lines'][:-1]
            if mutation=='duplicate':candidate['lines'].append(candidate['lines'][-1])
            if mutation=='language':candidate['language']='en-US'
            if mutation=='underline':pixels[:]=255
            self.assertIsNone(ocr.filter_navigation_frame(pixels,candidate))

    def test_synthetic_filter_tree_is_rejected_by_element_navigation(self):
        import xhs_list_ocr as ocr
        frame,full=self.observed();root=ocr.hierarchy_for_frame(ocr.filter_navigation_frame(frame,full))
        with patch.object(sync,'capture',return_value=root),self.assertRaises(sync.ElementListReadError):
            sync.navigation_capture('adb','serial',lambda:None,[])

    def test_ensure_closes_only_the_panel_before_accepting_a_list(self):
        root=ET.parse(SCRIPTS/'fixtures/xhs/filter-panel-elements.xml').getroot()
        listing=ET.fromstring('<hierarchy><node text="数据中心" bounds="[0,0][700,100]"/><node text="作品分析" bounds="[0,100][700,200]"/><node text="全部笔记" bounds="[0,200][700,300]"/></hierarchy>')
        with patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'tap_filter_label') as tap,patch.object(sync,'navigation_capture',return_value=listing):
            self.assertIs(sync.ensure_creator_list('adb','serial',root,'app1',lambda:None,[]),listing)
        self.assertEqual(tap.call_args.args[3],'收起')


class FilterCardConfusionTests(unittest.TestCase):
    def test_note_titles_matching_section_names_cannot_be_tapped_as_a_filter(self):
        root=ET.fromstring('<hierarchy><node package="com.xingin.xhs" class="android.webkit.WebView" text="数据中心" bounds="[0,0][720,1600]">'+''.join('<node package="com.xingin.xhs" class="android.widget.TextView" text="'+text+'" bounds="['+str(x)+','+str(y)+']['+str(x+120)+','+str(y+25)+']"/>' for text,x,y in [('数据中心',300,110),('作品分析',217,198),('全部笔记',32,282),('笔记类型',194,370),('发布时间',194,580),('排序方式',194,790),('收起',194,1000)])+'</node></hierarchy>')
        self.assertFalse(sync.creator_filter_panel(root))


class OneTapLoginTests(unittest.TestCase):
    def test_clone_one_tap_login_is_skipped_without_pressing_it(self):
        root=ET.fromstring('<hierarchy>'+''.join('<node package="com.xingin.xhs" text="'+text+'" bounds="[10,100][600,200]"/>' for text in ['登录后展示自己','微信登录','一键登录','其他登录方式'])+'</hierarchy>')
        current='mCurrentFocus=Window{x u999 com.xingin.xhs/.index.v2.IndexActivityV2}'
        with patch.object(sync,'focus',return_value=current),patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'recover_known_overlay',return_value=False),patch.object(sync,'adb') as adb:
            with self.assertRaisesRegex(RuntimeError,'manual login is required'):
                sync.ensure_creator_list('adb','serial',root,'app2',lambda:None,['collection_slot_requested:app2','clone_user_requested:999'])
        adb.assert_not_called()


class DateContextTests(unittest.TestCase):
    def item(self,text):return {'language':'zh-Hans-CN','lines':[{'text':text}] if text else []}
    def test_context_can_supply_two_dates_from_independently_processed_ink(self):
        import xhs_list_ocr as o
        values={'d_color':self.item(''),'d_binary':self.item('09一]4'),'d_context_binary':self.item('09一24'),'d_context_contrast':self.item('09一24')}
        self.assertEqual(o.equal_variants(values,'d',o.date_text),'09-24')
        values['d_context_contrast']=self.item('09一23')
        with self.assertRaisesRegex(RuntimeError,'contextual date values disagree'):o.equal_variants(values,'d',o.date_text)
    def test_context_does_not_override_two_primary_dates_or_conflicting_primary(self):
        import xhs_list_ocr as o
        values={'d_color':self.item(''),'d_binary':self.item('10-14'),'d_contrast':self.item('10-14'),'d_context_binary':self.item('09-24'),'d_context_contrast':self.item('09-24')}
        self.assertEqual(o.equal_variants(values,'d',o.date_text),'10-14')
        del values['d_contrast']
        with self.assertRaisesRegex(RuntimeError,'contextual date values disagree'):o.equal_variants(values,'d',o.date_text)
    def test_prefix_crossing_and_outside_words_never_supply_a_date(self):
        import copy
        import xhs_list_ocr as o
        result={'width':700,'height':200,'lines':[{'words':[{'text':'DATE:','x':10,'y':40,'width':200,'height':80},{'text':'09一24','x':350,'y':40,'width':150,'height':80}]}]}
        parsed=o.context_date_result(result,[300,20,600,180]);self.assertEqual(parsed['lines'][0]['text'],'09一24')
        for x,width in [(10,500),(610,50),(350,0)]:
            bad=copy.deepcopy(result);bad['lines'][0]['words'][1].update(x=x,width=width)
            self.assertEqual(o.context_date_result(bad,[300,20,600,180])['lines'],[])
        with self.assertRaisesRegex(RuntimeError,'region is invalid'):o.context_date_result(result,[300,20,900,180])
    def test_one_context_result_and_empty_primary_do_not_make_a_date(self):
        import xhs_list_ocr as o
        values={'d_color':self.item(''),'d_binary':self.item(''),'d_context_binary':self.item('09-24')}
        with self.assertRaisesRegex(RuntimeError,'two independently processed'):o.equal_variants(values,'d',o.date_text)

class RestrictedNoteTests(unittest.TestCase):
    def test_grouped_xml_retains_restricted_note_and_all_three_metrics(self):
        for status in ['该篇笔记已不被推荐给未关注用户','该篇笔记已不可被他人查看']:
            root=ET.fromstring('<hierarchy><node package="com.xingin.xhs" bounds="[0,400][1080,710]">'
                '<node package="com.xingin.xhs" text="受限测试" bounds="[285,420][1000,460]"/>'
                '<node package="com.xingin.xhs" text="'+status+'" bounds="[339,490][1000,530]"/>'
                '<node package="com.xingin.xhs" text="10-15" bounds="[108,640][192,680]"/>'
                '<node package="com.xingin.xhs" text="34" bounds="[342,620][402,665]"/>'
                '<node package="com.xingin.xhs" text="0" bounds="[498,620][522,665]"/>'
                '<node package="com.xingin.xhs" text="1" bounds="[615,620][639,665]"/></node></hierarchy>')
            cards=sync.note_cards(root);self.assertEqual(len(cards),1);self.assertEqual(cards[0][1]['status_raw'],status);self.assertEqual(cards[0][1]['list_view_count'],34)
            root[0].remove(root[0][-1]);self.assertEqual(sync.note_cards(root),[])
    def test_flat_xml_also_retains_restricted_status(self):
        from test_xhs_data_sync import FleetReadingTests
        root=FleetReadingTests().flat_list();root[2][2].set('text','该篇笔记已不被推荐给未关注用户')
        self.assertEqual(sync.note_cards(root)[0][1]['list_view_count'],133)
    def test_ocr_restricted_status_is_a_card_status_not_a_title(self):
        import numpy as np
        import xhs_list_ocr as o
        from test_xhs_list_ocr import line,result
        frame=np.full((2400,1080,3),255,np.uint8);frame[254:261,330:500]=(40,30,240)
        lines=[line(t,b) for t,b in result()['headers'].items()]+[line('受限测试标题',(300,500,800,550)),line('!该篇笔记已不被推荐给未关注用户',(300,600,950,640))]
        full={'width':1080,'height':2400,'language':'zh-Hans-CN','lines':lines}
        with patch.object(o,'metric_icons',return_value=[(300,660,340,695),(420,660,460,695),(560,660,600,695)]):
            parsed=o.prepare_frame(frame,full,read_counts=False)
        self.assertEqual(len(parsed['rows']),1);self.assertEqual(parsed['rows'][0]['status'],'该篇笔记已不被推荐给未关注用户')

class BrowserRedirectTests(unittest.TestCase):
    current='mCurrentFocus=Window{x u0 com.vivo.browser/com.vivo.browser.BrowserActivity type=1}'
    resolver='mCurrentFocus=Window{x u0 com.android.intentresolver/com.android.intentresolver.DoubleAppResolverActivity type=1}'
    def test_observed_owner_resolver_defers_slot_proof_to_existing_selector(self):
        events=['collection_slot_requested:app1','xhs_cold_started']
        with patch.object(sync,'focus',return_value=self.resolver),patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
            self.assertTrue(sync.recover_vivo_browser_redirect('adb','serial','app1',self.current,lambda:None,events))
        self.assertEqual(adb.call_count,2)
        self.assertIn('vivo_browser_redirect_returned_to_resolver',events)
        self.assertIn('clone_user_requested:0',events)
        self.assertNotIn('clone_slot_selected:app1',events)
        with patch.object(sync,'focus',return_value=self.resolver):
            with self.assertRaisesRegex(RuntimeError,'slot'):
                sync.verify_collection_slot('adb','serial','app1',events)

    def test_observed_resolver_is_consumed_by_existing_owner_label_selection(self):
        root=ET.parse(SCRIPTS/'fixtures/xhs/vivo-browser-returned-resolver-43.xml').getroot()
        target=ET.Element('hierarchy');events=['collection_slot_requested:app1','xhs_cold_started','vivo_browser_redirect_reopened','clone_user_requested:0','vivo_browser_redirect_returned_to_resolver']
        owner='mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}'
        selected=[]
        def tap(_adb,_serial,_root,value,guard):selected.append(value)
        with patch.object(sync,'focus',side_effect=lambda *_:owner if selected else self.resolver),patch.object(sync,'creator_list',side_effect=lambda r:r is target),patch.object(sync,'creator_filter_panel',return_value=False),patch.object(sync,'recover_known_overlay',return_value=False),patch.object(sync,'tap_label',side_effect=tap),patch.object(sync,'navigation_capture',return_value=target),patch.object(sync,'adb',return_value='mWakefulness=Awake') as adb:
            self.assertIs(sync.ensure_creator_list('adb','serial',root,'app1',lambda:None,events),target)
            sync.verify_collection_slot('adb','serial','app1',events)
        self.assertEqual(selected,['小红书'])
        self.assertIn('clone_slot_selected:app1',events)
        self.assertTrue(all(call.args[2:]==('shell','dumpsys','power') for call in adb.call_args_list))

    def test_foreign_or_unknown_post_browser_surface_still_stops(self):
        for current in [self.resolver.replace('u0','u999'),self.resolver.replace('DoubleAppResolverActivity','OtherActivity'),self.resolver.replace('com.android.intentresolver/','com.android.intentresolver.fake/'),'mCurrentFocus=null']:
            with self.subTest(current=current),patch.object(sync,'focus',return_value=current),patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
                events=['collection_slot_requested:app1','xhs_cold_started']
                with self.assertRaisesRegex(RuntimeError,'owner foreground'):
                    sync.recover_vivo_browser_redirect('adb','serial','app1',self.current,lambda:None,events)
                self.assertNotIn('vivo_browser_redirect_returned_to_resolver',events)
                self.assertEqual(adb.call_count,2)

    def test_only_owner_cold_start_can_reopen_once_without_touching_browser_content(self):
        events=['collection_slot_requested:app1','xhs_cold_started']
        with patch.object(sync,'focus',return_value='mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}'),patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
            self.assertTrue(sync.recover_vivo_browser_redirect('adb','serial','app1',self.current,lambda:None,events))
            self.assertEqual(adb.call_count,2);self.assertEqual(adb.call_args_list[0].args[2:],('shell','input','keyevent','3'))
            with self.assertRaisesRegex(RuntimeError,'redirected.*again'):sync.recover_vivo_browser_redirect('adb','serial','app1',self.current,lambda:None,events)
            self.assertEqual(adb.call_count,2)
    def test_clone_other_browser_and_missing_cold_start_do_not_get_relaunch_actions(self):
        for slot,current,events in [('app2',self.current,['collection_slot_requested:app2','xhs_cold_started']),('app1',self.current.replace('u0','u999'),['collection_slot_requested:app1','xhs_cold_started']),('app1',self.current,[])]:
            with patch.object(sync,'adb') as adb:
                self.assertFalse(sync.recover_vivo_browser_redirect('adb','serial',slot,current,lambda:None,events));adb.assert_not_called()


class PairedDateTests(unittest.TestCase):
    def test_only_exact_duplicate_pairs_can_restore_the_date(self):
        import xhs_list_ocr as o
        self.assertEqual(o.paired_date_text('00 55 一 11 88'),'05-18')
        for invalid in ['0055-m88','0055-1288','055-1188','0055-11888','1122-3322']:
            with self.assertRaises(RuntimeError):o.paired_date_text(invalid)
    def test_five_glyph_structure_is_required_and_extra_ink_is_rejected(self):
        import cv2
        import xhs_list_ocr as o
        image=cv2.imread(str(SCRIPTS/'fixtures/xhs/date-05-18-binary.png'),0)
        self.assertIsNotNone(o.paired_date_image(image))
        self.assertIsNone(o.paired_date_image(image*0+255))
        extra=image.copy();extra[25:80,270:280]=0
        self.assertIsNone(o.paired_date_image(extra))
    def test_paired_binary_and_soft_values_corroborate_existing_primary_without_guessing(self):
        import xhs_list_ocr as o
        def item(text):return {'language':'zh-Hans-CN','lines':[{'text':text}] if text else []}
        values={'d_color':item(''),'d_binary':item('05-18'),'d_pair_binary':item('0055一1188'),'d_pair_soft':item('0055一1188')}
        self.assertEqual(o.equal_variants(values,'d',o.date_text),'05-18')
        values['d_pair_soft']=item('0055一2288')
        with self.assertRaisesRegex(RuntimeError,'contextual date values disagree'):o.equal_variants(values,'d',o.date_text)

class AdditionalInkProofTests(unittest.TestCase):
    @staticmethod
    def item(text):return {'language':'zh-Hans-CN','lines':[{'text':text}] if text else []}
    def test_single_low_resolution_date_requires_both_full_context_and_glyph_pairs(self):
        import xhs_list_ocr as o
        values={k:self.item(v) for k,v in {'d_color':'','d_binary':'','d_small':'09-15','d_context_binary':'09-16','d_context_contrast':'09-16','d_pair_binary':'0099一1166','d_pair_contrast':'0099一1166'}.items()}
        self.assertEqual(o.equal_variants(values,'d',o.date_text),'09-16')
        for key in ['d_pair_binary','d_pair_contrast','d_context_binary']:
            smaller={k:v for k,v in values.items() if k!=key}
            with self.assertRaises(RuntimeError):o.equal_variants(smaller,'d',o.date_text)
        values['d_binary']=self.item('09-15')
        # Two agreeing original primary values retain precedence.
        self.assertEqual(o.equal_variants(values,'d',o.date_text),'09-15')
        del values['d_small']
        with self.assertRaisesRegex(RuntimeError,'contextual date values disagree'):o.equal_variants(values,'d',o.date_text)
    def test_contextual_count_still_requires_two_exact_readings_and_original_agreement(self):
        import xhs_list_ocr as o
        values={'n_color':self.item(''),'n_binary':self.item(''),'n_context_binary':self.item('0000'),'n_context_contrast':self.item('0000')}
        self.assertEqual(o.equal_variants(values,'n',o.counter_text),'0000')
        values['n_context_contrast']=self.item('000')
        with self.assertRaisesRegex(RuntimeError,'values disagree'):o.equal_variants(values,'n',o.counter_text)
        values['n_context_contrast']=self.item('0000');values['n_binary']=self.item('000')
        with self.assertRaisesRegex(RuntimeError,'values disagree'):o.equal_variants(values,'n',o.counter_text)
        values['n_binary']=self.item('');del values['n_context_contrast']
        with self.assertRaisesRegex(RuntimeError,'two independently processed'):o.equal_variants(values,'n',o.counter_text)

class ConflictingSmallDateTests(unittest.TestCase):
    @staticmethod
    def readings():
        return {key:AdditionalInkProofTests.item(text) for key,text in {
            'd_color':'','d_binary':'','d_small':'09-15','d_double':'09-16',
            'd_context_binary':'09-16','d_context_contrast':'09-16',
            'd_pair_binary':'0099一1166','d_pair_contrast':'0099一笮66',
            'd_pair_context_binary':'0099一1166','d_pair_context_contrast':'0099一1166',
        }.items()}

    def test_conflicting_small_readings_need_two_full_contexts_and_two_mask_pairs(self):
        import xhs_list_ocr as o
        for small,double in [('09-15','09-16'),('09-16','09-15')]:
            values=self.readings();values['d_small']=AdditionalInkProofTests.item(small)
            values['d_double']=AdditionalInkProofTests.item(double)
            self.assertEqual(o.equal_variants(values,'d',o.date_text),'09-16')

    def test_missing_distinct_mask_or_context_proof_still_rejects(self):
        import xhs_list_ocr as o
        for removed in [('d_context_binary',),('d_pair_context_contrast',),
                        ('d_pair_contrast','d_pair_context_contrast')]:
            values=self.readings()
            for key in removed:del values[key]
            with self.subTest(removed=removed),self.assertRaises(RuntimeError):
                o.equal_variants(values,'d',o.date_text)

    def test_strong_primary_conflicts_cannot_be_overridden(self):
        import xhs_list_ocr as o
        for extra in [{'d_binary':'09-15'}, {'d_binary':'09-16'},
                      {'d_binary':'09-15','d_contrast':'09-16'}]:
            values=self.readings()
            values.update({key:AdditionalInkProofTests.item(text) for key,text in extra.items()})
            with self.subTest(extra=extra),self.assertRaisesRegex(RuntimeError,'primary date values disagree'):
                o.equal_variants(values,'d',o.date_text)

    def test_pair_context_cannot_overturn_valid_pair_or_supply_unproven_language(self):
        import xhs_list_ocr as o
        for mutate in ('conflict','language','not_in_weak_readings'):
            values=self.readings()
            if mutate=='conflict':values['d_pair_contrast']=AdditionalInkProofTests.item('0099一1155')
            if mutate=='language':values['d_pair_context_contrast']['language']='en-US'
            if mutate=='not_in_weak_readings':
                values['d_small']=AdditionalInkProofTests.item('09-14')
                values['d_double']=AdditionalInkProofTests.item('09-15')
            with self.subTest(mutate=mutate),self.assertRaises(RuntimeError):
                o.equal_variants(values,'d',o.date_text)

    def test_observed_pair_context_keeps_exact_ink_and_excludes_static_prefix(self):
        import cv2,numpy as np,tempfile
        import xhs_list_ocr as o
        frame=cv2.imread(str(SCRIPTS/'fixtures/xhs/date-09-16-155.png'))
        prepared={'rows':[{'dateBox':[0,0,frame.shape[1],frame.shape[0]],'weakCountFields':[]}]}
        with tempfile.TemporaryDirectory() as directory:
            o.crop_requests(frame,prepared,directory)
            readings={key.replace('d_','r0_date_'):value for key,value in self.readings().items()
                      if '_pair' not in key}
            for key,value in readings.items():value['id']=key
            requests=o.paired_date_requests(prepared,list(readings.values()),directory)
            for variant in ('binary','contrast'):
                original=cv2.imread(str(Path(directory)/f'r0_date_{variant}.png'),0)
                paired=o.paired_date_image(original);self.assertIsNotNone(paired)
                context=next(item for item in requests if item['id']==f'r0_date_pair_context_{variant}')
                left,top,right,bottom=context['dateContentBox']
                image=cv2.imread(context['path'],0)
                self.assertTrue(np.array_equal(image[top:bottom,left:right],paired))
                result={'width':image.shape[1],'height':image.shape[0],'lines':[{'words':[
                    {'text':'DATE:','x':1,'y':top,'width':left-20,'height':20},
                    {'text':'0099一1166','x':left+20,'y':top+30,'width':right-left-60,'height':40}]}]}
                filtered=o.context_date_result(result,context['dateContentBox'])
                self.assertEqual(o.paired_date_text(filtered['lines'][0]['text']),'09-16')

class TitleGeometryTests(unittest.TestCase):
    def test_small_trailing_fragment_does_not_replace_main_title(self):
        import numpy as np
        import xhs_list_ocr as o
        from test_xhs_list_ocr import line,result
        frame=np.full((2400,1080,3),255,np.uint8);frame[254:261,330:500]=(40,30,240)
        lines=[line(t,b) for t,b in result()['headers'].items()]+[line('主要标题',(300,500,800,550)),line('/丶',(940,502,980,520)),line('笔记状态正常',(300,600,950,640))]
        full={'width':1080,'height':2400,'language':'zh-Hans-CN','lines':lines}
        with patch.object(o,'metric_icons',return_value=[(300,660,340,695),(420,660,460,695),(560,660,600,695)]):
            parsed=o.prepare_frame(frame,full,read_counts=False)
        self.assertEqual(parsed['rows'][0]['title'],'主要标题')
    def test_clipped_first_title_is_not_a_new_card(self):
        import numpy as np
        import xhs_list_ocr as o
        from test_xhs_list_ocr import line,result
        frame=np.full((2400,1080,3),255,np.uint8);frame[254:261,330:500]=(40,30,240)
        lines=[line(t,b) for t,b in result()['headers'].items()]+[line('乱码残行',(300,420,800,434)),line('笔记状态正常',(300,480,950,515)),line('第二篇标题',(300,650,800,690)),line('笔记状态正常',(300,760,950,800))]
        full={'width':1080,'height':2400,'language':'zh-Hans-CN','lines':lines}
        with patch.object(o,'metric_icons',return_value=[(300,830,340,865),(420,830,460,865),(560,830,600,865)]):
            parsed=o.prepare_frame(frame,full,read_counts=False)
        self.assertTrue(parsed['leadingClip']);self.assertEqual(len(parsed['rows']),1);self.assertEqual(parsed['rows'][0]['title'],'第二篇标题')


class SplitTitleTests(unittest.TestCase):
    def test_two_crop_readings_can_restore_prefix_but_not_replace_existing_content(self):
        import xhs_list_ocr as o
        row={'title':'十月新权益上线!能帮一个是..'}
        def results(a,b):return {f'r5_title_{v}':{'language':'zh-Hans-CN','lines':[{'text':t}]} for v,t in [('color',a),('binary',b)]}
        proof=results('秦MAX十月新权益上线!能帮一个是.','秦MAX十月新权益上线!能帮一个是.“')
        self.assertTrue(o.resolve_title_crop(row,5,proof).startswith('秦MAX'))
        for values in [results('秦MAX十月新权益上线!能帮一个是.','宋MAX十月新权益上线!能帮一个是.'),results('秦MAX十月价格调整','秦MAX十月价格调整')]:
            with self.assertRaisesRegex(RuntimeError,'content disagrees'):o.resolve_title_crop(row,5,values)
        proof['r5_title_binary']['lines']=[]
        with self.assertRaisesRegex(RuntimeError,'two complete readings'):o.resolve_title_crop(row,5,proof)


class CompleteRepeatedCountTests(unittest.TestCase):
    def test_missing_first_digit_is_not_a_complete_count_vote(self):
        import xhs_list_ocr as o
        row={'verifiedCounts':['268','0','0'],'weakCountFields':[0]}
        def item(text):return {'language':'zh-Hans-CN','lines':[{'text':text}]}
        values={'r1_view_color':item('68 268'),'r1_view_binary':item('268 268'),'r1_view_contrast':item('268 268')}
        self.assertEqual(o.corroborate_counts(row,1,values),['268','0','0'])
        values['r1_view_color']=item('282 282')
        with self.assertRaisesRegex(RuntimeError,'values disagree'):o.corroborate_counts(row,1,values)
        values['r1_view_color']=item('68 268');del values['r1_view_contrast']
        with self.assertRaisesRegex(RuntimeError,'two independently processed'):o.corroborate_counts(row,1,values)
    def test_repetition_structure_does_not_fill_or_guess_any_digit(self):
        import xhs_list_ocr as o
        self.assertEqual(o.repeated_counter_text('268 268',2),'268268')
        self.assertEqual(o.repeated_counter_text('0 0 0 0',4),'0000')
        for raw,repeats in [('68268',2),('268269',2),('OO00',4),('000',4),('',2)]:
            with self.assertRaises(RuntimeError):o.repeated_counter_text(raw,repeats)

class SettlingKeyguardTests(unittest.TestCase):
    def test_foreground_app_is_never_swiped_while_waiting_for_delayed_unlocked_policy(self):
        locked=KeyguardTests.locked;policies=iter([locked]*4+[locked.replace('showing=true','showing=false')])
        def command(_adb,_serial,*args,**kw):return next(policies) if args[-1]=='policy' else ''
        focuses=iter(['mCurrentFocus=Window{x u0 NotificationShade}'])
        with patch.object(sync,'adb',side_effect=command) as adb,patch.object(sync,'focus',side_effect=lambda *args:next(focuses,'mCurrentFocus=Window{x u0 com.xingin.xhs/.SplashAdActivity}')),patch.object(sync.time,'sleep'):
            self.assertTrue(sync.dismiss_unsecured_keyguard('adb','serial',lambda:None,[]))
        self.assertFalse(any('swipe' in c.args for c in adb.call_args_list))
    def test_persistently_unproven_surface_stops_without_a_swipe(self):
        with patch.object(sync,'adb',side_effect=lambda a,b,*args,**kw:KeyguardTests.locked if args[-1]=='policy' else '') as adb,patch.object(sync,'focus',return_value='mCurrentFocus=null'),patch.object(sync.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'swipe surface is not proven'):sync.dismiss_unsecured_keyguard('adb','serial',lambda:None,[])
        self.assertFalse(any('swipe' in c.args for c in adb.call_args_list))


class MissingTitleSuffixTests(unittest.TestCase):
    def test_two_visible_glyphs_outside_native_box_require_full_title_reading(self):
        import cv2,numpy as np,xhs_list_ocr as o
        frame=np.full((1600,720,3),255,np.uint8)
        cv2.putText(frame,'AB',(530,230),cv2.FONT_HERSHEY_SIMPLEX,1,(30,30,30),2)
        self.assertTrue(o.title_has_unread_suffix(frame,[193,205,484,233]))
        frame[:]=255
        cv2.circle(frame,(540,225),2,(30,30,30),-1)
        self.assertFalse(o.title_has_unread_suffix(frame,[193,205,484,233]))
    def test_suffix_proof_still_requires_two_matching_complete_crops(self):
        import xhs_list_ocr as o
        row={'title':'奔驰GLC十月新权益上线'}
        values={f'r0_title_{v}':{'language':'zh-Hans-CN','lines':[{'text':'奔驰GLC十月新权益上线果然没白等!'}]} for v in ['color','binary']}
        self.assertEqual(o.resolve_title_crop(row,0,values),'奔驰GLC十月新权益上线果然没白等!')
        values['r0_title_binary']['lines'][0]['text']='奔驰GLC十月新权益上线'
        with self.assertRaises(RuntimeError):o.resolve_title_crop(row,0,values)


class CollinearTitleTests(unittest.TestCase):
    def sample(self):
        import json
        data = json.loads((SCRIPTS/'fixtures/xhs/title-collinear-141.json').read_text())
        return data['row'], {f'r0_title_{k}':v for k,v in data['readings'].items()}

    def test_observed_two_ocr_lines_on_one_visual_baseline_are_complete(self):
        import xhs_list_ocr as o
        row, readings = self.sample()
        self.assertEqual(o.resolve_title_crop(row,0,readings),
                         o.compact(readings['r0_title_color']['lines'][0]['text']))

    def test_wrapped_or_overlapping_or_outside_crop_lines_remain_unproven(self):
        import xhs_list_ocr as o
        for mode in ['wrapped','overlap','outside','missing_words','dimensions','three_lines']:
            row, readings = self.sample()
            item = readings['r0_title_binary']
            with self.subTest(mode=mode):
                if mode == 'missing_words':item['lines'][1]['words'] = []
                elif mode == 'dimensions':item['width'] += 1
                elif mode == 'three_lines':item['lines'].append(item['lines'][0])
                else:
                    for word in item['lines'][1]['words']:
                        if mode == 'wrapped':word['y'] += 20
                        elif mode == 'overlap':word['x'] -= 1000
                        else:word['x'] += item['width']
                with self.assertRaises(RuntimeError):o.resolve_title_crop(row,0,readings)

    def test_collinear_text_still_requires_matching_dual_readings_and_prefix(self):
        import xhs_list_ocr as o
        for mode in ['changed_suffix','missing_prefix']:
            row, readings = self.sample()
            if mode == 'changed_suffix':
                line = readings['r0_title_binary']['lines'][1]
                line['words'][0]['text'] = '变'
                line['text'] = ' '.join(word['text'] for word in line['words'])
            else:row['title'] = '另一个标题'
            with self.subTest(mode=mode), self.assertRaises(RuntimeError):
                o.resolve_title_crop(row,0,readings)


class TransientReadTransportTests(unittest.TestCase):
    def test_only_missing_target_window_read_can_wait_and_repeat_the_same_read(self):
        missing = Mock(returncode=1,stderr=b"adb.exe: device 'serial' not found",stdout=b'')
        good = Mock(returncode=0,stderr=b'',stdout=b'window')
        with patch.object(sync.subprocess,'run',side_effect=[missing,good]) as run, patch.object(sync.time,'sleep'):
            self.assertEqual(sync.adb('adb','serial','shell','dumpsys','window',timeout=8),'window')
        self.assertEqual(run.call_count,2)
        self.assertEqual(run.call_args_list[0],run.call_args_list[1])

    def test_missing_window_read_still_stops_after_a_small_finite_budget(self):
        missing = Mock(returncode=1,stderr=b"adb.exe: device 'serial' not found",stdout=b'')
        with patch.object(sync.subprocess,'run',return_value=missing) as run, patch.object(sync.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'not found'):
                sync.adb('adb','serial','shell','dumpsys','window',timeout=8)
        self.assertLessEqual(run.call_count,3)

    def test_no_input_setting_write_unknown_command_or_foreign_serial_is_retried(self):
        cases=[(('shell','input','tap','10','20'),b"device 'serial' not found"),
               (('shell','settings','put','system','screen_off_timeout','600000'),b"device 'serial' not found"),
               (('shell','am','start','-n','activity'),b"device 'serial' not found"),
               (('shell','dumpsys','window'),b"device 'other' not found"),
               (('shell','dumpsys','window'),b'cannot connect to daemon')]
        for args,stderr in cases:
            with self.subTest(args=args,stderr=stderr), patch.object(sync.subprocess,'run',return_value=Mock(returncode=1,stderr=stderr,stdout=b'')) as run, patch.object(sync.time,'sleep') as sleep:
                with self.assertRaises(RuntimeError):sync.adb('adb','serial',*args,timeout=8)
                self.assertEqual(run.call_count,1);sleep.assert_not_called()

    def test_ui_snapshot_and_binary_reads_keep_bytes_and_retry_only_missing_transport(self):
        cases=[('exec-out','uiautomator','dump','/dev/tty'),('exec-out','cat','/sdcard/task.xml'),
               ('shell','settings','get','system','screen_off_timeout'),
               ('get-state',),('shell','dumpsys','power')]
        for args in cases:
            missing=Mock(returncode=1,stderr=b"device 'serial' not found",stdout=b'partial')
            good=Mock(returncode=0,stderr=b'',stdout=b'\x89PNG\x00\xff')
            with self.subTest(args=args), patch.object(sync.subprocess,'run',side_effect=[missing,good]) as run, patch.object(sync.time,'sleep'):
                self.assertIs(sync.adb_process('adb','serial',*args,timeout=10),good)
                self.assertEqual(run.call_count,2)
                self.assertEqual(run.call_args_list[0],run.call_args_list[1])

    def test_timeout_outcome_never_reissues_a_command(self):
        with patch.object(sync.subprocess,'run',side_effect=sync.subprocess.TimeoutExpired('adb',8)) as run:
            with self.assertRaises(sync.subprocess.TimeoutExpired):
                sync.adb('adb','serial','shell','dumpsys','window',timeout=8)
        self.assertEqual(run.call_count,1)


class ConfirmedCjkTitlePrefixTests(unittest.TestCase):
    def sample(self):
        import json
        data = json.loads((SCRIPTS/'fixtures/xhs/title-prefix-cjk-155.json').read_text())
        return data['row'], {f'r0_title_{k}':v for k,v in data['readings'].items()}

    def test_observed_single_cjk_full_frame_misread_requires_crop_consensus(self):
        import xhs_list_ocr as o
        row, readings = self.sample()
        self.assertEqual(o.resolve_title_crop(row,0,readings),
                         o.compact(readings['r0_title_color']['lines'][0]['text']))

    def test_identity_text_and_geometric_failures_still_reject_correction(self):
        import xhs_list_ocr as o
        for mode in ['two_cjk','ascii','short','outside','dimensions','missing_words']:
            row, readings = self.sample()
            if mode == 'two_cjk':row['title'] = '另'+row['title'][1:]
            elif mode == 'ascii':row['title'] = row['title'].replace('ABC','ABD')
            elif mode == 'short':row['title'] = row['title'][:4]
            elif mode == 'outside':row['titleBox'][0] = row['titleCropBox'][0]-1
            elif mode == 'dimensions':readings['r0_title_binary']['width'] += 1
            else:readings['r0_title_binary']['lines'][0]['words'] = []
            with self.subTest(mode=mode), self.assertRaises(RuntimeError):
                o.resolve_title_crop(row,0,readings)

    def test_one_cjk_correction_never_resolves_disagreeing_crop_readings(self):
        import xhs_list_ocr as o
        row, readings = self.sample()
        readings['r0_title_binary']['lines'][0]['text'] += '异'
        with self.assertRaisesRegex(RuntimeError,'disagrees'):
            o.resolve_title_crop(row,0,readings)


class BottomDateClipTests(unittest.TestCase):
    def test_offscreen_bottom_date_is_deferred_but_never_proves_end(self):
        import numpy as np,xhs_list_ocr as o
        from test_xhs_list_ocr import line,result
        frame=np.full((2400,1080,3),255,np.uint8);frame[254:261,330:500]=(40,30,240)
        lines=[line(t,b) for t,b in result()['headers'].items()]+[line('首条测试',(300,500,800,550)),line('笔记状态正常',(300,600,700,640)),line('底部测试',(300,2110,800,2150)),line('笔记状态正常',(300,2200,700,2240))]
        full={'width':1080,'height':2400,'language':'zh-Hans-CN','lines':lines}
        icons=[[(300,660,340,695),(420,660,460,695),(560,660,600,695)],[(300,2340,340,2380),(420,2340,460,2380),(560,2340,600,2380)]]
        with patch.object(o,'metric_icons',side_effect=icons):parsed=o.prepare_frame(frame,full,False)
        self.assertEqual(len(parsed['rows']),1);self.assertTrue(parsed['trailingClip']);self.assertFalse(parsed['markers'])
        full['lines'].append(line('到底了',(500,2300,580,2330)))
        with patch.object(o,'metric_icons',side_effect=icons),self.assertRaisesRegex(RuntimeError,'date crop is outside'):o.prepare_frame(frame,full,False)


class MidNavigationWakeTests(unittest.TestCase):
    def test_woken_display_must_also_pass_existing_unsecured_keyguard_proof(self):
        readings=iter(['mWakefulness=Asleep','', '', 'mWakefulness=Awake'])
        with patch.object(sync,'adb',side_effect=lambda *a,**kw:next(readings)),patch.object(sync,'dismiss_unsecured_keyguard',return_value=True) as dismiss,patch.object(sync.time,'sleep'):
            self.assertTrue(sync.wake_if_asleep('adb','serial',lambda:None,[]))
        self.assertEqual(dismiss.call_count,1)
    def test_secure_wake_failure_propagates_and_awake_phone_gets_no_dismiss(self):
        with patch.object(sync,'adb',return_value='mWakefulness=Awake'),patch.object(sync,'dismiss_unsecured_keyguard') as dismiss:
            self.assertFalse(sync.wake_if_asleep('adb','serial',lambda:None,[]));dismiss.assert_not_called()
        readings=iter(['mWakefulness=Asleep','','','mWakefulness=Awake'])
        with patch.object(sync,'adb',side_effect=lambda *a,**kw:next(readings)),patch.object(sync,'dismiss_unsecured_keyguard',side_effect=RuntimeError('secure keyguard')),patch.object(sync.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'secure keyguard'):sync.wake_if_asleep('adb','serial',lambda:None,[])

class DecimalUnitCropTests(unittest.TestCase):
    def test_unit_decimal_does_not_use_the_pixelated_variant_that_lost_its_dot(self):
        import tempfile,cv2,xhs_list_ocr as o
        frame=cv2.imread(str(SCRIPTS/'fixtures/xhs/counts-720.png'))
        import json
        sample=next(x for x in json.loads((SCRIPTS/'fixtures/xhs/counts-720.json').read_text()) if x['value']=='1.1万')
        row={'verifiedCounts':['1.1万','0','0'],'weakCountFields':[0],'numberBoxes':[sample['box']]*3}
        with tempfile.TemporaryDirectory() as d:requests=o.crop_requests(frame,{'rows':[row]},d,dates=False)
        self.assertEqual({x['id'] for x in requests},{'r0_view_color','r0_view_binary','r0_view_contrast'})
        def item(value):return {'language':'zh-Hans-CN','lines':[{'text':value}]}
        proof={'r0_view_color':item('1，1万'),'r0_view_binary':item('1.1万'),'r0_view_contrast':item('1.1万')}
        self.assertEqual(o.corroborate_counts(row,0,proof)[0],'1.1万')
        proof['r0_view_color']=item('1.2万')
        with self.assertRaisesRegex(RuntimeError,'values disagree'):o.corroborate_counts(row,0,proof)

class BrowserPermissionRedirectTests(unittest.TestCase):
    current='mCurrentFocus=Window{x u0 com.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity type=1}'
    events=['collection_slot_requested:app2','clone_user_requested:999','xhs_cold_started']
    def fixture(self):return ET.parse(SCRIPTS/'fixtures/xhs/vivo-browser-location-permission.xml').getroot()
    def test_observed_dialog_uses_home_and_exact_clone_without_permission_taps(self):
        events=list(self.events)
        with patch.object(sync,'focus',side_effect=[self.current,'mCurrentFocus=Window{x u0 com.bbk.launcher/.Launcher}','mCurrentFocus=Window{x u999 com.xingin.xhs/.index.v2.IndexActivityV2}']),patch.object(sync,'adb',return_value='vivo') as adb,patch.object(sync.time,'sleep'):
            self.assertTrue(sync.recover_vivo_browser_permission_redirect('adb','serial',self.fixture(),'app2',self.current,lambda:None,events))
        actions=[c.args[2:] for c in adb.call_args_list]
        self.assertEqual(actions[1],('shell','input','keyevent','3'))
        self.assertEqual(actions[2],('shell','am','start','-W','--user','999','-n','com.xingin.xhs/.index.v2.IndexActivityV2'))
        self.assertFalse(any('tap' in a or 'grant' in a for a in actions))
    def test_unknown_permission_or_unproven_clone_has_no_actions(self):
        root=self.fixture();root[0].set('text','“小红书”请求访问您的位置信息')
        for frame,events in [(root,self.events),(self.fixture(),self.events[:-1]),(self.fixture(),['collection_slot_requested:app2','xhs_cold_started']),(self.fixture(),self.events+['clone_user_requested:128']),(self.fixture(),self.events+['collection_slot_requested:app1'])]:
            with patch.object(sync,'adb') as adb:
                self.assertFalse(sync.recover_vivo_browser_permission_redirect('adb','serial',frame,'app2',self.current,lambda:None,list(events)));adb.assert_not_called()
    def test_changed_foreground_or_lost_guard_never_sends_home(self):
        for changed in [True,False]:
            guard=Mock(side_effect=None if changed else RuntimeError('occupied'))
            with patch.object(sync,'focus',return_value='other'),patch.object(sync,'adb',return_value='VIVO') as adb:
                with self.assertRaises(RuntimeError):sync.recover_vivo_browser_permission_redirect('adb','serial',self.fixture(),'app2',self.current,guard,list(self.events))
            self.assertFalse(any('input' in c.args for c in adb.call_args_list))
    def test_persistent_or_repeated_overlay_stops_without_tapping_permissions(self):
        with patch.object(sync,'adb') as adb:
            with self.assertRaisesRegex(RuntimeError,'repeated'):sync.recover_vivo_browser_permission_redirect('adb','serial',self.fixture(),'app2',self.current,lambda:None,self.events+['vivo_browser_permission_reopened'])
        adb.assert_not_called()
        with patch.object(sync,'focus',return_value=self.current),patch.object(sync,'adb',return_value='VIVO') as adb,patch.object(sync.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'stayed foreground'):sync.recover_vivo_browser_permission_redirect('adb','serial',self.fixture(),'app2',self.current,lambda:None,list(self.events))
        self.assertEqual(sum('input' in c.args for c in adb.call_args_list),1);self.assertFalse(any('start' in c.args for c in adb.call_args_list))




class ProvenSevenVariantTests(unittest.TestCase):
    def test_observed387_is_proven_by_both_ink_variants(self):
        import cv2,xhs_list_ocr as o
        frame=cv2.imread(str(SCRIPTS/'fixtures/xhs/number-387-47-v57.png'))
        box=[0,0,frame.shape[1],frame.shape[0]]
        self.assertEqual(o.numeric_cell(frame,box,allow_candidate=True),('387',False))
        self.assertEqual(o.numeric_cell(frame,box),'387')

    def test_all_preexisting_trusted_tiles_remain_byte_identical(self):
        import cv2,json,hashlib
        proof=json.loads((SCRIPTS/'fixtures/xhs/font7-47-v57-proof.json').read_text())
        atlas=cv2.imread(str(SCRIPTS/'xhs_ocr_digits.png'),0)
        trusted=b''.join(atlas[d*48:(d+1)*48,j*32:(j+1)*32].tobytes() for d,n in enumerate(proof['priorTrustedCounts']) for j in range(n))
        self.assertEqual(hashlib.sha256(trusted).hexdigest(),proof['priorTrustedTilesSha256'])

    def test_native_conflict_is_still_rejected_when_corroboration_is_required(self):
        import xhs_list_ocr as o
        row={'verifiedCounts':['387','0','0'],'weakCountFields':[0]}
        values={f'r1_view_{v}':AdditionalInkProofTests.item(text) for v,text in [('color',''),('binary','587587'),('contrast','387387'),('nearest','387387')]}
        with self.assertRaisesRegex(RuntimeError,'values disagree'):o.corroborate_counts(row,1,values)

class ProximityWakeOrderingTests(unittest.TestCase):
    def test_keyguard_deferral_is_explicit_and_other_wake_callers_keep_their_check(self):
        for deferred in (False,True):
            powers=iter(['mWakefulness=Asleep','mWakefulness=Awake'])
            def command(_adb,_serial,*args,**kw):return next(powers) if args==('shell','dumpsys','power') else ''
            with patch.object(sync,'adb',side_effect=command),patch.object(sync,'dismiss_unsecured_keyguard') as dismiss,patch.object(sync.time,'sleep'):
                if deferred:sync.wake_if_asleep('adb','serial',lambda:None,[],dismiss_lock=False)
                else:sync.wake_if_asleep('adb','serial',lambda:None,[])
            self.assertEqual(dismiss.call_count,0 if deferred else 1)

    def run_main(self,fail_collect=False,secure=False):
        import tempfile,subprocess,json
        state={'asleep':True,'guide':True,'showing':True,'timeout':'60000','proximity':'1'};calls=[]
        def command(_adb,_serial,*args,**kw):
            cmd=tuple(args);calls.append(cmd)
            if cmd[:3]==('shell','settings','get'):
                return state['timeout' if cmd[4]=='screen_off_timeout' else 'proximity']
            if cmd[:3]==('shell','settings','put'):
                key='timeout' if cmd[4]=='screen_off_timeout' else 'proximity';state[key]=cmd[5]
                if key=='proximity':state['guide']=cmd[5]=='1'
                return ''
            if cmd==('shell','dumpsys','power'):return 'mWakefulness='+('Asleep' if state['asleep'] else 'Awake')
            if cmd==('shell','input','keyevent','224'):state['asleep']=False;return ''
            if cmd==('shell','dumpsys','window'):
                return 'mCurrentFocus=Window{x u0 '+('ScreenOnProximitySensorGuide' if state['guide'] else 'NotificationShade')+'}'
            if cmd==('shell','dumpsys','window','policy'):
                return 'mKeyguardOccluded=false\nKeyguardServiceDelegate\n showing='+str(state['showing']).lower()+'\n secure='+str(secure).lower()+'\nKeyguardStateMonitor\n'
            if cmd==('shell','input','keyevent','82'):
                if state['guide']:raise subprocess.TimeoutExpired(['adb','shell','input','keyevent','82'],7)
                state['showing']=False
            return ''
        def collect(args):
            self.assertFalse(state['guide']);self.assertEqual(state['proximity'],'0')
            sync.dismiss_unsecured_keyguard('adb','serial',lambda:None,[])
            if fail_collect:raise RuntimeError('synthetic collect failure')
            return {'notes':[],'complete':True,'scrolls':0,'warnings':[],'recovery_events':[]}
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'output.json';argv=['collector','--serial','serial','--adb','adb','--device-name','141','--device-cache','fake-cache','--app-slot','app1','--output',str(output)]
            with patch.object(sys,'argv',argv),patch.object(sync,'adb',side_effect=command),patch.object(sync,'assert_idle'),patch.object(sync,'collect',side_effect=collect),patch.object(sync.time,'sleep'),patch('builtins.print'):
                if secure:
                    with self.assertRaisesRegex(RuntimeError,'manual unlock'):sync.main()
                elif fail_collect:
                    with self.assertRaisesRegex(RuntimeError,'synthetic collect failure'):sync.main()
                else:self.assertEqual(sync.main(),0)
            result=json.loads(output.read_text()) if output.exists() else None
        self.assertEqual(state['timeout'],'60000');self.assertEqual(state['proximity'],'1')
        return calls,result

    def test_asleep_proximity_guide_is_removed_before_any_menu_dismissal(self):
        calls,result=self.run_main()
        disabled=calls.index(('shell','settings','put','global','enable_screen_on_proximity_sensor','0'))
        menu=calls.index(('shell','input','keyevent','82'));self.assertLess(disabled,menu)
        self.assertIn('proximity_guard_temporarily_disabled',result['recovery_events'])

    def test_collect_failure_restores_both_exact_original_settings(self):
        calls,result=self.run_main(fail_collect=True);self.assertIsNone(result)
        self.assertEqual(calls.count(('shell','settings','put','global','enable_screen_on_proximity_sensor','0')),1)
        self.assertEqual(calls.count(('shell','settings','put','global','enable_screen_on_proximity_sensor','1')),1)

    def test_secure_lock_still_requires_manual_unlock_and_restores_settings(self):
        calls,result=self.run_main(secure=True);self.assertIsNone(result)
        self.assertNotIn(('shell','input','keyevent','82'),calls)
        self.assertFalse(any(c[:3]==('shell','input','swipe') for c in calls))

    def test_setting_that_already_removed_the_guide_needs_no_volume_key(self):
        calls,_=self.run_main()
        self.assertNotIn(('shell','input','keyevent','24'),calls)

class HeaderClippedTitleTests(unittest.TestCase):
    def prepare(self,case):
        import json,numpy as np,xhs_list_ocr as o
        from test_xhs_list_ocr import line
        proof=json.loads((SCRIPTS/'fixtures/xhs/header-title-geometry-141-proof.json').read_text())
        data=proof[case];box=data['titleBox'];top=box[1]
        frame=np.full((proof['height'],proof['width'],3),255,np.uint8)
        full={'width':720,'height':1600,'language':'zh-Hans-CN','textAngle':0,'lines':[
            line('数据中心',(250,90,450,120)),line('作品分析',(210,190,360,218)),line('全部笔记',(30,282,150,data['headerBottom'])),
            line('合成标题甲',box),line('笔记状态正常',(227,top+63,390,top+88)),
            line('合成标题乙',(193,top+280,640,top+305)),line('笔记状态正常',(227,top+343,390,top+368))]}
        def icons(_frame,y1,y2,left):return [(194,y1+10,214,y1+30),(280,y1+10,300,y1+30),(390,y1+10,410,y1+30)]
        with patch.object(o,'selected_works_underline',return_value=True),patch.object(o,'metric_icons',side_effect=icons) as metric:
            prepared=o.prepare_frame(frame,full,read_counts=False)
        return prepared,metric.call_count

    def test_observed_clipped_row_with_missing_prefix_is_not_a_second_post(self):
        result,calls=self.prepare('clippedMissingPrefix')
        self.assertTrue(result['leadingClip']);self.assertEqual([r['title'] for r in result['rows']],['合成标题乙']);self.assertEqual(calls,1)

    def test_observed_clipped_row_is_rejected_even_when_native_box_includes_prefix(self):
        result,calls=self.prepare('clippedWithNativePrefix')
        self.assertTrue(result['leadingClip']);self.assertEqual([r['title'] for r in result['rows']],['合成标题乙']);self.assertEqual(calls,1)

    def test_actual_complete_newest_row_spacing_keeps_both_rows(self):
        result,calls=self.prepare('completeFirstRow')
        self.assertFalse(result['leadingClip']);self.assertEqual(len(result['rows']),2);self.assertEqual(calls,2)

class StalledMoreLoadingTests(unittest.TestCase):
    current = 'mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'

    def loading(self):
        return ET.parse(SCRIPTS/'fixtures/xhs/blank-works-loading-18.xml').getroot()

    def overview(self):
        root=ET.Element('hierarchy')
        for index,text in enumerate(['创作中心','最新笔记','更多','近 7 日数据','观看']):
            ET.SubElement(root,'node',{'package':sync.XHS_PACKAGE,'class':'android.widget.TextView','text':text,'bounds':f'[10,{index*100+10}][200,{index*100+80}]'})
        return root

    def test_more_spinner_returns_to_proven_center_and_uses_existing_overview_route(self):
        ready=ET.Element('hierarchy')
        for index,text in enumerate(['数据中心','作品分析','全部笔记']):
            ET.SubElement(ready,'node',{'package':sync.XHS_PACKAGE,'text':text,'bounds':f'[10,{index*100+10}][200,{index*100+80}]'})
        blank=self.loading();events=['collection_slot_requested:app1'];guard=Mock()
        first=self.overview()
        first.remove(next(n for n in first if n.get('text')=='近 7 日数据'))  # More fallback when overview is not proven.
        with patch.object(sync,'DATA_CENTER_LOAD_SECONDS',1),patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'focus',return_value=self.current),patch.object(sync,'recover_known_overlay',return_value=False),patch.object(sync,'open_works_tab',return_value=False),patch.object(sync,'tap_label') as tap,patch.object(sync,'adb') as adb,patch.object(sync,'navigation_capture',side_effect=[blank,blank,blank,self.overview(),ready]),patch.object(sync.time,'sleep'):
            self.assertIs(sync.ensure_creator_list('adb','serial',first,'app1',guard,events),ready)
        self.assertEqual([c.args[3] for c in tap.call_args_list],['更多','观看'])
        adb.assert_called_once_with('adb','serial','shell','input','keyevent','4',timeout=7)
        self.assertIn('data_center_loading_reopen:1',events)
        self.assertGreater(guard.call_count,1)

    def test_loading_signature_rejects_titles_foreign_package_and_unbounded_spinner(self):
        self.assertTrue(sync.blank_works_loading(self.loading()))
        for mutate in ('text','package','bounds'):
            root=self.loading();node=next(n for n in root.iter('node') if n.get('class')=='android.widget.ImageView')
            node.set(mutate,{'text':'合成笔记标题','package':'com.android.settings','bounds':'[0,0][1080,2132]'}[mutate])
            self.assertFalse(sync.blank_works_loading(root))

    def test_wrong_slot_foreground_and_missing_center_never_select_another_entry(self):
        for current,center in [(self.current.replace('u0 ','u999 '),self.overview()),(self.current,ET.Element('hierarchy'))]:
            with patch.object(sync,'focus',return_value=current),patch.object(sync,'navigation_capture',return_value=center),patch.object(sync,'tap_label') as tap,patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
                with self.assertRaises(RuntimeError):sync.reopen_blank_more('adb','serial',self.loading(),lambda:None,['collection_slot_requested:app1'])
            tap.assert_not_called()
            self.assertEqual(adb.call_count,0 if 'u999 ' in current else 1)

    def test_unknown_blank_page_without_a_more_attempt_never_gets_back_or_taps(self):
        with patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'focus',return_value=self.current),patch.object(sync,'recover_known_overlay',return_value=False),patch.object(sync,'open_works_tab',return_value=False),patch.object(sync,'navigation_capture',return_value=self.loading()),patch.object(sync,'tap_label') as tap,patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'could not prove'):sync.ensure_creator_list('adb','serial',self.loading(),'app1',lambda:None,['collection_slot_requested:app1'])
        tap.assert_not_called();adb.assert_not_called()

class FocuslessDisplayTests(unittest.TestCase):
    # These sections are from `dumpsys window`; `window policy` omits them.
    off = '  Display: mDisplayId=90000 (organized)\n    mAwake=true mScreenOnEarly=true mScreenOnFully=true\n  Display: mDisplayId=0 (organized)\n    mAwake=true mScreenOnEarly=false mScreenOnFully=false\n'
    on = off.replace('mScreenOnEarly=false mScreenOnFully=false','mScreenOnEarly=true mScreenOnFully=true')
    events = ['collection_slot_requested:app2','clone_user_requested:999']

    def test_virtual_display_does_not_hide_the_default_screen_off_state(self):
        self.assertTrue(sync.default_display_unlit(self.off))
        self.assertFalse(sync.default_display_unlit(self.on))
        self.assertFalse(sync.default_display_unlit(self.off.replace('mDisplayId=0 ','mDisplayId=1 ')))
        self.assertFalse(sync.default_display_unlit(self.off+self.off))

    def test_focusless_awake_default_panel_is_woken_once_and_checked(self):
        calls=[];policies=iter([self.off,self.on])
        def command(_adb,_serial,*args,**kw):
            calls.append(args)
            if args==('shell','dumpsys','window'):return next(policies)
            if args==('shell','dumpsys','power'):return 'mWakefulness=Awake'
            return ''
        events=list(self.events)
        with patch.object(sync,'adb',side_effect=command),patch.object(sync,'focus',return_value=''),patch.object(sync,'dismiss_unsecured_keyguard') as unlock,patch.object(sync.time,'sleep'):
            self.assertTrue(sync.wake_focusless_display('adb','serial',lambda:None,events))
        self.assertEqual([c for c in calls if c[:2]==('shell','input')],[('shell','input','keyevent','224')])
        self.assertNotIn(('shell','dumpsys','window','policy'),calls)
        unlock.assert_called_once()
        self.assertIn('focusless_default_display_woken',events)

    def test_uncertain_active_or_already_attempted_states_never_send_a_key(self):
        cases=[(self.on,'','mWakefulness=Awake',self.events),(self.off,'mCurrentFocus=Window{x u0 com.android.settings/.Settings}','mWakefulness=Awake',self.events),(self.off,'','mWakefulness=Asleep',self.events),(self.off,'','mWakefulness=Awake',self.events+['focusless_default_display_wake_attempted']),(self.off,'','mWakefulness=Awake',[])]
        for policy,current,power,events in cases:
            calls=[]
            def command(_adb,_serial,*args,**kw):
                calls.append(args)
                return policy if args==('shell','dumpsys','window') else power
            with patch.object(sync,'adb',side_effect=command),patch.object(sync,'focus',return_value=current),patch.object(sync.time,'sleep'):
                self.assertFalse(sync.wake_focusless_display('adb','serial',lambda:None,list(events)))
            self.assertFalse(any(c[:2]==('shell','input') for c in calls))

    def test_panel_that_does_not_light_stops_without_a_second_key(self):
        calls=[]
        def command(_adb,_serial,*args,**kw):
            calls.append(args)
            return self.off if args==('shell','dumpsys','window') else 'mWakefulness=Awake'
        with patch.object(sync,'adb',side_effect=command),patch.object(sync,'focus',return_value=''),patch.object(sync.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'default display stayed unlit'):sync.wake_focusless_display('adb','serial',lambda:None,list(self.events))
        self.assertEqual(sum(c[:2]==('shell','input') for c in calls),1)

    def test_xml_failure_with_empty_focus_recaptures_only_after_confirmed_wake(self):
        ready=ET.Element('hierarchy');events=list(self.events)
        with patch.object(sync,'capture',side_effect=[RuntimeError('UIAutomator did not return an XML hierarchy'),ready]) as capture,patch.object(sync,'focus',return_value=''),patch.object(sync,'wake_focusless_display',return_value=True) as wake:
            self.assertIs(sync.navigation_capture('adb','serial',lambda:None,events),ready)
        self.assertEqual(capture.call_count,2);wake.assert_called_once()

if __name__ == '__main__':unittest.main()
