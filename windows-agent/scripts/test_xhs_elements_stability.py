"""Native-only navigation interruptions; all device operations are mocked."""
from pathlib import Path
import importlib.util
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET
S=Path(__file__).parent
spec=importlib.util.spec_from_file_location('stability_sync',S/'小红书数据同步.py')
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
class VivoStoreUpdateTests(unittest.TestCase):
 current='mCurrentFocus=Window{b2837c6 u0 com.bbk.appstore/com.bbk.appstore.ui.manage.ManageUpdateActivity type=1}'
 xhs='mCurrentFocus=Window{x u999 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2}'
 def fixture(self):return ET.parse(S/'fixtures/xhs/vivo-store-update-elements.xml').getroot()
 def events(self):return ['xhs_cold_started','collection_slot_requested:app2','clone_user_requested:999','clone_slot_selected:app2']
 def test_native_update_page_backs_once_and_checks_requested_clone(self):
  events=self.events()
  with patch.object(sync,'adb',return_value='vivo') as adb,patch.object(sync,'focus',side_effect=[self.current,self.xhs]),patch.object(sync.time,'sleep'):
   self.assertTrue(sync.recover_vivo_store_update('adb','serial',self.fixture(),'app2',self.current,lambda:None,events))
  self.assertEqual([c.args[2:] for c in adb.call_args_list],[('shell','getprop','ro.product.manufacturer'),('shell','input','keyevent','4')])
  self.assertIn('vivo_store_update_back',events)
 def test_wrong_package_activity_or_incomplete_page_does_not_send_inputs(self):
  for variant in ('package','activity','title','back','copy','event'):
   root=self.fixture();current=self.current;events=self.events()
   if variant=='package':current=current.replace('com.bbk.appstore/','other/')
   if variant=='activity':current=current.replace('ManageUpdateActivity','InstallActivity')
   if variant=='event':events=[]
   for n in root.iter('node'):
    if variant=='title' and n.get('text')=='应用更新':n.set('text','其它页面')
    if variant=='back' and n.get('content-desc')=='返回':n.set('clickable','false')
    if variant=='copy' and '点击“更新”' in n.get('text',''):n.set('text','')
   with patch.object(sync,'adb') as adb:
    self.assertFalse(sync.recover_vivo_store_update('adb','serial',root,'app2',current,lambda:None,events))
   adb.assert_not_called()
 def test_wrong_android_user_after_back_stops_without_relaunch(self):
  with patch.object(sync,'adb',return_value='vivo') as adb,patch.object(sync,'focus',side_effect=[self.current,self.xhs.replace('u999','u0')]),patch.object(sync.time,'sleep'):
   with self.assertRaisesRegex(RuntimeError,'requested slot'):
    sync.recover_vivo_store_update('adb','serial',self.fixture(),'app2',self.current,lambda:None,self.events())
  self.assertEqual(adb.call_count,2)
 def test_foreground_change_or_occupancy_prevents_back(self):
  with patch.object(sync,'adb',return_value='vivo') as adb,patch.object(sync,'focus',return_value=self.xhs):
   with self.assertRaisesRegex(RuntimeError,'foreground changed'):
    sync.recover_vivo_store_update('adb','serial',self.fixture(),'app2',self.current,lambda:None,self.events())
  self.assertEqual(adb.call_count,1)
  with patch.object(sync,'adb') as adb:
   with self.assertRaisesRegex(RuntimeError,'occupied'):
    sync.recover_vivo_store_update('adb','serial',self.fixture(),'app2',self.current,Mock(side_effect=RuntimeError('occupied')),self.events())
  adb.assert_not_called()
 def test_repeat_page_is_bounded_and_non_vivo_is_ignored(self):
  with patch.object(sync,'adb') as adb:
   with self.assertRaisesRegex(RuntimeError,'repeated'):
    sync.recover_vivo_store_update('adb','serial',self.fixture(),'app2',self.current,lambda:None,self.events()+['vivo_store_update_back'])
  adb.assert_not_called()
  with patch.object(sync,'adb',return_value='other') as adb:
   self.assertFalse(sync.recover_vivo_store_update('adb','serial',self.fixture(),'app2',self.current,lambda:None,self.events()))
  self.assertEqual(adb.call_count,1)
if __name__=='__main__':unittest.main()
