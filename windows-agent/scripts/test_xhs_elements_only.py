"""Native-element collection, freshness and no-image behavior; no device access."""
import ast
import builtins
import copy
import datetime as dt
import importlib.util
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

S=Path(__file__).parent
spec=importlib.util.spec_from_file_location('elements_sync',S/'小红书数据同步.py')
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)

def listing():return ET.parse(S/'fixtures/xhs/works-elements-141.xml').getroot()
def panel():return ET.parse(S/'fixtures/xhs/filter-panel-elements.xml').getroot()
def list_shell():
 r=panel()
 for n in list(r[0]):
  if n.get('text') in ('笔记类型','发布时间','排序方式','收起'):r[0].remove(n)
 return r

class NativeReadingTests(unittest.TestCase):
 def test_retained_native_shape_reads_five_exact_titles_dates_and_metrics_without_selected_tab_text(self):
  r=listing();self.assertFalse(sync.label(r,'作品分析'));self.assertTrue(sync.creator_list(r))
  cards=sync.note_cards(r);self.assertEqual(len(cards),5)
  self.assertEqual(cards[0][1]['title'],'合成标题1 Ultra plus 赢😄')
  self.assertEqual([c['published_at_raw'] for _,c in cards],['10-19']*5)
  self.assertEqual([[c[k] for k in ('list_view_count','list_like_count','list_comment_count')] for _,c in cards],[[252,1,1],[136,0,1],[37,0,1],[638,1,7],[105,0,3]])
  self.assertIsNotNone(sync.element_page_signature(r));sync.verify_newest_element_position(r)
 def test_loading_header_does_not_prove_any_posts_or_zero_posts(self):
  r=list_shell();self.assertEqual(sync.note_cards(r),[]);self.assertIsNone(sync.element_page_signature(r))
 def test_wrong_webview_and_missing_scope_do_not_prove_the_missing_tab_layout(self):
  for kind in ('package','scope','filter'):
   r=listing()
   if kind=='package':
    for n in r.iter('node'):
     if n.get('text')=='数据中心' and n.get('class')=='android.webkit.WebView':n.set('package','other')
   else:
    for n in r.iter('node'):
     if kind=='scope' and n.get('text','').startswith('仅统计') or kind=='filter' and n.get('text')=='全部笔记':n.set('text','')
   self.assertFalse(sync.creator_list(r))
 def test_a_missing_metric_in_a_fully_visible_row_is_incomplete_not_skipped(self):
  r=listing();next(n for n in r.iter('node') if n.get('text')=='37').set('text','')
  self.assertEqual(len(sync.note_cards(r)),4)
  with self.assertRaisesRegex(sync.ElementListReadError,'incomplete'):sync.element_page_signature(r)
 def test_signature_retains_duplicate_rows_for_later_window_identity_check(self):
  r=listing();cards=sync.note_cards(r);title=cards[0][1]['title']
  for n in cards[1][0].iter('node'):
   if n.get('text')==cards[1][1]['title']:n.set('text',title)
  signature=sync.element_page_signature(r,allow_duplicate_rows=True)
  self.assertEqual(len(signature[0]),5);self.assertEqual(signature[0][0][:2],signature[0][1][:2])
 def test_foreign_package_in_a_row_is_rejected(self):
  r=listing();next(n for n in r.iter('node') if n.get('text')=='37').set('package','other')
  with self.assertRaisesRegex(sync.ElementListReadError,'another package'):sync.element_page_signature(r)
 def test_rows_behind_the_fixed_header_are_excluded_and_not_a_newest_page(self):
  r=listing()
  for n in r.iter('node'):
   b=sync.bounds(n)
   if b and b[1]>=330:n.set('bounds',f'[{b[0]},{b[1]-284}][{b[2]},{b[3]-284}]')
  self.assertLess(len(sync.note_cards(r)),5)
  with self.assertRaisesRegex(sync.ElementListReadError,'newest list position'):sync.verify_newest_element_position(r)
 def test_synthetic_recognition_trees_are_rejected(self):
  for kind in ('windows_native_ocr','windows_native_ocr_navigation','anything_else'):
   r=listing();r.set('data-source',kind)
   with self.assertRaises(sync.ElementListReadError):sync.note_cards(r)
 def test_only_explicit_empty_element_state_can_be_empty(self):
  r=list_shell();ET.SubElement(r[0],'node',{'package':sync.XHS_PACKAGE,'class':'android.widget.TextView','text':'暂无笔记','bounds':'[300,900][420,950]'})
  self.assertIsNotNone(sync.element_page_signature(r));self.assertEqual(sync.note_cards(r),[])

