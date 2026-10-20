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
