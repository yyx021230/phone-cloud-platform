import unittest
from unittest import mock
from types import SimpleNamespace
import alipay_name_lookup as m
class GapTests(unittest.TestCase):
 def runner(self):
  r=m.Runner({'serial':'SYNTHETIC'});r.emit=mock.Mock();return r
 def proc(self,rc=1,err="device 'SYNTHETIC' not found",out=''):
  return SimpleNamespace(returncode=rc,stderr=err,stdout=out)
 def test_one_second_gap_recovers_without_action_replay(self):
  with mock.patch.object(m.subprocess,'run',side_effect=[self.proc(),self.proc(),self.proc(0,'','mCurrentFocus=null')]) as run,mock.patch.object(m.time,'sleep') as sleep:
   self.assertEqual(self.runner().focus(),['mCurrentFocus=null'])
   self.assertEqual([c.args[0] for c in sleep.call_args_list],[.5,1.0])
   self.assertTrue(all(c.args[0][-3:]==['shell','dumpsys','window'] for c in run.call_args_list))
 def test_original_deadline_prevents_late_retry(self):
  r=self.runner()
  with mock.patch.object(m.time,'perf_counter',side_effect=[0,0,.8]),mock.patch.object(m.subprocess,'run',return_value=self.proc()) as run,mock.patch.object(m.time,'sleep') as sleep:
   with self.assertRaisesRegex(RuntimeError,'adb_read_unavailable'):r.adb(['shell','dumpsys','window'],timeout=1)
   self.assertEqual(run.call_count,1);sleep.assert_not_called()
 def test_nontransient_permission_error_not_retried(self):
  with mock.patch.object(m.subprocess,'run',return_value=self.proc(err='permission denied')) as run,mock.patch.object(m.time,'sleep') as sleep:
   with self.assertRaisesRegex(RuntimeError,'adb_read_unavailable'):self.runner().focus()
   self.assertEqual(run.call_count,1);sleep.assert_not_called()
if __name__=='__main__':unittest.main()