class ElementCaptureTests(unittest.TestCase):
 current='mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'
 def test_failed_uncompressed_modes_can_use_a_fresh_compressed_element_tree(self):
  def read(a,b,*args,**kw):
   if '--compressed' in args:return ET.tostring(listing(),encoding='unicode')
   if args[:3]==('shell','uiautomator','dump'):raise RuntimeError('native dump exited137')
   return ''
  with patch.object(sync,'adb',side_effect=read) as adb,patch.object(sync,'focus',return_value=self.current),patch.object(sync.time,'sleep'):
   r=sync.capture('adb','serial')
  self.assertEqual(len(sync.note_cards(r)),5)
  calls=[c.args[2:] for c in adb.call_args_list];self.assertEqual(sum('--compressed' in c for c in calls),1)
  self.assertEqual(calls[-2][:3],('shell','rm','-f'));self.assertFalse(any('screencap' in c for c in calls))
 def test_failure_of_all_native_modes_remains_a_hierarchy_error(self):
  with patch.object(sync,'adb',return_value=''),patch.object(sync,'focus',return_value=self.current),patch.object(sync.time,'sleep'):
   with self.assertRaisesRegex(RuntimeError,'did not return an XML'):sync.capture('adb','serial')
 def test_loaded_elements_are_used_even_with_an_old_image_mode_event(self):
  r=listing();real=builtins.__import__
  def native_only(name,*args,**kw):
   if name in ('xhs_list_ocr','cv2','numpy'):raise AssertionError('recognition import forbidden')
   return real(name,*args,**kw)
  with patch.object(sync,'capture',return_value=r),patch.object(sync,'adb') as adb,patch('builtins.__import__',side_effect=native_only):
   self.assertIs(sync.navigation_capture('adb','serial',lambda:None,['works_list_image_reader_active']),r)
  adb.assert_not_called()
 def test_webview_hierarchy_failure_never_falls_back_to_screenshot(self):
  for error in (RuntimeError('UIAutomator did not return an XML hierarchy'),sync.subprocess.TimeoutExpired('adb',15)):
   with patch.object(sync,'native_window_capture',side_effect=RuntimeError('native elements command failed: native_elements_unproven:missing')),patch.object(sync,'capture',side_effect=error),patch.object(sync,'focus',return_value=self.current),patch.object(sync,'adb') as adb:
    with self.assertRaisesRegex(sync.ElementListReadError,'UI elements unavailable'):sync.navigation_capture('adb','serial',lambda:None,['collection_slot_requested:app1'])
    adb.assert_not_called()
 def test_wrong_foreground_slot_is_stopped_on_hierarchy_failure(self):
  with patch.object(sync,'capture',side_effect=RuntimeError('UIAutomator did not return an XML hierarchy')),patch.object(sync,'focus',return_value=self.current),patch.object(sync,'adb') as adb:
   with self.assertRaisesRegex(RuntimeError,'requested slot'):sync.navigation_capture('adb','serial',lambda:None,['collection_slot_requested:app2','clone_user_requested:999'])
   adb.assert_not_called()
 def test_runtime_source_has_no_recognition_imports_or_screenshot_commands(self):
  tree=ast.parse((S/'小红书数据同步.py').read_text())
  imports=[n.module for n in ast.walk(tree) if isinstance(n,ast.ImportFrom)]+[a.name for n in ast.walk(tree) if isinstance(n,ast.Import) for a in n.names]
  self.assertFalse(set(imports)&{'cv2','numpy','xhs_list_ocr'})
  literals=[n.value for n in ast.walk(tree) if isinstance(n,ast.Constant) and isinstance(n.value,str)]
  self.assertNotIn('screencap',literals)

