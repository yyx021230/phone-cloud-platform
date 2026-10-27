"""Entry routing and geometry-limited speed changes retain element proofs."""
import builtins
from contextlib import ExitStack
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

S=Path(__file__).parent
spec=importlib.util.spec_from_file_location('speed4_sync',S/'小红书数据同步.py')
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
CURRENT='mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'

def home(overview=True):
 r=ET.Element('hierarchy')
 for i,t in enumerate(['创作中心','最新笔记','更多']+(['近 7 日数据','观看'] if overview else [])):
  ET.SubElement(r,'node',{'text':t,'bounds':f'[1,{i*100+1}][300,{i*100+90}]','class':'android.widget.TextView','package':'com.xingin.xhs'})
 return r

def listing():return ET.parse(S/'fixtures/xhs/works-elements-141.xml').getroot()

class FasterEntryTests(unittest.TestCase):
 def test_proven_overview_precedes_more_but_more_remains_a_fallback(self):
  for overview,target in [(True,'观看'),(False,'更多')]:
   r=home(overview);ready=listing();events=['collection_slot_requested:app1']
   with self.subTest(overview=overview),patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'recover_known_overlay',return_value=False),patch.object(sync,'focus',return_value=CURRENT),patch.object(sync,'tap_label') as tap,patch.object(sync,'navigation_capture',return_value=ready),patch.object(sync.time,'sleep'):
    self.assertIs(sync.ensure_creator_list('adb','s',r,'app1',lambda:None,events),ready)
   self.assertEqual(tap.call_count,1);self.assertEqual(tap.call_args.args[3],target)
 def test_newest_reset_is_kept_and_also_uses_the_proven_overview(self):
  r=home();ready=listing();events=['collection_slot_requested:app1']
  with patch.object(sync,'navigation_capture',side_effect=[r,ready]),patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'tap_label') as tap,patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
   self.assertIs(sync.reopen_creator_list('adb','s',ready,lambda:None,events),ready)
  self.assertEqual(tap.call_args.args[3],'观看');self.assertEqual(adb.call_args.args[2:],('shell','input','keyevent','4'))
  self.assertIn('list_reopened_at_newest',events)
 def test_unproven_overview_does_not_select_arbitrary_metric(self):
  r=home();r.append(ET.fromstring(ET.tostring(next(n for n in r if n.get('text')=='观看'))))
  self.assertFalse(sync.creator_overview_entry(r))

class OverviewLoadingTests(unittest.TestCase):
 def test_blank_overview_uses_existing_time_budget_instead_of_spinning_navigation(self):
  blank=ET.parse(S/'fixtures/xhs/blank-works-loading-18.xml').getroot();ready=listing()
  with patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'recover_known_overlay',return_value=False),patch.object(sync,'focus',return_value=CURRENT),patch.object(sync,'tap_label'),patch.object(sync,'navigation_capture',return_value=blank),patch.object(sync.time,'sleep'),patch.object(sync,'wait_data_center_loading',return_value=ready) as wait:
   self.assertIs(sync.ensure_creator_list('adb','s',home(),'app1',lambda:None,['collection_slot_requested:app1']),ready)
  self.assertEqual(wait.call_count,1);self.assertIs(wait.call_args.args[2],blank)

class OverlapScrollTests(unittest.TestCase):
 def distance(self,rows):
  root=listing();cards=[(ET.Element('node',{'bounds':f'[20,{top}][1000,{bottom}]'}),{}) for top,bottom in rows]
  with patch.object(sync,'note_cards',return_value=cards),patch.object(sync,'focus',return_value=CURRENT),patch.object(sync,'wake_if_asleep'),patch.object(sync.time,'sleep'),patch.object(sync,'adb') as adb:
   sync.swipe('adb','s',root,lambda:None,[])
  a=adb.call_args.args;return int(a[6])-int(a[8])
 def test_four_to_eight_complete_rows_keep_two_rows_and_at_most_three_row_heights(self):
  for count in range(4,9):
   rows=[(330+i*190,510+i*190) for i in range(count)];d=self.distance(rows)
   self.assertLessEqual(d,rows[-2][0]-rows[0][0]);self.assertLessEqual(d,540)
   self.assertGreater(d,0)
 def test_five_rows_advance_more_than_old_two_row_cap_without_losing_overlap(self):
  rows=[(330+i*190,510+i*190) for i in range(5)];d=self.distance(rows)
  self.assertGreater(d,360);self.assertLessEqual(d,570)
 def test_sparse_or_overlapping_rows_stay_on_the_original_short_step(self):
  for rows in [[(330,510)],[(330,510),(520,700)],[(330,510),(520,700),(710,890)],[(330,510),(350,530),(540,720),(730,910)]]:
   d=self.distance(rows);height=180;span=rows[-1][0]-rows[0][0]
   self.assertLessEqual(d,min(height*2,max(height*.5,span*.5)))
 def test_observed_47_and_141_edge_rounding_still_preserves_two_row_starts(self):
  for name in ('works-47-before-subset.xml','works-elements-141.xml'):
   r=ET.parse(S/'fixtures/xhs'/name).getroot();boxes=[sync.bounds(n) for n,_ in sync.note_cards(r)];rows=[(b[1],b[3]) for b in boxes]
   # Use each retained viewport itself, not a fabricated larger screen.
   with patch.object(sync,'focus',return_value=CURRENT),patch.object(sync,'wake_if_asleep'),patch.object(sync.time,'sleep'),patch.object(sync,'adb') as adb:
    sync.swipe('adb','s',r,lambda:None,[])
   a=adb.call_args.args;distance=int(a[6])-int(a[8]);height=sorted(b[3]-b[1] for b in boxes)[len(boxes)//2]
   self.assertLessEqual(distance,rows[-2][0]-rows[0][0]);self.assertLessEqual(distance,height*3)
   old=min((max(b[3] for b in boxes))*.25,height*2,max(height*.5,(rows[-1][0]-rows[0][0])*.5))
   self.assertGreater(distance,old)
 def test_edge_overlap_beyond_tiny_rounding_keeps_old_small_step(self):
  for overlap in (10,30,100):
   rows=[(330+i*(180-overlap),510+i*(180-overlap)) for i in range(5)]
   self.assertLessEqual(self.distance(rows),360)
 def test_occupancy_blocks_the_swipe(self):
  with patch.object(sync,'focus',return_value=CURRENT),patch.object(sync,'wake_if_asleep'),patch.object(sync,'adb') as adb:
   with self.assertRaisesRegex(RuntimeError,'occupied'):
    sync.swipe('adb','s',listing(),lambda:(_ for _ in ()).throw(RuntimeError('occupied')),[])
   adb.assert_not_called()

class ProbeDisabledTests(unittest.TestCase):
 def test_default_skips_experimental_probe(self):self.assertFalse(sync.NATIVE_PAIR_PROBE_ENABLED)
 def test_stock_path_does_not_require_the_unpublished_pair_helper(self):
  real_import=builtins.__import__;root=listing()
  def no_pair(name,*args,**kw):
   if name=='xhs_native_window':raise ImportError('production helper has no NativePairUnavailable')
   return real_import(name,*args,**kw)
  with patch('builtins.__import__',side_effect=no_pair),patch.object(sync,'navigation_capture',return_value=root),patch.object(sync,'refresh_scrolled_webview',return_value=root),patch.object(sync,'wait_creator_content',return_value=root),patch.object(sync,'capture_element_pair') as pair:
   result,fast,enabled=sync.read_scrolled_content('adb','s',root,lambda:None,[],False)
  self.assertIs(result,root);self.assertFalse(fast or enabled);pair.assert_not_called()
