"""Native bridge guard/cleanup tests. All device calls are fakes."""
import subprocess
import unittest
from unittest.mock import Mock
from pathlib import Path
import tempfile
import xhs_native_navigation as nav

class NativeBridgeTests(unittest.TestCase):
 def call(self,run,focus=None,guard=None,action='profile',asset=None):
  return nav.perform(action,'SDK/adb.exe','target',run,focus or Mock(return_value='proven'),guard or Mock(),'proven',asset)
 def runner(self,mode='ok'):
  def f(adb,serial,*args,**kw):
   self.assertEqual((adb,serial),('SDK/adb.exe','target'))
   if args[:2]==('shell','ls'):return subprocess.CompletedProcess(args,1,b'',b'No such file or directory')
   if len(args)==2 and args[0]=='shell' and 'NativeNavigationAction' in args[1]:
    if mode=='timeout':raise subprocess.TimeoutExpired('owned action',20)
    return subprocess.CompletedProcess(args,1 if mode=='reject' else 0,b'native_navigation_action_completed' if mode=='ok' else b'',b'rejected' if mode=='reject' else b'')
   return subprocess.CompletedProcess(args,0,b'',b'')
  return Mock(side_effect=f)
 def test_exact_action_uses_owned_file_once_and_removes_it(self):
  run=self.runner();self.call(run)
  calls=[c.args[2:] for c in run.call_args_list]
  self.assertEqual(calls[0][0],'push');remote=calls[0][-1]
  self.assertRegex(remote,r'^/data/local/tmp/pc-xhs-nav-[0-9a-f]{32}\.jar$')
  self.assertEqual(sum('NativeNavigationAction profile' in str(c) for c in calls),1)
  self.assertEqual(calls[-2],('shell','rm','-f',remote));self.assertEqual(calls[-1],('shell','ls',remote))
 def test_action_error_or_unknown_result_never_replays_and_still_cleans(self):
  for mode in ('reject','timeout','invalid_output'):
   run=self.runner(mode)
   with self.subTest(mode=mode),self.assertRaises((RuntimeError,subprocess.TimeoutExpired)):self.call(run)
   self.assertEqual(sum('NativeNavigationAction profile' in str(c.args) for c in run.call_args_list),1)
   self.assertEqual(run.call_args_list[-2].args[2:5],('shell','rm','-f'))
 def test_occupancy_or_changed_foreground_prevents_action(self):
  run=self.runner()
  with self.assertRaisesRegex(RuntimeError,'occupied'):self.call(run,guard=Mock(side_effect=RuntimeError('occupied')))
  run.assert_not_called()
  with self.assertRaisesRegex(RuntimeError,'foreground changed'):self.call(run,focus=Mock(side_effect=['proven','other']))
  self.assertFalse(any('NativeNavigationAction' in str(c.args) for c in run.call_args_list))
 def test_unknown_action_or_modified_asset_never_touches_device(self):
  run=self.runner()
  with self.assertRaisesRegex(RuntimeError,'unsupported'):self.call(run,action='publish')
  with tempfile.TemporaryDirectory() as temp:
   asset=Path(temp)/'different.jar';asset.write_bytes(b'changed')
   with self.assertRaisesRegex(RuntimeError,'hash mismatch'):self.call(run,asset=asset)
  run.assert_not_called()
 def test_unproven_cleanup_is_not_success(self):
  run=self.runner();original=run.side_effect
  def f(*args,**kw):
   if args[2:4]==('shell','ls'):return subprocess.CompletedProcess(args,0,b'leftover',b'')
   return original(*args,**kw)
  run.side_effect=f
  with self.assertRaisesRegex(RuntimeError,'cleanup'):self.call(run)

if __name__=='__main__':unittest.main()
