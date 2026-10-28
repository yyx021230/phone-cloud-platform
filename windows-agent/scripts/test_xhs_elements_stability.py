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
class ElementCompletenessStabilityTests(unittest.TestCase):
 def listing(self):return ET.parse(S/'fixtures/xhs/works-elements-141.xml').getroot()
 def test_missing_status_in_a_fully_visible_row_is_rejected(self):
  r=self.listing();row=sync.note_cards(r)[2][0]
  for n in row.iter('node'):
   if sync.is_note_status(n.get('text','')):n.set('text','')
  self.assertEqual(len(sync.note_cards(r)),4)
  with self.assertRaisesRegex(sync.ElementListReadError,'dated element row'):sync.element_page_signature(r)
 def test_same_title_date_on_distinct_visible_rows_is_not_silently_deduplicated(self):
  r=self.listing();cards=sync.note_cards(r);first=cards[0][1]['title'];second=cards[1][1]['title']
  for n in cards[1][0].iter('node'):
   if n.get('text')==second:n.set('text',first)
  with self.assertRaisesRegex(sync.ElementListReadError,'duplicate title/date'):sync.element_page_signature(r)
 def test_same_title_on_different_dates_is_unambiguous(self):
  r=self.listing();cards=sync.note_cards(r);first=cards[0][1]['title'];second=cards[1][1]['title']
  for n in cards[1][0].iter('node'):
   if n.get('text')==second:n.set('text',first)
   if sync.DATE.fullmatch(n.get('text','')):n.set('text','10-18')
  self.assertIsNotNone(sync.element_page_signature(r))
 def test_clipped_leading_date_remains_excluded(self):
  r=self.listing()
  view=next(n for n in r.iter('node') if n.get('class')=='android.webkit.WebView')
  ET.SubElement(view,'node',{'package':sync.XHS_PACKAGE,'text':'10-20','bounds':'[30,310][170,330]'})
  self.assertIsNotNone(sync.element_page_signature(r))

class LateOverviewTests(unittest.TestCase):
 current='mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'
 def test_last_navigation_read_can_finish_its_proven_works_tab_transition(self):
  from contextlib import ExitStack
  import copy
  empty=ET.Element('hierarchy');overview=ET.parse(S/'fixtures/xhs/vivo-overview-elements.xml').getroot();listing=ElementCompletenessStabilityTests().listing();events=['collection_slot_requested:app1','xhs_cold_started']
  with ExitStack() as stack:
   stack.enter_context(patch.object(sync,'wake_if_asleep',return_value=False));stack.enter_context(patch.object(sync,'recover_known_overlay',return_value=False));stack.enter_context(patch.object(sync,'focus',return_value=self.current));stack.enter_context(patch.object(sync.time,'sleep'))
   reads=stack.enter_context(patch.object(sync,'navigation_capture',side_effect=[empty]*13+[overview,listing,copy.deepcopy(listing)]));adb=stack.enter_context(patch.object(sync,'adb'))
   result=sync.ensure_creator_list('adb','serial',empty,'app1',lambda:None,events)
  self.assertTrue(sync.creator_list(result));self.assertIn('works_tab_completed_at_navigation_limit',events);self.assertEqual(reads.call_count,16)
  self.assertEqual([c.args[2:5] for c in adb.call_args_list],[('shell','input','tap')])
 def test_unknown_final_page_does_not_extend_navigation(self):
  empty=ET.Element('hierarchy')
  with patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'recover_known_overlay',return_value=False),patch.object(sync,'focus',return_value=self.current),patch.object(sync.time,'sleep'),patch.object(sync,'navigation_capture',return_value=empty) as reads,patch.object(sync,'adb') as adb:
   with self.assertRaisesRegex(sync.ElementListReadError,'could not prove'):
    sync.ensure_creator_list('adb','serial',empty,'app1',lambda:None,['collection_slot_requested:app1'])
  self.assertEqual(reads.call_count,14);adb.assert_not_called()

class NativeSubsetRefreshTests(unittest.TestCase):
 def test_retained_47_clipped_subset_must_refresh_before_next_scroll(self):
  previous=ET.parse(S/'fixtures/xhs/works-47-before-subset.xml').getroot()
  current=ET.parse(S/'fixtures/xhs/works-47-stale-subset.xml').getroot()
  panel=ET.parse(S/'fixtures/xhs/filter-panel-elements.xml').getroot()
  self.assertEqual(len(sync.note_cards(previous)),5);self.assertEqual(len(sync.note_cards(current)),1)
  self.assertTrue({v['title'] for _,v in sync.note_cards(current)} < {v['title'] for _,v in sync.note_cards(previous)})
  events=[]
  with patch.object(sync,'focus',return_value=LateOverviewTests.current),patch.object(sync,'wake_if_asleep'),patch.object(sync,'navigation_capture',side_effect=[panel,previous]),patch.object(sync,'tap_filter_label') as tap:
   self.assertIs(sync.refresh_scrolled_webview('adb','serial',current,lambda:None,events,previous),previous)
  self.assertEqual([c.args[3] for c in tap.call_args_list],['全部笔记','收起']);self.assertIn('webview_accessibility_refreshed',events);self.assertNotIn('works_list_updated_without_filter_toggle',events)
 def test_changed_counts_without_new_identity_do_not_prove_a_new_page(self):
  import copy
  previous=ElementCompletenessStabilityTests().listing();current=copy.deepcopy(previous)
  next(n for n in current.iter('node') if n.get('text')=='252').set('text','253')
  panel=ET.parse(S/'fixtures/xhs/filter-panel-elements.xml').getroot();events=[]
  with patch.object(sync,'focus',return_value=LateOverviewTests.current),patch.object(sync,'wake_if_asleep'),patch.object(sync,'navigation_capture',side_effect=[panel,current]),patch.object(sync,'tap_filter_label') as tap:
   sync.refresh_scrolled_webview('adb','serial',current,lambda:None,events,previous)
  self.assertEqual(tap.call_count,2);self.assertNotIn('works_list_updated_without_filter_toggle',events)

class BoundedNativeScrollTests(unittest.TestCase):
 def test_47_scroll_keeps_overlap_within_observed_rows(self):
  for name in ('works-47-before-subset.xml','works-47-stale-subset.xml'):
   root=ET.parse(S/'fixtures/xhs'/name).getroot();cards=sync.note_cards(root)
   with patch.object(sync,'focus',return_value=LateOverviewTests.current),patch.object(sync,'wake_if_asleep'),patch.object(sync.time,'sleep'),patch.object(sync,'adb') as adb:
    sync.swipe('adb','serial',root,lambda:None,[])
   args=adb.call_args.args;distance=int(args[6])-int(args[8]);rows=[sync.bounds(n) for n,_ in cards]
   self.assertGreater(distance,0)
   self.assertLessEqual(distance, max((b[3]-b[1]) for b in rows)*3)
   if len(rows)>=4:self.assertLessEqual(distance,sorted(rows,key=lambda b:b[1])[-2][1]-min(b[1] for b in rows))
   # On the retained stale subset, never traverse even one complete row.
   if len(cards)==1:self.assertLess(distance,rows[0][3]-rows[0][1])
 def test_scroll_does_not_guess_when_native_rows_are_missing(self):
  root=ElementCompletenessStabilityTests().listing()
  with patch.object(sync,'note_cards',return_value=[]),patch.object(sync,'adb') as adb:
   with self.assertRaises((sync.ElementListReadError,RuntimeError)):sync.swipe('adb','serial',root,lambda:None,[])
  adb.assert_not_called()

if __name__=='__main__':unittest.main()
