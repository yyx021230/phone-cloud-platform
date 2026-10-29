"""Sanitized real hierarchy replays; no device or network access."""
import copy
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch,Mock
import xml.etree.ElementTree as E
from test_xhs_elements_only import sync,ElementCollectionTests
S=Path(__file__).parent/'fixtures/xhs'
def listing():return E.parse(S/'works-duplicate-cover-elements.xml').getroot()
def usb():return E.parse(S/'oppo-systemui-usb-elements.xml').getroot()
class CoverIdentityTests(unittest.TestCase):
 def test_distinct_same_title_date_rows_survive_collection(self):
  r=listing();cards=sync.note_cards(r)
  self.assertEqual(len(cards),6)
  self.assertEqual(cards[2][1]['title'],cards[4][1]['title'])
  self.assertNotEqual(sync.note_identity(cards[2][1]),sync.note_identity(cards[4][1]))
  result=ElementCollectionTests().collect(r,[copy.deepcopy(r)])
  self.assertEqual(len(result['notes']),6)
  self.assertEqual([n['list_view_count'] for n in result['notes'] if n['title']=='合成同名笔记'],[90,15])
  self.assertFalse(result['complete']) # no end/date boundary in this retained page
 def test_same_cover_or_missing_cover_is_still_ambiguous(self):
  for missing in (True,False):
   r=listing();rows=sync.note_cards(r)
   covers=[]
   for i in (2,4):
    covers.append(next(n for n in rows[i][0].iter('node') if n.get('class')=='android.widget.Image'))
   for n in covers:n.set('text','' if missing else 'same-cover')
   with self.assertRaisesRegex(sync.ElementListReadError,'ambiguous'):sync.element_page_signature(r)
 def test_rotating_cover_cannot_prove_overlap(self):
  a=listing();b=listing()
  for n in b.iter('node'):
   if n.get('class')=='android.widget.Image':n.set('text',n.get('text','')+'rotated')
  with self.assertRaises(sync.ElementListReadError):sync.verify_element_overlap(a,b)
 def test_metric_changes_keep_identity_but_not_stability_signature(self):
  a=listing();b=listing();next(n for n in b.iter('node') if n.get('text')=='145').set('text','146')
  self.assertEqual([sync.note_identity(n) for _,n in sync.note_cards(a)],[sync.note_identity(n) for _,n in sync.note_cards(b)])
  self.assertNotEqual(sync.element_page_signature(a),sync.element_page_signature(b))
 def test_two_pass_requires_cover_identity_and_order(self):
  notes=[dict(n,published_date='2026-10-27') for _,n in sync.note_cards(listing())]
  def snapshot():return dict(complete=True,notes=copy.deepcopy(notes),stop_reason='list_end_visible',scrolls=1,recovery_events=[],warnings=[],app_slot='app1',window_start_date='2026-09-30',window_end_date='2026-10-29',list_scope_raw='scope')
  for change in ('none','cover','order','missing'):
   a,b=snapshot(),snapshot()
   if change=='cover':b['notes'][2]['element_cover_sha256']='a'*64
   if change=='order':b['notes'][2],b['notes'][4]=b['notes'][4],b['notes'][2]
   if change=='missing':b['notes'].pop(4)
   with patch.object(sync,'collect_once',side_effect=[a,b]):r=sync.collect(SimpleNamespace())
   self.assertEqual(r['complete'],change=='none')
   self.assertIn('collection_identity_schema:title_date_cover_sha256_v1',r['recovery_events'])
class UsbOverlayTests(unittest.TestCase):
 focus='mCurrentFocus=Window{synthetic u0 com.android.systemui}\nmFocusedApp=ActivityRecord{x u0 com.android.intentresolver/.ChooserActivityLauncher}'
 def run_panel(self,r=None,after=None,events=None,focuses=None,guard=None):
  events=[] if events is None else events
  with patch.object(sync,'focus',side_effect=focuses or [self.focus,self.focus]),patch.object(sync,'adb') as adb,patch.object(sync,'navigation_capture',return_value=after if after is not None else listing()),patch.object(sync.time,'sleep'):
   try:result=sync.recover_known_overlay('adb','serial',r if r is not None else usb(),guard or Mock(),events)
   except Exception as e:return e,adb,events
  return result,adb,events
 def test_proven_panel_back_only(self):
  result,adb,events=self.run_panel();self.assertIs(result,True)
  adb.assert_called_once_with('adb','serial','shell','input','keyevent','4',timeout=7)
  self.assertIn('oppo_systemui_usb_dismissed',events)
 def test_changed_or_unproven_panel_never_acts(self):
  for kind in ('missing','foreign','class','focus','reappeared','guard'):
   r=usb();kw={}
   n=next(n for n in r.iter('node') if n.get('text')=='MIDI')
   if kind=='missing':n.set('text','授权USB调试')
   if kind=='foreign':n.set('package','other')
   if kind=='class':n.set('class','android.widget.Button')
   if kind=='focus':kw['focuses']=[self.focus,'mCurrentFocus=Window{x u0 other}']
   if kind=='reappeared':kw['events']=['oppo_systemui_usb_dismissed']
   if kind=='guard':kw['guard']=Mock(side_effect=RuntimeError('occupied'))
   result,adb,_=self.run_panel(r,**kw)
   self.assertIsInstance(result,RuntimeError,kind);adb.assert_not_called()
 def test_persistent_panel_stops_after_one_back(self):
  result,adb,_=self.run_panel(after=usb());self.assertIsInstance(result,RuntimeError);self.assertEqual(adb.call_count,1)
if __name__=='__main__':unittest.main()