class ElementFreshnessTests(unittest.TestCase):
 def wait(self,first,following):
  with patch.object(sync,'focus',return_value='mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'),patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'navigation_capture',side_effect=following) as capture,patch.object(sync.time,'sleep'),patch.object(sync,'adb'):
   value=sync.wait_creator_content('adb','serial',first,lambda:None,['collection_slot_requested:app1'])
  return value,capture.call_count
 def test_loading_then_two_complete_fresh_element_reads_are_required(self):
  good=listing();value,reads=self.wait(list_shell(),[good,copy.deepcopy(good)])
  self.assertEqual(sync.element_page_signature(value),sync.element_page_signature(good));self.assertEqual(reads,2)
 def test_a_changed_count_requires_two_later_agreeing_reads(self):
  first=listing();second=listing();next(n for n in second.iter('node') if n.get('text')=='252').set('text','253')
  _,reads=self.wait(first,[second,copy.deepcopy(second)]);self.assertEqual(reads,2)
 def test_a_missing_field_resets_the_stability_pair(self):
  good=listing();bad=listing();next(n for n in bad.iter('node') if n.get('text')=='37').set('text','')
  _,reads=self.wait(good,[bad,good,copy.deepcopy(good)]);self.assertEqual(reads,3)
 def test_persistent_loading_is_bounded_and_does_not_return_an_empty_result(self):
  r=list_shell()
  with patch.object(sync,'DATA_CENTER_LOAD_SECONDS',1),patch.object(sync,'focus',return_value='mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'),patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'navigation_capture',return_value=r) as capture,patch.object(sync.time,'sleep'),patch.object(sync,'adb'):
   with self.assertRaisesRegex(sync.ElementListReadError,'incomplete or unstable'):sync.wait_creator_content('adb','serial',r,lambda:None,['collection_slot_requested:app1','collection_scan_as_of:2026-10-22'])
  self.assertLessEqual(capture.call_count,14)
 def test_occupancy_stops_before_another_read(self):
  with patch.object(sync,'navigation_capture') as capture:
   with self.assertRaisesRegex(RuntimeError,'occupied'):sync.wait_creator_content('adb','serial',listing(),Mock(side_effect=RuntimeError('occupied')),[])
   capture.assert_not_called()
 def test_refresh_opens_and_closes_only_the_proven_native_filter(self):
  r=list_shell();opened=panel();events=[]
  with patch.object(sync,'wake_if_asleep'),patch.object(sync,'navigation_capture',side_effect=[opened,r]),patch.object(sync,'tap_filter_label') as tap:
   self.assertIs(sync.refresh_scrolled_webview('adb','serial',r,lambda:None,events),r)
  self.assertEqual([c.args[3] for c in tap.call_args_list],['全部笔记','收起'])
 def test_stale_filter_tree_stops_after_bounded_element_rereads(self):
  r=list_shell()
  with patch.object(sync,'wake_if_asleep'),patch.object(sync,'navigation_capture',return_value=r) as capture,patch.object(sync,'tap_filter_label') as tap,patch.object(sync.time,'sleep'):
   with self.assertRaisesRegex(sync.ElementListReadError,'panel elements'):sync.refresh_scrolled_webview('adb','serial',r,lambda:None,[])
  self.assertEqual(capture.call_count,4);self.assertEqual([c.args[3] for c in tap.call_args_list],['全部笔记'])

