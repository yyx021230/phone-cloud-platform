import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch
import xml.etree.ElementTree as ET
RELEASE=Path(__file__).resolve().parent
ROOT=RELEASE.parents[1]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
sync=load('late_candidate',(Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
fixtures=load('more_fixtures',ROOT/'releases/xhs-collector-recovery-20261110-rc.2/test_works_tab_timeout.py')
INDEX='mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}'
RN='mCurrentFocus=Window{y u0 com.xingin.xhs/com.xingin.reactnative.ui.XhsReactActivity}'

class LatePocoTests(unittest.TestCase):
 def args(self,name='142',slot='app1'):return SimpleNamespace(adb='adb',serial='fixture',device_name=name,app_slot=slot)
 def events(self):return ['collection_slot_requested:app1','xhs_cold_started']
 def test_observed_model_same_profile_releases_once_then_refuses_repetition(self):
  events=self.events()
  with patch.object(sync,'adb',side_effect=['OPPO\n','PDYM20\n']),patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'release_idle_poco') as release:
   self.assertTrue(sync.release_observed_late_poco(self.args(),INDEX,Mock(),events))
   self.assertFalse(sync.release_observed_late_poco(self.args(),INDEX,Mock(),events))
  self.assertEqual(release.call_count,1)
 def test_other_target_slot_model_and_non_cold_start_never_release(self):
  cases=[(self.args('141'),self.events(),[]),(self.args(slot='app2'),self.events(),[]),(self.args(),['collection_slot_requested:app1'],[]),(self.args(),self.events(),['OTHER','PDYM20']),(self.args(),self.events(),['OPPO','OTHER'])]
  for args,events,props in cases:
   with patch.object(sync,'adb',side_effect=props),patch.object(sync,'release_idle_poco') as release:
    self.assertFalse(sync.release_observed_late_poco(args,INDEX,Mock(),events));release.assert_not_called()
 def test_foreground_change_and_occupancy_never_release(self):
  with patch.object(sync,'adb',side_effect=['OPPO','PDYM20']),patch.object(sync,'focus',return_value=RN),patch.object(sync,'release_idle_poco') as release:
   with self.assertRaises(RuntimeError):sync.release_observed_late_poco(self.args(),INDEX,Mock(),self.events())
   release.assert_not_called()
  with patch.object(sync,'release_idle_poco') as release:
   with self.assertRaisesRegex(RuntimeError,'occupied'):sync.release_observed_late_poco(self.args(),INDEX,Mock(side_effect=RuntimeError('occupied')),self.events())
   release.assert_not_called()
 def test_release_failure_is_terminal_and_keeps_once_marker(self):
  events=self.events()
  with patch.object(sync,'adb',side_effect=['OPPO','PDYM20']),patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'release_idle_poco',side_effect=RuntimeError('still active')):
   with self.assertRaisesRegex(RuntimeError,'still active'):sync.release_observed_late_poco(self.args(),INDEX,Mock(),events)
  self.assertIn('profile_late_poco_release_once',events)


if __name__=="__main__":unittest.main()
