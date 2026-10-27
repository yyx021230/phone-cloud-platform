"""Replay47's notification foreground and the exhausted navigation boundary."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch, Mock
import xml.etree.ElementTree as ET

S=Path(__file__).parent
spec=importlib.util.spec_from_file_location('late_sync',S/'小红书数据同步.py')
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
INDEX='mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2}'
POPUP=INDEX.replace('com.xingin.xhs.index.v2.IndexActivityV2','com.xingin.authorization.NotificationAuthorizationTranslucentActivity')

class LateNotificationTests(unittest.TestCase):
 def run_boundary(self,mode='ok'):
  blank=ET.fromstring('<hierarchy/>');ready=ET.parse(S/'fixtures/xhs/works-elements-141.xml').getroot()
  state={'captures':0,'closed':False,'popupReads':0};events=['collection_slot_requested:app1'];calls=[]
  def capture(*args):
   state['captures']+=1
   return ready if state['closed'] else blank
  def focus(*args):
   if state['captures']<14 or state['closed']:return INDEX
   state['popupReads']+=1
   if mode=='foreign':return POPUP.replace('com.xingin.xhs/','com.other/')
   if mode=='wrong_slot':return POPUP.replace('u0 ','u999 ')
   if mode=='changed' and state['popupReads']>=3:return INDEX
   return POPUP
  def adb(a,b,*args,**kwargs):
   calls.append(args)
   if args==('shell','input','keyevent','4'):state['closed']=mode!='stuck'
   return ''
  def guard():
   if mode=='busy' and state['captures']>=14:raise RuntimeError('occupied')
  with patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'navigation_capture',side_effect=capture),patch.object(sync,'focus',side_effect=focus),patch.object(sync,'adb',side_effect=adb),patch.object(sync.time,'sleep'):
   if mode=='ok':
    self.assertIs(sync.ensure_creator_list('adb','serial',blank,'app1',guard,events),ready)
   else:
    with self.assertRaises(RuntimeError):sync.ensure_creator_list('adb','serial',blank,'app1',guard,events)
  return calls,events,state
 def test_last_capture_notification_is_closed_once_then_list_is_proven(self):
  calls,events,state=self.run_boundary()
  self.assertEqual(calls,[('shell','input','keyevent','4')]);self.assertIn('creator_late_notification_retry',events)
  self.assertEqual(state['captures'],15)
 def test_wrong_slot_foreign_focus_occupancy_or_changed_activity_never_gets_back(self):
  for mode in ('wrong_slot','foreign','busy','changed'):
   with self.subTest(mode=mode):self.assertEqual(self.run_boundary(mode)[0],[])
 def test_failed_close_is_not_replayed(self):
  calls,events,state=self.run_boundary('stuck');self.assertEqual(calls,[('shell','input','keyevent','4')]);self.assertNotIn('creator_late_notification_retry',events)
 def test_recurrent_notification_after_retry_stops_without_another_back(self):
  with patch.object(sync,'focus',return_value=POPUP),patch.object(sync,'adb') as adb:
   with self.assertRaisesRegex(sync.ElementListReadError,'recurred'):
    sync.recover_known_overlay('adb','serial',ET.fromstring('<hierarchy/>'),lambda:None,['creator_late_notification_retry'])
   adb.assert_not_called()
 def test_extra_navigation_budget_does_not_recurse(self):
  with patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'recover_known_overlay',return_value=False),patch.object(sync,'navigation_capture',return_value=ET.fromstring('<hierarchy/>')) as capture,patch.object(sync.time,'sleep'):
   with self.assertRaises(sync.ElementListReadError):sync.ensure_creator_list('adb','serial',ET.fromstring('<hierarchy/>'),'app1',lambda:None,[],_notification_retry=True)
  self.assertEqual(capture.call_count,6)