class ElementCollectionTests(unittest.TestCase):
 def collect(self,first,following=None):
  args=SimpleNamespace(adb='adb',serial='serial',device_name='test',task_id='test',app_slot='app1',device_cache='unused',cancel_file='',days=30,max_scrolls=1,min_scrolls=0,stagnant_rounds=3)
  def start(*arguments):arguments[-1].append('collection_slot_requested:app1');return first
  with ExitStack() as stack:
   for name in ('release_idle_poco','verify_collection_slot','assert_no_poco','swipe'):stack.enter_context(patch.object(sync,name))
   stack.enter_context(patch.object(sync,'assert_idle',return_value={'xhsAccounts':[{'appSlot':'app1','enabled':True,'xhsId':'test'}]}))
   stack.enter_context(patch.object(sync,'adb',return_value='device'));stack.enter_context(patch.object(sync,'start_xhs',side_effect=start))
   stack.enter_context(patch.object(sync,'ensure_creator_list',side_effect=lambda a,b,r,*rest:r));stack.enter_context(patch.object(sync,'reopen_creator_list',return_value=first))
   stack.enter_context(patch.object(sync,'wait_creator_content',side_effect=lambda a,b,r,*rest:r));stack.enter_context(patch.object(sync,'refresh_scrolled_webview',side_effect=lambda a,b,r,*rest:r))
   stack.enter_context(patch.object(sync,'navigation_capture',side_effect=following or []))
   stack.enter_context(patch.object(sync,'probe_element_pair',return_value=False))
   stack.enter_context(patch.object(sync,'prove_native_list_start',side_effect=lambda a,b,r,*rest:r))
   return sync.collect_once(args)
 def test_post_swipe_element_failure_preserves_prior_notes_as_incomplete(self):
  r=self.collect(listing(),[sync.ElementListReadError('missing elements')])
  self.assertFalse(r['complete']);self.assertEqual(len(r['notes']),5);self.assertEqual(r['stop_reason'],'elements_unproven');self.assertIn('collection_reader:ui_elements_only',r['recovery_events'])
 def test_proven_oldest_date_can_complete_an_element_only_zero_post_window(self):
  first=listing()
  for n in first.iter('node'):
   if n.get('text')=='10-19':n.set('text','08-31')
  r=self.collect(first);self.assertTrue(r['complete']);self.assertEqual(r['notes'],[]);self.assertEqual(r['stop_reason'],'older_than_window_visible')
 def duplicate_listing(self, date):
  root=listing();cards=sync.note_cards(root);title=cards[0][1]['title']
  for row,item in cards:
   for n in row.iter('node'):
    if n.get('text')==item['title']:n.set('text',title)
    if n.get('text')==item['published_at_raw']:n.set('text',date)
  return root
 def test_old_duplicate_titles_are_only_boundary_evidence_not_output_rows(self):
  result=self.collect(ET.parse(S/'fixtures/xhs/works-duplicate-old-titles.xml').getroot())
  self.assertTrue(result['complete']);self.assertEqual(result['notes'],[])
  self.assertEqual(result['stop_reason'],'older_than_window_visible')
  self.assertEqual(result['scan_rounds'][0]['visible_cards'],6)
 def test_duplicate_titles_inside_window_still_stop_before_deduplication(self):
  with self.assertRaisesRegex(sync.ElementListReadError,'ambiguous'):
   self.collect(self.duplicate_listing('10-19'))
 def test_unchanged_element_page_cannot_be_declared_complete_at_scroll_limit(self):
  first=listing();r=self.collect(first,[copy.deepcopy(first)])
  self.assertFalse(r['complete']);self.assertEqual(len(r['notes']),5);self.assertIn('recent_window_not_proven',r['warnings'])
 def test_displayed_wan_units_remain_marked_as_approximations(self):
  first=listing();next(n for n in first.iter('node') if n.get('text')=='252').set('text','1.3万')
  r=self.collect(first,[copy.deepcopy(first)])
  self.assertEqual(r['notes'][0]['list_view_count'],13000);self.assertIn('list_metric_units_are_displayed_approximations',r['warnings'])
 def test_a_page_jump_without_element_overlap_is_incomplete(self):
  first=listing();second=listing()
  for n in second.iter('node'):
   if n.get('text','').startswith('合成标题'):n.set('text',n.get('text')+'新一页')
  r=self.collect(first,[second]);self.assertFalse(r['complete']);self.assertEqual(len(r['notes']),5);self.assertEqual(r['stop_reason'],'elements_unproven')
 def test_raw_overlapping_element_rows_can_prove_continuity(self):
  first=listing();second=listing();sync.verify_element_overlap(first,second)

