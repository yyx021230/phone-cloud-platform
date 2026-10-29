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
   with patch.object(sync,'collect_once',return_value=a),patch.object(sync,'verify_duplicate_window_reverse',return_value=b):r=sync.collect(SimpleNamespace())
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


class ReverseDuplicateVerificationTests(unittest.TestCase):
 def first(self):
  import datetime as dt
  r=listing();notes=[dict(n,published_date=sync.published_date(n['published_at_raw'],dt.date(2026,10,29)).isoformat()) for _,n in sync.note_cards(r)]
  scope=next(n.get('text') for n in sync.live_nodes(r) if (n.get('text') or '').startswith('仅统计'))
  return dict(notes=notes,scrolls=1,complete=False,recovery_events=['collection_slot_requested:app1'],warnings=[],app_slot='app1',window_start_date='2026-09-30',window_end_date='2026-10-29',list_scope_raw=scope)
 def verify(self,root=None,top=None,terminal=True,first=None,guard=None):
  from contextlib import ExitStack
  first=self.first() if first is None else first;root=listing() if root is None else root
  args=SimpleNamespace(device_cache='unused',serial='s',device_name='131',task_id='j',app_slot='app1',cancel_file='',adb='adb',max_scrolls=2)
  with ExitStack() as stack:
   stack.enter_context(patch.object(sync,'assert_idle',side_effect=guard))
   stack.enter_context(patch.object(sync,'verification_entry',return_value=root))
   stack.enter_context(patch.object(sync,'wait_creator_content',side_effect=lambda a,b,r,*rest:r))
   stack.enter_context(patch.object(sync,'focus',return_value='mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'))
   stack.enter_context(patch.object(sync,'assert_requested_foreground'))
   stack.enter_context(patch.object(sync,'proven_list_terminal',return_value=(False,terminal)))
   stack.enter_context(patch.object(sync,'prove_native_list_start',return_value=top if top is not None else root))
   stack.enter_context(patch.object(sync,'swipe',side_effect=AssertionError('unexpected swipe in single-page replay')))
   return sync.verify_duplicate_window_reverse(args,first,'list_end_visible')
 def test_same_list_full_identity_audit_accepts_both_duplicates(self):
  r=self.verify();self.assertTrue(r['complete']);self.assertEqual(len(r['notes']),6)
  self.assertIn('verification_reverse_completed',r['recovery_events'])
 def test_changed_signature_or_missing_tail_is_rejected(self):
  for kind in ('signature','tail','order'):
   r=listing();cards=sync.note_cards(r)
   if kind=='signature':next(n for n in cards[2][0].iter('node') if n.get('class')=='android.widget.Image').set('text','rotated')
   if kind=='tail':
    row=cards[-1][0]
    next(p for p in r.iter() if row in list(p)).remove(row)
   if kind=='order':
    a=next(n for n in cards[2][0].iter('node') if n.get('class')=='android.widget.Image');b=next(n for n in cards[4][0].iter('node') if n.get('class')=='android.widget.Image')
    av,bv=a.get('text'),b.get('text');a.set('text',bv);b.set('text',av)
   with self.subTest(kind=kind),self.assertRaises(sync.ElementListReadError):self.verify(r)
 def test_boundary_top_or_scope_change_never_passes(self):
  with self.assertRaisesRegex(sync.ElementListReadError,'boundary'):self.verify(terminal=False)
  top=listing();next(n for n in top.iter('node') if n.get('text')=='合成笔记0').set('text','new post')
  with self.assertRaisesRegex(sync.ElementListReadError,'newest'):self.verify(top=top)
  first=self.first();first['list_scope_raw']='changed'
  with self.assertRaisesRegex(sync.ElementListReadError,'scope'):self.verify(first=first)
 def test_lost_ownership_never_reads_or_scrolls(self):
  with self.assertRaisesRegex(RuntimeError,'occupied'):self.verify(guard=Mock(side_effect=RuntimeError('occupied')))
 def test_missing_cover_in_a_duplicate_group_cannot_complete(self):
  first=self.first();first['complete']=True;first['stop_reason']='list_end_visible';first['notes'][2].pop('element_cover_sha256')
  with patch.object(sync,'collect_once',return_value=first),patch.object(sync,'verify_duplicate_window_reverse') as reverse:
   r=sync.collect(SimpleNamespace())
  self.assertFalse(r['complete']);reverse.assert_not_called()
 def test_unique_titles_keep_existing_identity_when_resources_rotate(self):
  a=self.first();a['complete']=True;a['stop_reason']='list_end_visible'
  for i,n in enumerate(a['notes']):n['title']='unique '+str(i)
  b=copy.deepcopy(a)
  for n in b['notes']:n['element_cover_sha256']='f'*64
  with patch.object(sync,'collect_once',side_effect=[a,b]),patch.object(sync,'verify_duplicate_window_reverse') as reverse:
   r=sync.collect(SimpleNamespace())
  self.assertTrue(r['complete']);reverse.assert_not_called()
  self.assertNotIn('collection_identity_schema:title_date_cover_sha256_v1',r['recovery_events'])

