import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch
from contextlib import ExitStack
import xml.etree.ElementTree as ET
RELEASE=Path(__file__).resolve().parent
ROOT=RELEASE.parents[1]
spec=importlib.util.spec_from_file_location('reader_candidate',(Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
INDEX='mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}'
ANR='mCurrentFocus=Window{x u0 Application Not Responding: com.xingin.xhs}'

def profile():
 root=ET.Element('hierarchy')
 ET.SubElement(root,'node',{'package':sync.XHS_PACKAGE,'class':'android.view.ViewGroup','content-desc':'我','selected':'true','enabled':'true','bounds':'[1,1][2,2]'})
 return root

class AnrClassificationTests(unittest.TestCase):
 def test_current_owner_xhs_anr_is_an_app_failure(self):
  with self.assertRaisesRegex(RuntimeError,'app is not responding'):
   sync.assert_requested_foreground(ANR,['collection_slot_requested:app1'])
 def test_foreign_anr_and_other_user_are_not_labeled_as_owner_xhs_anr(self):
  for current,events in [(ANR.replace('com.xingin.xhs','com.other'),['collection_slot_requested:app1']),(ANR.replace('u0','u999'),['collection_slot_requested:app1']),(ANR,['collection_slot_requested:app2','clone_user_requested:999'])]:
   with self.assertRaisesRegex(RuntimeError,'foreground user'):
    sync.assert_requested_foreground(current,events)
 def test_anr_does_not_reenter_the_wrong_slot_recovery_or_claim_login_state(self):
  args=SimpleNamespace(adb='adb',serial='fixture',device_name='141',app_slot='app1')
  with patch.object(sync,'ensure_creator_list',side_effect=RuntimeError('Xiaohongshu app is not responding; collection stopped')),patch.object(sync,'start_xhs') as start:
   with self.assertRaisesRegex(RuntimeError,'app is not responding'):
    sync.enter_creator_with_slot_retry(args,profile(),Mock(),['collection_slot_requested:app1'])
   start.assert_not_called();self.assertFalse(getattr(args,'used_slot_entry_retry',False))
if __name__=='__main__':unittest.main()
