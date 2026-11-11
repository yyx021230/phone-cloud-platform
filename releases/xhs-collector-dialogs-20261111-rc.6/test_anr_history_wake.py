import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock,patch
RELEASE=Path(__file__).resolve().parent
ROOT=RELEASE.parents[1]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
sync=load("history_candidate",(Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
fixtures=load("history_fixtures",ROOT/"releases/xhs-collector-recovery-20261110-rc.3/test_keyguard_timeout.py")
HEADER="WINDOW MANAGER POLICY STATE (dumpsys window policy)\nWINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)\n"
ANR=fixtures.UNLOCKED.replace("com.xingin.xhs/.index.v2.IndexActivityV2","Application Not Responding: com.xingin.xhs")+"WINDOW MANAGER WINDOWS (dumpsys window windows)\n"
HISTORY="WINDOW MANAGER LAST ANR (dumpsys window lastanr)\n"+fixtures.UNLOCKED
class HistoryWakeTests(unittest.TestCase):
 def run_wake(self,window):
  def command(_adb,_serial,*args,**kwargs):
   if args==("shell","input","keyevent","224"):raise subprocess.TimeoutExpired("wake",7)
   self.assertEqual(args,("shell","dumpsys","window"));return window
  events=["collection_slot_requested:app1"]
  with patch.object(sync,"adb",side_effect=command) as adb:sync.wake_for_startup("adb","fixture","app1",Mock(),events)
  self.assertEqual(adb.call_count,2);return events
 def test_current_target_anr_and_lit_unlocked_default_display_allow_existing_cold_start(self):
  events=self.run_wake(HISTORY+HEADER+ANR)
  self.assertIn("startup_target_anr_window_proven",events)
  self.assertIn("startup_wake_completed_after_timeout",events)
 def test_historical_lit_display_cannot_override_current_off_or_ambiguous_state(self):
  for current in [ANR.replace("mScreenOnFully=true","mScreenOnFully=false"),ANR+fixtures.UNLOCKED]:
   with self.assertRaises(subprocess.TimeoutExpired):self.run_wake(HISTORY+HEADER+current)
 def test_foreign_anr_wrong_user_or_lock_never_pass(self):
  for before,after in [("com.xingin.xhs","com.other"),(" u0 "," u999 "),("showing=false","showing=true")]:
   with self.assertRaises((RuntimeError,subprocess.TimeoutExpired)):self.run_wake(HISTORY+HEADER+ANR.replace(before,after))
if __name__=="__main__":unittest.main()
