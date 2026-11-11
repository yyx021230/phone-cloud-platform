import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
RELEASE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("current_focus_candidate",(Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
INDEX="mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}\n"
HISTORY="WINDOW MANAGER LAST ANR (dumpsys window lastanr)\nANR time: observed\n"+INDEX
HEAD="WINDOW MANAGER POLICY STATE (dumpsys window policy)\nWINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)\n"
TAIL="WINDOW MANAGER WINDOWS (dumpsys window windows)\n"
class CurrentFocusHistoryTests(unittest.TestCase):
 def focus(self,value):
  with patch.object(sync,"adb",return_value=value):return sync.focus("adb","fixture")
 def test_current_null_never_uses_historical_xhs_focus(self):
  self.assertEqual(self.focus(HISTORY+HEAD+"mCurrentFocus=null\n"+TAIL),"")
 def test_current_other_app_is_returned_without_borrowing_history(self):
  other=INDEX.replace("com.xingin.xhs/","com.other/")
  self.assertEqual(self.focus(HISTORY+HEAD+other+TAIL),other.strip())
 def test_current_xhs_and_headerless_fixture_are_retained(self):
  self.assertEqual(self.focus(HISTORY+HEAD+INDEX+TAIL),INDEX.strip())
  self.assertEqual(self.focus(INDEX),INDEX.strip())
 def test_missing_or_partial_current_sections_never_use_history(self):
  for value in [HISTORY,HISTORY+HEAD,HISTORY+"WINDOW MANAGER POLICY STATE (dumpsys window policy)\n"+INDEX]:
   self.assertEqual(self.focus(value),"")
 def test_explicit_no_recorded_anr_does_not_break_legacy_short_dump(self):
  value="WINDOW MANAGER LAST ANR (dumpsys window lastanr)\n  <no ANR has occurred since boot>\nWINDOW MANAGER WINDOWS (dumpsys window windows)\n"+INDEX
  self.assertEqual(self.focus(value),INDEX.strip())
if __name__=="__main__":unittest.main()
