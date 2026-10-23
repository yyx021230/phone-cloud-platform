"""Startup-only native-element retry; all device/ADB operations are mocked."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch, Mock
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('startup_sync', Path(__file__).with_name('小红书数据同步.py'))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
ERROR = 'UIAutomator did not return an XML hierarchy'
ACTIVITY = 'com.xingin.xhs/.index.v2.IndexActivityV2'
LAUNCHER = '''KeyguardServiceDelegate
  showing=false
  secure=false
KeyguardStateMonitor
Display: mDisplayId=90000 (organized)
  mCurrentFocus=null
  mFocusedApp=null
  mAwake=true mScreenOnEarly=true mScreenOnFully=true
Display: mDisplayId=0 (organized)
  mCurrentFocus=null
  mFocusedApp=ActivityRecord{example u0 com.bbk.launcher2/.Launcher t5 d0}
  mAwake=true mScreenOnEarly=true mScreenOnFully=true
'''

class StartupElementsTests(unittest.TestCase):
    def events(self, slot='app1'):
        return ['collection_slot_requested:'+slot, 'xhs_cold_started'] + (['clone_user_requested:999'] if slot == 'app2' else [])

    def start_case(self, slot, failures):
        commands=[];starts=[0];root=ET.fromstring('<hierarchy/>');events=[]
        def adb(_a,_s,*args,**kwargs):
            commands.append(args)
            if args[:3] == ('shell','am','start'):starts[0]+=1
            if 'getprop' in args:return 'VIVO'
            if 'packages' in args:return 'package:com.xingin.xhs'
            if 'resolve-activity' in args:return ACTIVITY
            if args == ('shell','dumpsys','window'):
                if starts[0]<2:return LAUNCHER
                component='u'+('999' if slot=='app2' else '0')+' '+ACTIVITY
                return LAUNCHER.replace('mCurrentFocus=null\n  mFocusedApp=ActivityRecord','mCurrentFocus=Window{x '+component+'}\n  mFocusedApp=ActivityRecord').replace('u0 com.bbk.launcher2/.Launcher',component)
            return ''
        current=lambda *_: 'mCurrentFocus=Window{x u'+('999' if slot=='app2' else '0')+' '+ACTIVITY+'}' if starts[0]>=2 else ''
        with patch.object(sync,'adb',side_effect=adb),patch.object(sync,'focus',side_effect=current),patch.object(sync.time,'sleep'),patch.object(sync,'explicit_clone_user',return_value='999'),patch.object(sync,'dismiss_unsecured_keyguard'),patch.object(sync,'navigation_capture',side_effect=failures+[root]) as capture:
            if len(failures)>1:
                with self.assertRaisesRegex(RuntimeError,ERROR):sync.start_xhs('adb','serial',slot,lambda:None,events)
            else:self.assertIs(sync.start_xhs('adb','serial',slot,lambda:None,events),root)
        return commands,events,capture.call_count

    def test_startup_retries_once_without_second_force_stop_and_preserves_slot(self):
        for slot in ('app1','app2'):
            with self.subTest(slot=slot):
                commands,events,reads=self.start_case(slot,[RuntimeError(ERROR)])
                launches=[c for c in commands if c[:3]==('shell','am','start')]
                self.assertEqual(len(launches),2);self.assertEqual(sum('force-stop' in c for c in commands),1);self.assertEqual(reads,2)
                for c in launches:
                    if slot=='app2':self.assertEqual(c[c.index('--user')+1],'999')
                    else:self.assertNotIn('--user',c)
                self.assertIn('startup_elements_retry_recovered',events)

    def test_second_empty_tree_stops_without_third_launch(self):
        commands,events,reads=self.start_case('app2',[RuntimeError(ERROR),RuntimeError(ERROR)])
        self.assertEqual(sum(c[:3]==('shell','am','start') for c in commands),2);self.assertEqual(reads,2)
        self.assertNotIn('startup_elements_retry_recovered',events)

    def test_physical_launcher_evidence_rejects_ambiguous_secure_and_other_app(self):
        self.assertTrue(sync.vivo_startup_launcher(LAUNCHER))
        for value in [LAUNCHER+LAUNCHER,LAUNCHER.replace('mDisplayId=0 ','mDisplayId=1 '),LAUNCHER.replace('secure=false','secure=true'),LAUNCHER.replace('showing=false','showing=true'),LAUNCHER.replace('com.bbk.launcher2/.Launcher','com.other/.Main'),LAUNCHER.replace('u0 com.bbk','u999 com.bbk'),LAUNCHER.replace('mCurrentFocus=null\n  mFocusedApp=ActivityRecord','mCurrentFocus=Window{x u0 com.other/.Main}\n  mFocusedApp=ActivityRecord')]:
            with self.subTest(value=value):self.assertFalse(sync.vivo_startup_launcher(value))

    def test_late_correct_foreground_only_retries_reading(self):
        events=self.events('app2');root=ET.fromstring('<hierarchy/>')
        with patch.object(sync,'focus',return_value='mCurrentFocus=Window{x u999 '+ACTIVITY+'}'),patch.object(sync,'adb') as adb,patch.object(sync,'navigation_capture',return_value=root),patch.object(sync.time,'sleep'):
            self.assertIs(sync.retry_startup_elements('adb','s','app2','999',ACTIVITY,lambda:None,events),root)
        adb.assert_not_called();self.assertIn('startup_elements_retry_attempted',events)

    def test_foreign_foreground_stops_before_any_input(self):
        def adb(_a,_s,*args,**kwargs):return 'VIVO' if 'getprop' in args else LAUNCHER.replace('com.bbk.launcher2/.Launcher','com.other/.Main')
        with patch.object(sync,'focus',return_value='mCurrentFocus=Window{x u0 com.other/.Main}'),patch.object(sync,'adb',side_effect=adb) as adb:
            self.assertIsNone(sync.retry_startup_elements('adb','s','app1',None,ACTIVITY,lambda:None,self.events()))
        self.assertFalse(any('input' in c.args or 'start' in c.args for c in adb.call_args_list))

    def test_changed_clone_or_surface_stops_before_relaunch(self):
        for change in ('clone','surface'):
            calls=[];windows=[0]
            def adb(_a,_s,*args,**kwargs):
                calls.append(args)
                if 'getprop' in args:return 'VIVO'
                if 'window' in args:
                    windows[0]+=1
                    return LAUNCHER if change=='clone' or windows[0]==1 else LAUNCHER.replace('com.bbk.launcher2/.Launcher','com.other/.Main')
                return ''
            with self.subTest(change=change),patch.object(sync,'focus',return_value=''),patch.object(sync,'adb',side_effect=adb),patch.object(sync,'explicit_clone_user',return_value='128' if change=='clone' else '999'):
                with self.assertRaisesRegex(RuntimeError,'changed'):sync.retry_startup_elements('adb','s','app2','999',ACTIVITY,lambda:None,self.events('app2'))
            self.assertFalse(any('input' in c or 'start' in c for c in calls))

    def test_no_retry_outside_startup_or_after_attempt(self):
        for extra in ['collection_scan_as_of:2026-10-23','startup_elements_retry_attempted']:
            with patch.object(sync,'adb') as adb,patch.object(sync,'focus') as focus:
                self.assertIsNone(sync.retry_startup_elements('adb','s','app1',None,ACTIVITY,lambda:None,self.events()+[extra]))
            adb.assert_not_called();focus.assert_not_called()

    def test_occupancy_loss_stops_before_read_or_input(self):
        with patch.object(sync,'adb') as adb,patch.object(sync,'focus') as focus:
            with self.assertRaisesRegex(RuntimeError,'occupied'):sync.retry_startup_elements('adb','s','app1',None,ACTIVITY,Mock(side_effect=RuntimeError('occupied')),self.events())
        adb.assert_not_called();focus.assert_not_called()


    def test_retry_reenters_vivo_selector_before_slot_validation(self):
        # A real explicit XHS launch on 111 first enters the OEM selector.
        events=self.events();root=ET.fromstring('<hierarchy><node text="小红书"/></hierarchy>')
        starts=[0]
        chooser='mCurrentFocus=Window{x u0 com.android.intentresolver/com.android.intentresolver.DoubleAppResolverActivity}'
        def adb(_a,_s,*args,**kwargs):
            if args[:3]==('shell','am','start'):starts[0]+=1
            if 'getprop' in args:return 'VIVO'
            if 'window' in args:
                return LAUNCHER if not starts[0] else LAUNCHER.replace('mCurrentFocus=null\n  mFocusedApp=ActivityRecord',chooser+'\n  mFocusedApp=ActivityRecord').replace('com.bbk.launcher2/.Launcher','com.android.intentresolver/.DoubleAppResolverActivity')
            return ''
        with patch.object(sync,'focus',side_effect=lambda *_:chooser if starts[0] else ''),patch.object(sync,'adb',side_effect=adb),patch.object(sync.time,'sleep'),patch.object(sync,'navigation_capture',return_value=root):
            self.assertIs(sync.retry_startup_elements('adb','s','app1',None,ACTIVITY,lambda:None,events),root)
        self.assertIn('startup_elements_retry_selector_ready',events)

    def test_retry_waits_for_transient_null_focus_without_extra_launch(self):
        events=self.events();root=ET.fromstring('<hierarchy/>');starts=[0];reads=[0];commands=[]
        target=LAUNCHER.replace('mCurrentFocus=null\n  mFocusedApp=ActivityRecord','mCurrentFocus=Window{x u0 '+ACTIVITY+'}\n  mFocusedApp=ActivityRecord').replace('com.bbk.launcher2/.Launcher',ACTIVITY)
        def adb(_a,_s,*args,**kwargs):
            commands.append(args)
            if args[:3]==('shell','am','start'):starts[0]+=1
            if 'getprop' in args:return 'VIVO'
            if 'window' in args:
                if starts[0]:reads[0]+=1
                return target if reads[0]>2 else LAUNCHER
            return ''
        with patch.object(sync,'focus',return_value=''),patch.object(sync,'adb',side_effect=adb),patch.object(sync.time,'sleep'),patch.object(sync,'navigation_capture',return_value=root):
            self.assertIs(sync.retry_startup_elements('adb','s','app1',None,ACTIVITY,lambda:None,events),root)
        self.assertEqual(sum(c[:3]==('shell','am','start') for c in commands),1)
        self.assertIn('startup_elements_retry_target_ready',events)


    def target_window(self, user='0'):
        component='u'+user+' '+ACTIVITY
        return LAUNCHER.replace('mCurrentFocus=null\n  mFocusedApp=ActivityRecord','mCurrentFocus=Window{x '+component+'}\n  mFocusedApp=ActivityRecord').replace('u0 com.bbk.launcher2/.Launcher',component)

    def test_surface_uses_physical_display_and_exact_user(self):
        self.assertEqual(sync.vivo_startup_surface(self.target_window(),'0'),'target')
        self.assertEqual(sync.vivo_startup_surface(self.target_window('999'),'999'),'target')
        self.assertEqual(sync.vivo_startup_surface(LAUNCHER,'0'),'pending')
        for window in (self.target_window('999'),LAUNCHER+LAUNCHER,
                       self.target_window().replace('secure=false','secure=true'),
                       self.target_window().replace('showing=false','showing=true'),
                       self.target_window().replace('mDisplayId=0 ','mDisplayId=1 '),
                       self.target_window().replace(ACTIVITY,'com.other/.Main'),
                       self.target_window().replace('mCurrentFocus=Window{x u0','mCurrentFocus=Window{x u999')):
            with self.subTest(window=window):self.assertEqual(sync.vivo_startup_surface(window,'0'),'unproven')

    def test_wait_timeout_has_no_inputs_and_no_native_capture(self):
        with patch.object(sync,'adb',return_value=LAUNCHER) as adb,patch.object(sync.time,'sleep'),patch.object(sync,'navigation_capture') as capture:
            with self.assertRaisesRegex(RuntimeError,'remained pending'):
                sync.capture_vivo_startup_retry('adb','s','app1',None,lambda:None,self.events())
        self.assertLessEqual(adb.call_count,20);capture.assert_not_called()
        self.assertTrue(all(c.args[2:]==('shell','dumpsys','window') for c in adb.call_args_list))

    def test_read_time_surface_change_never_returns_tree(self):
        with patch.object(sync,'adb',side_effect=[self.target_window(),LAUNCHER]),patch.object(sync,'navigation_capture',return_value=ET.fromstring('<hierarchy/>')):
            with self.assertRaisesRegex(RuntimeError,'changed during native read'):
                sync.capture_vivo_startup_retry('adb','s','app1',None,lambda:None,self.events())

    def test_wait_cancel_and_clone_change_stop_before_capture(self):
        with patch.object(sync,'adb') as adb:
            with self.assertRaisesRegex(RuntimeError,'occupied'):
                sync.capture_vivo_startup_retry('adb','s','app1',None,Mock(side_effect=RuntimeError('occupied')),self.events())
        adb.assert_not_called()
        with patch.object(sync,'adb',return_value=self.target_window('999')),patch.object(sync,'explicit_clone_user',return_value='128'),patch.object(sync,'navigation_capture') as capture:
            with self.assertRaisesRegex(RuntimeError,'clone profile changed'):
                sync.capture_vivo_startup_retry('adb','s','app2','999',lambda:None,self.events('app2'))
        capture.assert_not_called()

    def test_selector_retry_returns_to_normal_slot_choice(self):
        for slot in ('app1','app2'):
            with self.subTest(slot=slot):
                events=[];starts=[0];selected=[False];root=ET.fromstring('<hierarchy/>')
                chooser=LAUNCHER.replace('mCurrentFocus=null\n  mFocusedApp=ActivityRecord','mCurrentFocus=Window{x u0 com.android.intentresolver/.DoubleAppResolverActivity}\n  mFocusedApp=ActivityRecord').replace('com.bbk.launcher2/.Launcher','com.android.intentresolver/.DoubleAppResolverActivity')
                def adb(_a,_s,*args,**kwargs):
                    if args[:3]==('shell','am','start'):starts[0]+=1
                    if 'getprop' in args:return 'VIVO'
                    if 'packages' in args:return 'package:com.xingin.xhs'
                    if 'resolve-activity' in args:return ACTIVITY
                    if 'window' in args:return chooser if starts[0]>=2 else LAUNCHER
                    return ''
                current=lambda *_:'mCurrentFocus=Window{x u0 com.android.intentresolver/.DoubleAppResolverActivity}' if starts[0]>=2 else ''
                with patch.object(sync,'adb',side_effect=adb) as commands,patch.object(sync,'focus',side_effect=current),patch.object(sync.time,'sleep'),patch.object(sync,'explicit_clone_user',return_value='999'),patch.object(sync,'dismiss_unsecured_keyguard'),patch.object(sync,'navigation_capture',side_effect=[RuntimeError(ERROR),root,root]),patch.object(sync,'select_miui_clone',return_value=False),patch.object(sync,'select_oppo_clone',return_value=False),patch.object(sync,'select_honor_owner',return_value=False),patch.object(sync,'label',side_effect=lambda tree,text:text==('小红书' if slot=='app1' else 'Ⅱ·小红书')),patch.object(sync,'tap_label') as tap:
                    self.assertIs(sync.start_xhs('adb','s',slot,lambda:None,events),root)
                self.assertEqual(tap.call_count,1);self.assertEqual(tap.call_args.args[3],'小红书' if slot=='app1' else 'Ⅱ·小红书')
                self.assertIn('clone_slot_selected:'+slot,events)
                self.assertEqual(sum('force-stop' in c.args for c in commands.call_args_list),1)

if __name__=='__main__':unittest.main()