class ReverseSeamTests(unittest.TestCase):
 def page(self,indices):
  r=listing();cards=sync.note_cards(r)
  for (row,n),i in zip(cards,indices):
   for node in row.iter('node'):
    if node.get('text')==n['title']:node.set('text','same title' if i in (1,5) else 'post '+str(i))
    if node.get('text')==n['published_at_raw']:node.set('text','10-27')
   next(node for node in row.iter('node') if node.get('class')=='android.widget.Image').set('text','cover-'+str(i))
  for row,_ in cards[len(indices):]:next(p for p in r.iter() if row in list(p)).remove(row)
  return r
 def run_pages(self,following):
  from contextlib import ExitStack
  top=self.page([0,1,2,3,4,5]);bottom=self.page([2,3,4,5,6,7])
  first=ReverseDuplicateVerificationTests().first()
  first['notes']=[dict(n,published_date='2026-10-27') for _,n in sync.note_cards(top)+sync.note_cards(bottom)[-2:]]
  args=SimpleNamespace(device_cache='unused',serial='s',device_name='131',task_id='j',app_slot='app1',cancel_file='',adb='adb',max_scrolls=2)
  with ExitStack() as stack:
   for name in ('assert_idle','assert_requested_foreground'):stack.enter_context(patch.object(sync,name))
   stack.enter_context(patch.object(sync,'verification_entry',return_value=bottom))
   stack.enter_context(patch.object(sync,'wait_creator_content',side_effect=lambda a,b,r,*rest:r))
   stack.enter_context(patch.object(sync,'focus',return_value='same focus'))
   stack.enter_context(patch.object(sync,'proven_list_terminal',return_value=(False,True)))
   stack.enter_context(patch.object(sync,'prove_native_list_start',return_value=top))
   swipe=stack.enter_context(patch.object(sync,'swipe'))
   stack.enter_context(patch.object(sync,'navigation_capture',side_effect=[self.page(ids) for ids in following]))
   r=sync.verify_duplicate_window_reverse(args,first,'list_end_visible')
  self.assertTrue(all(c.kwargs.get('reverse') is True for c in swipe.call_args_list))
  return r
 def test_two_overlapping_pages_audit_eight_posts_and_two_same_titles(self):
  r=self.run_pages([[0,1,2,3,4,5]])
  self.assertTrue(r['complete']);self.assertEqual(len(r['notes']),8);self.assertEqual(r['scrolls'],1)
  self.assertEqual(sum(n['title']=='same title' for n in r['notes']),2)
 def test_missing_middle_or_new_identity_is_not_filled_from_primary(self):
  for ids in ([0,1,2,4,5,6],[0,1,2,3,4,8],[0,1,3,2,4,5]):
   with self.subTest(ids=ids),self.assertRaises(sync.ElementListReadError):self.run_pages([ids])
 def test_unchanged_pages_stop_incomplete(self):
  with self.assertRaises(sync.ElementListReadError):self.run_pages([[2,3,4,5,6,7]]*4)
