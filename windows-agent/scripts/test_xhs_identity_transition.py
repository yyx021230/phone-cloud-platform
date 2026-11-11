"""Focus absence is never a logout/wrong-slot proof; no action is replayed."""
import importlib.util,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
p=Path(__file__).parent
spec=importlib.util.spec_from_file_location('transition_sync',p/'小红书数据同步.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
INDEX='mCurrentFocus=Window{x u999 com.xingin.xhs/.index.v2.IndexActivityV2}'
EDITOR='mCurrentFocus=Window{x u999 com.xingin.xhs/com.xingin.reactnative.ui.XhsReactActivity}'
class TransitionTests(unittest.TestCase):
 def run_focus(self,reads,surface='editor',guard=None):
  a=SimpleNamespace(adb='sdk',serial='serial');ev=['collection_slot_requested:app2','clone_user_requested:999']
  with patch.object(m,'focus',side_effect=reads) as focus,patch.object(m.time,'sleep') as sleep,patch.object(m,'adb') as adb,patch.object(m,'start_xhs') as start:
   result=m.settle_identity_transition(a,guard or Mock(),ev,surface)
   adb.assert_not_called();start.assert_not_called()
   return result,ev,focus.call_count,sleep.call_count
 def test_stable_surface_returns_without_wait_or_action(self):
  result,ev,reads,waits=self.run_focus([EDITOR]);self.assertEqual(result,EDITOR);self.assertEqual((reads,waits),(1,0))
 def test_null_focus_and_old_index_only_delay_reads_until_editor_is_real(self):
  result,ev,reads,waits=self.run_focus(['mCurrentFocus=null',INDEX,EDITOR]);self.assertEqual(result,EDITOR);self.assertEqual((reads,waits),(3,2));self.assertIn('identity_focus_wait:editor:2',ev)
 def test_after_back_waits_for_same_user_profile_without_another_back(self):
  result,ev,reads,waits=self.run_focus([EDITOR,'mCurrentFocus=null',INDEX],'profile');self.assertEqual(result,INDEX);self.assertEqual(waits,2)
 def test_actual_wrong_user_foreign_ambiguous_or_unknown_activity_are_rejected(self):
  for current in [EDITOR.replace('u999','u0'),'mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/.Main}',INDEX+'\n'+EDITOR,EDITOR.replace('XhsReactActivity','OtherActivity')]:
   with self.subTest(current=current),self.assertRaises(RuntimeError) as error:self.run_focus([current])
   self.assertNotIn('logged out',str(error.exception))
 def test_focusless_budget_and_lost_guard_do_not_launch_or_read_ui(self):
  with self.assertRaisesRegex(m.ElementListReadError,'did not settle'):self.run_focus(['mCurrentFocus=null']*6)
  with self.assertRaisesRegex(RuntimeError,'occupied'):self.run_focus(['mCurrentFocus=null'],guard=Mock(side_effect=[None,RuntimeError('occupied')]))
 def test_component_resolution_is_owned_or_fixed_fallback_not_arbitrary(self):
  for data,expected in [('header\ncom.xingin.xhs/.Index','com.xingin.xhs/.Index'),('com.android.intentresolver/.DoubleAppResolverActivity',m.XHS_PACKAGE+'/.index.v2.IndexActivityV2'),('com.eg.android.AlipayGphone/.Main',m.XHS_PACKAGE+'/.index.v2.IndexActivityV2'),('com.xingin.xhs/.Main;other',m.XHS_PACKAGE+'/.index.v2.IndexActivityV2')]:
   self.assertEqual(m.xhs_launch_activity(data,[]),expected)
  with self.assertRaisesRegex(RuntimeError,'not uniquely'):m.xhs_launch_activity('com.xingin.xhs/.A\ncom.xingin.xhs/.B',[])
if __name__=='__main__':unittest.main()
