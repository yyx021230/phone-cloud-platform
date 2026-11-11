"""Native snapshot ownership, identity and complete-tree boundaries; no device access."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
import xhs_native_window as native

spec=importlib.util.spec_from_file_location('window_sync',Path(__file__).with_name('小红书数据同步.py'))
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
FOCUS='mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'
XML=b'<hierarchy data-source="xml" native-window-reader="1"><node package="com.xingin.xhs"/></hierarchy>'
class NativeElementsTests(unittest.TestCase):
 def test_honor_owner_reader_is_a_separate_exact_u0_chooser_mode(self):
  current='mCurrentFocus=Window{x u0 com.hihonor.android.internal.app/.HwChooserActivity}'
  run=self.runner();original=run.side_effect
  def honor(*args,**kw):
   result=original(*args,**kw)
   if 'NativeWindowReader' in str(args):
    self.assertIn('NativeWindowReader honor-owner-chooser',str(args))
    result.stdout=XML.replace(b'com.xingin.xhs',b'com.hihonor.android.internal.app')
   return result
  run.side_effect=honor
  self.assertEqual(native.read_honor_owner('adb','selected',run,lambda:current,lambda:None,current).tag,'hierarchy')
  self.assertFalse(native.readable_foreground(current))
  for bad in [current.replace('u0','u128'),current.replace('HwChooserActivity','OtherActivity'),current+'\n'+current,FOCUS]:
   forbidden=self.runner()
   with self.subTest(bad=bad),self.assertRaises(RuntimeError):native.read_honor_owner('adb','selected',forbidden,lambda:bad,lambda:None,bad)
   forbidden.assert_not_called()
 def test_honor_mode_rejects_xhs_nodes_and_still_cleans_up(self):
  current='mCurrentFocus=Window{x u0 com.hihonor.android.internal.app/.HwChooserActivity}'
  run=self.runner()
  with self.assertRaisesRegex(RuntimeError,'complete hierarchy'):
   native.read_honor_owner('adb','selected',run,lambda:current,lambda:None,current)
  self.assertEqual(run.call_args_list[-2].args[2:5],('shell','rm','-f'))
 def test_honor_navigation_fallback_never_runs_for_clone_or_after_scanning(self):
  current='mCurrentFocus=Window{x u0 com.hihonor.android.internal.app/.HwChooserActivity}'
  root=sync.ET.fromstring(XML.replace(b'com.xingin.xhs',b'com.hihonor.android.internal.app'))
  for events,accepted in [(['collection_slot_requested:app1'],True),(['collection_slot_requested:app2','clone_user_requested:128'],False),(['collection_slot_requested:app1','collection_scan_as_of:2026-11-05'],False),([],False)]:
   with self.subTest(events=events),patch.object(sync,'capture',side_effect=RuntimeError('UIAutomator did not return an XML hierarchy')),patch.object(sync,'focus',return_value=current),patch.object(sync,'assert_no_poco'),patch.object(native,'read_honor_owner',return_value=root) as reader,patch.object(sync,'adb') as adb:
    if accepted:
     self.assertIs(sync.navigation_capture('adb','selected',lambda:None,events),root)
     self.assertIn('honor_owner_chooser_native_elements',events);reader.assert_called_once()
    else:
     with self.assertRaises(RuntimeError):sync.navigation_capture('adb','selected',lambda:None,events)
     reader.assert_not_called()
    adb.assert_not_called()
 def runner(self,mode='ok'):
  def run(adb,serial,*args,**kw):
   self.assertEqual((adb,serial),('adb','selected'))
   if args[:2]==('shell','ls'):return subprocess.CompletedProcess(args,1,b'',b'No such file')
   if len(args)==2 and 'NativeWindowReader' in args[1]:
    if mode=='timeout':raise subprocess.TimeoutExpired('read',25)
    return subprocess.CompletedProcess(args,0,XML if mode=='ok' else b'<audit/>',b'')
   return subprocess.CompletedProcess(args,0,b'',b'')
  return Mock(side_effect=run)
 def call(self,run,focus=None,guard=None):
  return native.read('adb','selected',run,focus or Mock(return_value=FOCUS),guard or Mock(),FOCUS)
 def test_complete_native_snapshot_and_unique_cleanup(self):
  run=self.runner();self.assertEqual(self.call(run).tag,'hierarchy')
  remote=run.call_args_list[0].args[-1];self.assertRegex(remote,r'/pc-xhs-elements-[0-9a-f]{32}\.jar$')
  self.assertEqual(run.call_args_list[-2].args[2:],('shell','rm','-f',remote))
 def test_timeout_or_partial_tree_never_returns_and_cleans(self):
  for mode in ('timeout','partial'):
   run=self.runner(mode)
   with self.assertRaises((RuntimeError,subprocess.TimeoutExpired)):self.call(run)
   self.assertEqual(run.call_args_list[-2].args[2:5],('shell','rm','-f'))
 def test_changed_window_before_or_after_read_rejected(self):
  for values in ([FOCUS,'changed'],[FOCUS,FOCUS,'changed']):
   run=self.runner()
   with self.assertRaisesRegex(RuntimeError,'foreground changed'):self.call(run,Mock(side_effect=values))
   self.assertEqual(run.call_args_list[-2].args[2:5],('shell','rm','-f'))
 def test_window_handle_and_task_metadata_change_keeps_exact_user_component(self):
  expected=FOCUS+'\nmFocusedApp=ActivityRecord{old u0 com.xingin.xhs/.xywebview.activity.WebViewActivityV2 t12}'
  fresh='mCurrentFocus=Window{new mode=0 rootTaskId=99 u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}\nmFocusedApp=ActivityRecord{new u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2 t99}'
  run=self.runner()
  tree=native.read('adb','selected',run,Mock(return_value=fresh),Mock(),expected)
  self.assertEqual(tree.tag,'hierarchy')
  self.assertEqual(sum('NativeWindowReader' in str(c.args) for c in run.call_args_list),1)
 def test_relative_component_normalization_does_not_guess_cross_package_class(self):
  relative='mCurrentFocus=Window{x u999 com.xingin.xhs/.index.v2.IndexActivityV2}'
  full=relative.replace('/.index','/com.xingin.xhs.index')
  self.assertTrue(native.same_foreground(relative,full))
  self.assertFalse(native.same_foreground(FOCUS,FOCUS.replace('/com.xingin.xywebview','/.xywebview')))
 def test_wrong_user_component_null_or_ambiguous_focus_never_returns_tree(self):
  for value in (FOCUS.replace('u0','u999'),FOCUS.replace('WebViewActivityV2','OtherActivity'),
                'mCurrentFocus=null\nmFocusedApp=ActivityRecord{x u0 com.xingin.xhs/.xywebview.activity.WebViewActivityV2}',
                FOCUS+'\n'+FOCUS, FOCUS+'\nmCurrentFocus=Window{foreign u0 other.app/OtherActivity}'):
   run=self.runner()
   with self.subTest(value=value),self.assertRaisesRegex(RuntimeError,'foreground changed'):
    self.call(run,Mock(return_value=value))
   run.assert_not_called()
 def test_guard_failure_does_not_touch_device(self):
  run=self.runner()
  with self.assertRaisesRegex(RuntimeError,'occupied'):self.call(run,guard=Mock(side_effect=RuntimeError('occupied')))
  run.assert_not_called()
 def test_modified_asset_and_foreign_foreground_do_not_touch_device(self):
  run=self.runner()
  with tempfile.TemporaryDirectory() as folder:
   asset=Path(folder)/'changed.jar';asset.write_bytes(b'changed')
   with self.assertRaisesRegex(RuntimeError,'hash mismatch'):
    native.read('adb','selected',run,lambda:FOCUS,lambda:None,FOCUS,asset)
  with self.assertRaisesRegex(RuntimeError,'proven XHS WebView'):
   native.read('adb','selected',run,lambda:'foreign',lambda:None,'foreign')
  run.assert_not_called()
 def test_navigation_tree_fallback_is_allowlisted_but_pair_remains_webview_only(self):
  for activity in ('com.xingin.xhs.index.v2.IndexActivityV2','com.xingin.reactnative.ui.XhsReactActivity',
                   'com.xingin.login.device.offline.DeviceOfflineRemindActivity'):
   current='mCurrentFocus=Window{x u0 com.xingin.xhs/'+activity+'}'
   run=self.runner()
   self.assertEqual(native.read('adb','selected',run,lambda:current,lambda:None,current).tag,'hierarchy')
   with self.assertRaisesRegex(RuntimeError,'proven XHS'):
    native.read('adb','selected',self.runner(),lambda:current,lambda:None,current,pair=True)
  self.assertFalse(native.readable_foreground('mCurrentFocus=Window{x u0 com.xingin.xhs/UnknownActivity}'))
 def test_empty_stock_hierarchy_uses_fresh_native_tree_without_inferring_logout(self):
  current='mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.login.device.offline.DeviceOfflineRemindActivity}'
  events=['collection_slot_requested:app1'];root=sync.ET.fromstring(XML)
  with patch.object(sync,'capture',return_value=sync.ET.fromstring('<hierarchy/>')),patch.object(sync,'focus',return_value=current),patch.object(sync,'assert_no_poco'),patch.object(native,'read',return_value=root):
   self.assertIs(sync.navigation_capture('adb','selected',lambda:None,events),root)
   self.assertFalse(sync.login_element_evidence(root,current,events))
 def test_cleanup_failure_rejects_even_valid_snapshot(self):
  run=self.runner();original=run.side_effect
  def retained(*args,**kw):
   if args[2:4]==('shell','ls'):return subprocess.CompletedProcess(args,0,b'remaining',b'')
   return original(*args,**kw)
  run.side_effect=retained
  with self.assertRaisesRegex(RuntimeError,'cleanup'):self.call(run)
 def test_native_fallback_is_selected_then_reused_only_in_proven_webview(self):
  events=['collection_slot_requested:app1'];root=sync.ET.fromstring(XML)
  with patch.object(sync,'capture',side_effect=RuntimeError('UIAutomator did not return an XML hierarchy')) as stock,patch.object(sync,'focus',return_value=FOCUS),patch.object(sync,'assert_no_poco'),patch.object(native,'read',return_value=root) as read:
   self.assertIs(sync.navigation_capture('adb','selected',lambda:None,events),root)
   self.assertIs(sync.navigation_capture('adb','selected',lambda:None,events),root)
   self.assertEqual(stock.call_count,1);self.assertEqual(read.call_count,2)
  with patch.object(sync,'focus',return_value=FOCUS.replace('WebViewActivityV2','OtherActivity')),patch.object(sync,'capture',return_value=root) as stock:
   sync.navigation_capture('adb','selected',lambda:None,events);stock.assert_called_once()
 def test_wrong_slot_or_cleanup_failure_never_triggers_navigation(self):
  for events,error in [(['collection_slot_requested:app2','clone_user_requested:999'],None),(['collection_slot_requested:app1','creator_more_selected'],RuntimeError('native elements temporary file cleanup is unproven'))]:
   with patch.object(sync,'capture',side_effect=RuntimeError('UIAutomator did not return an XML hierarchy')),patch.object(sync,'focus',return_value=FOCUS),patch.object(sync,'assert_no_poco'),patch.object(native,'read',side_effect=error) as read,patch.object(sync,'recover_inaccessible_more') as recovery:
    with self.assertRaises(RuntimeError):sync.navigation_capture('adb','selected',lambda:None,events)
    recovery.assert_not_called()
    if error is None:read.assert_not_called()
if __name__=='__main__':unittest.main()
