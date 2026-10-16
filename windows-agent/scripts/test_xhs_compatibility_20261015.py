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
            def command(_adb,_serial,*args,**kwargs):return next(policies) if args[-1]=='policy' else ''
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
        self.assertEqual(sync.note_cards(root),[])
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

    def test_active_image_mode_keeps_proven_xml_filter_navigation(self):
        import xhs_list_ocr as ocr
        frame,full=self.observed();root=ocr.hierarchy_for_frame(ocr.filter_navigation_frame(frame,full))
        with patch.object(sync.os,'name','nt'),patch.object(sync,'capture',return_value=root),patch.object(sync,'image_navigation_capture') as image:
            self.assertIs(sync.navigation_capture('adb','serial',lambda:None,['works_list_image_reader_active']),root)
        image.assert_not_called()

    def test_ensure_closes_only_the_panel_before_accepting_a_list(self):
        import xhs_list_ocr as ocr
        frame,full=self.observed();root=ocr.hierarchy_for_frame(ocr.filter_navigation_frame(frame,full))
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

class IndexImageNavigationTests(unittest.TestCase):
    def observed(self):
        import cv2
        from test_xhs_list_ocr import line
        frame=cv2.imread(str(SCRIPTS/'fixtures/xhs/index-navigation.png'))
        full={'width':1080,'height':2400,'language':'zh-Hans-CN','lines':[line('首页',(58,2182,157,2231)),line('我',(951,2184,994,2227))]}
        return frame,full
    def test_exact_bottom_anchors_and_center_red_control_are_required(self):
        import xhs_list_ocr as o
        frame,full=self.observed();r=o.profile_navigation_anchors(frame,full);self.assertEqual(r['labels']['我'],(951,2184,994,2227))
        frame[:,450:630]=255
        with self.assertRaisesRegex(RuntimeError,'center publish control'):o.profile_navigation_anchors(frame,full)
        frame,full=self.observed();full['lines'][1]['words'][0]['y']=1500
        with self.assertRaisesRegex(RuntimeError,'bottom navigation'):o.profile_navigation_anchors(frame,full)
    def test_overlay_copy_blocks_index_navigation(self):
        import xhs_list_ocr as o
        from test_xhs_list_ocr import line
        frame,full=self.observed();full['lines'].append(line('存草稿',(400,1200,600,1250)))
        with self.assertRaisesRegex(RuntimeError,'unhandled overlay'):o.profile_navigation_anchors(frame,full)
    def test_two_identical_frames_select_only_my_and_reject_repeat_or_wrong_user(self):
        import xhs_list_ocr as o
        current='mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}'
        _,full=self.observed();frame={'labels':{'我':(951,2184,994,2227)}}
        events=['collection_slot_requested:app1']
        with patch.object(o,'read_profile_navigation',return_value=frame),patch.object(sync,'focus',return_value=current),patch.object(sync.subprocess,'run',return_value=Mock(returncode=0,stdout=b'png')),patch.object(sync,'adb') as adb,patch.object(sync,'navigation_capture',return_value=ET.Element('hierarchy')),patch.object(sync.time,'sleep'):
            sync.select_image_profile_after_dump_failure('adb','serial',current,lambda:None,events)
            self.assertEqual(adb.call_args.args[2:],('shell','input','tap','972','2205'))
            with self.assertRaises(RuntimeError):sync.select_image_profile_after_dump_failure('adb','serial',current,lambda:None,events)
            self.assertEqual(adb.call_count,1)
        with patch.object(sync,'adb') as adb:
            with self.assertRaisesRegex(RuntimeError,'requested slot'):sync.select_image_profile_after_dump_failure('adb','serial',current,lambda:None,['collection_slot_requested:app2','clone_user_requested:999'])
            adb.assert_not_called()
    def test_changed_bottom_bar_never_triggers_a_tap(self):
        import xhs_list_ocr as o
        current='mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}'
        with patch.object(o,'read_profile_navigation',side_effect=[{'labels':{'我':(1,2,3,4)}},{'labels':{'我':(2,2,4,4)}}]),patch.object(sync,'focus',return_value=current),patch.object(sync.subprocess,'run',return_value=Mock(returncode=0,stdout=b'png')),patch.object(sync,'adb') as adb:
            with self.assertRaisesRegex(RuntimeError,'changed between captures'):sync.select_image_profile_after_dump_failure('adb','serial',current,lambda:None,['collection_slot_requested:app1'])
            adb.assert_not_called()

if __name__ == '__main__':unittest.main()