class LongNativeWindowTests(unittest.TestCase):
 def run_main(self,limit=None,fast=False):
  import tempfile,sys,json
  pages=[]
  for page in range(32):
   root=listing()
   for offset,(row,item) in enumerate(sync.note_cards(root)):
    index=page+offset
    next(n for n in row.iter("node") if n.get("text")==item["title"]).set("text",f"连续原生帖子{index}")
    next(n for n in row.iter("node") if n.get("text")==item["published_at_raw"]).set("text","09-20" if index>=35 else "10-19")
   pages.append(root)
  first=pages[0]
  class FixedDateTime(dt.datetime):
   @classmethod
   def now(cls,tz=None):return cls(2026,10,20,12,tzinfo=sync.SHANGHAI)
  with tempfile.TemporaryDirectory() as tmp,ExitStack() as stack:
   output=Path(tmp)/"result.json"
   argv=['collector','--serial','serial','--device-name','test','--device-cache','fake','--app-slot','app1','--output',str(output)]
   if limit is not None:argv+=['--max-scrolls',str(limit)]
   stack.enter_context(patch.object(sys,'argv',argv));stack.enter_context(patch.object(sync.dt,'datetime',FixedDateTime));stack.enter_context(patch('builtins.print'))
   for name in ('release_idle_poco','verify_collection_slot','assert_no_poco','swipe'):stack.enter_context(patch.object(sync,name))
   stack.enter_context(patch.object(sync,'assert_idle',return_value={'xhsAccounts':[{'appSlot':'app1','enabled':True,'xhsId':'test'}]}))
   stack.enter_context(patch.object(sync,'adb',side_effect=lambda a,b,*args,**kw: 'device' if args==('get-state',) else '1800000'));stack.enter_context(patch.object(sync,'start_xhs',return_value=first))
   stack.enter_context(patch.object(sync,'ensure_creator_list',side_effect=lambda a,b,r,*rest:r));stack.enter_context(patch.object(sync,'reopen_creator_list',return_value=first))
   stack.enter_context(patch.object(sync,'wait_creator_content',side_effect=lambda a,b,r,*rest:r));stack.enter_context(patch.object(sync,'refresh_scrolled_webview',side_effect=lambda a,b,r,*rest:r))
   stack.enter_context(patch.object(sync,'navigation_capture',side_effect=pages[1:]*2))
   stack.enter_context(patch.object(sync,'NATIVE_PAIR_PROBE_ENABLED',fast))
   probe=stack.enter_context(patch.object(sync,'probe_element_pair',return_value=fast))
   stack.enter_context(patch.object(sync,'capture_element_pair',side_effect=[(r,copy.deepcopy(r)) for r in pages[1:]]*2))
   stack.enter_context(patch.object(sync,'prove_native_list_start',side_effect=lambda a,b,r,*rest:r))
   code=sync.main();result=json.loads(output.read_text())
   if fast:self.assertEqual(probe.call_count,2)
   else:probe.assert_not_called()
  return code,result
 def test_default_scan_continues_past_thirty_swipes_to_proven_date_boundary(self):
  code,result=self.run_main();self.assertEqual(code,0);self.assertTrue(result['complete']);self.assertEqual(result['scrolls'],31)
  self.assertEqual(result['stop_reason'],'older_than_window_visible');self.assertEqual(len(result['notes']),35)
 def test_explicit_smaller_budget_still_preserves_incomplete_data(self):
  code,result=self.run_main(30);self.assertEqual(code,2);self.assertFalse(result['complete']);self.assertEqual(result['scrolls'],30)
  self.assertEqual(result['stop_reason'],'scroll_budget_exhausted');self.assertEqual(len(result['notes']),35)
 def test_fast_path_keeps_all_35_notes_and_31_page_overlap_checks(self):
  _,slow=self.run_main();code,fast=self.run_main(fast=True)
  self.assertEqual(code,0);self.assertTrue(fast['complete']);self.assertEqual(fast['notes'],slow['notes'])
  self.assertEqual(fast['scan_rounds'],slow['scan_rounds']);self.assertEqual(fast['scrolls'],31)
  self.assertIn('native_pair_fast_pages:31',fast['recovery_events'])


class ZeroBoundsElementTests(unittest.TestCase):
 def test_no_pixel_matching_or_tap_when_footer_has_zero_bounds(self):
  from test_xhs_data_sync import ZeroBoundsProfileTests
  r=ZeroBoundsProfileTests().footer();current=ZeroBoundsProfileTests.current
  with patch.object(sync,'adb') as adb,patch.object(sync,'adb_process') as process,patch.object(sync,'native_index_navigation',side_effect=sync.ElementListReadError('native element action rejected')):
   with self.assertRaisesRegex(sync.ElementListReadError,'native element action rejected'):sync.select_zero_bounds_profile('adb','serial',r,current,lambda:None,[])
  adb.assert_not_called();process.assert_not_called()

if __name__=='__main__':unittest.main()

class NavigationDiagnosticTests(unittest.TestCase):
 def test_only_known_landmarks_are_reported(self):
  r=ET.fromstring('<hierarchy><node text="我" selected="true" bounds="[1,1][20,20]"/><node text="菜单" bounds="[1,1][20,20]"/><node text="private account title" bounds="[1,1][20,20]"/></hierarchy>')
  self.assertEqual(sync.creator_navigation_state(r),'我/菜单;profile_selected=true')
