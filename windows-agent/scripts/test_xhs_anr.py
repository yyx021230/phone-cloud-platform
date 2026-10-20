"""Observed MIUI XHS ANR: a single element-backed wait, never app closure."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock,patch
S=Path(__file__).parent
spec=importlib.util.spec_from_file_location('anr_sync',S/'小红书数据同步.py');sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
ANR='mCurrentFocus=Window{x u0 Application Not Responding: com.xingin.xhs}'
READY='mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}'
class AnrTests(unittest.TestCase):
 def tree(self):return sync.ET.parse(S/'fixtures/xhs/miui-xhs-anr.xml').getroot()
 def test_exact_wait_is_selected_once_and_xhs_returns(self):
  events=['collection_slot_requested:app1'];guard=Mock()
  with patch.object(sync,'focus',side_effect=[ANR,ANR,READY]),patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
   self.assertTrue(sync.recover_known_overlay('adb','s',self.tree(),guard,events))
  adb.assert_called_once_with('adb','s','shell','input','tap','201','1395',timeout=7);guard.assert_called_once();self.assertIn('xhs_anr_wait_selected',events)
 def test_wrong_slot_repeated_dialog_or_changed_focus_do_not_click(self):
  for events,focus in [(['collection_slot_requested:app2','clone_user_requested:999'],[ANR]),(['collection_slot_requested:app1','xhs_anr_wait_selected'],[ANR]),(['collection_slot_requested:app1'],[ANR,READY])]:
   with patch.object(sync,'focus',side_effect=focus),patch.object(sync,'adb') as adb:
    with self.assertRaises(RuntimeError):sync.recover_known_overlay('adb','s',self.tree(),lambda:None,events)
    adb.assert_not_called()
 def test_missing_duplicate_disabled_or_foreign_wait_rejected(self):
  for mutation in ('missing','duplicate','disabled','foreign'):
   root=self.tree();wait=next(n for n in root.iter('node') if n.get('resource-id')=='android:id/aerr_wait');parent=next(n for n in root.iter('node') if wait in list(n))
   if mutation=='missing':parent.remove(wait)
   elif mutation=='duplicate':parent.append(copy.deepcopy(wait))
   elif mutation=='disabled':wait.set('enabled','false')
   else:wait.set('package','com.other')
   with patch.object(sync,'focus',return_value=ANR),patch.object(sync,'adb') as adb:
    with self.assertRaisesRegex(RuntimeError,'uniquely proven'):sync.recover_known_overlay('adb','s',root,lambda:None,['collection_slot_requested:app1'])
    adb.assert_not_called()
 def test_remaining_anr_stops_after_single_wait(self):
  events=['collection_slot_requested:app1']
  with patch.object(sync,'focus',return_value=ANR),patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
   with self.assertRaisesRegex(RuntimeError,'requested slot'):sync.recover_known_overlay('adb','s',self.tree(),lambda:None,events)
   self.assertEqual(adb.call_count,1);self.assertIn('xhs_anr_wait_selected',events)
if __name__=='__main__':unittest.main()
