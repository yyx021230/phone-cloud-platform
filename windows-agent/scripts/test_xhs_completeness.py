"""Completeness regressions using native trees only; no device/network access."""
import copy
import argparse
import datetime as dt
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

S = Path(__file__).parent
spec = importlib.util.spec_from_file_location('integrity_sync', S/'小红书数据同步.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def page(titles):
    root = ET.parse(S/'fixtures/xhs/works-elements-141.xml').getroot()
    parents = {child: parent for parent in root.iter() for child in parent}
    for index, (row, item) in enumerate(sync.note_cards(root)):
        if index >= len(titles):
            parents[row].remove(row)
        else:
            next(n for n in row.iter('node') if n.get('text') == item['title']).set('text', titles[index])
    return root


class OrderedContinuityTests(unittest.TestCase):
    def test_shared_first_row_does_not_prove_the_unseen_tail_was_scanned(self):
        with self.assertRaises(sync.ElementListReadError):
            sync.verify_element_overlap(page(['A','B','C','D','E']), page(['A','F','G','H','I']))

    def test_missing_known_row_inside_overlap_is_rejected(self):
        with self.assertRaises(sync.ElementListReadError):
            sync.verify_element_overlap(page(['A','B','C','D','E']), page(['C','E','F','G','H']))

    def test_reordered_shared_rows_are_rejected(self):
        with self.assertRaises(sync.ElementListReadError):
            sync.verify_element_overlap(page(['A','B','C','D','E']), page(['C','E','D','F','G']))

    def test_contiguous_tail_and_unchanged_page_remain_valid(self):
        first = page(['A','B','C','D','E'])
        sync.verify_element_overlap(first, page(['C','D','E','F','G']))
        sync.verify_element_overlap(first, copy.deepcopy(first))


class TerminalEvidenceTests(unittest.TestCase):
    def test_a_post_title_is_not_an_end_or_empty_marker(self):
        for text, index in [('到底了', 2), ('暂无笔记', 1)]:
            with self.subTest(text=text):
                self.assertFalse(sync.element_page_signature(page(['A','B','C','D',text]))[index])

    def test_empty_marker_requires_no_dated_or_status_rows(self):
        root = page([])
        view = next(n for n in root.iter('node') if n.get('class') == 'android.webkit.WebView' and n.get('text') == '数据中心')
        attrs = {'text':'暂无笔记', 'package':sync.XHS_PACKAGE,
                 'class':'android.widget.TextView', 'bounds':'[100,400][500,450]'}
        ET.SubElement(view, 'node', attrs)
        self.assertEqual(sync.proven_list_terminal(root), (True, False))
        ET.SubElement(view, 'node', {**attrs, 'text':'10-19', 'bounds':'[30,500][80,530]'})
        self.assertEqual(sync.proven_list_terminal(root), (False, False))

    def test_foreign_or_inside_row_footer_is_not_proof(self):
        for package, box in [('other.app','[100,1380][400,1400]'),
                             (sync.XHS_PACKAGE,'[100,500][400,530]')]:
            root = page(['A','B','C','D','E'])
            view = next(n for n in root.iter('node') if n.get('class') == 'android.webkit.WebView' and n.get('text') == '数据中心')
            ET.SubElement(view, 'node', {'text':'到底了','package':package,
                'class':'android.widget.TextView','bounds':box})
            self.assertFalse(sync.proven_list_terminal(root)[1])


class HistoryTests(unittest.TestCase):
    def verify(self, titles, terminal=False):
        sync.verify_history_extension([(x,'10-19') for x in 'ABCDE'], page(titles),
            dt.date(2026,10,27), dt.date(2026,9,28), terminal)

    def test_full_history_tail_required_before_appending(self):
        for titles in [list('AFGHI'), list('CEFGH'), list('DECAB')]:
            with self.subTest(titles=titles), self.assertRaises(sync.ElementListReadError):
                self.verify(titles)
        self.verify(list('CDEFG'))

    def test_terminal_cannot_hide_the_known_tail(self):
        with self.assertRaises(sync.ElementListReadError):
            self.verify(list('ABC'), terminal=True)
        self.verify(list('CDE'), terminal=True)


class TopProofTests(unittest.TestCase):
    def run_proof(self, roots, guard=None):
        events = []
        with patch.object(sync,'swipe') as swipe, \
                patch.object(sync,'navigation_capture',side_effect=roots), \
                patch.object(sync,'refresh_scrolled_webview',side_effect=lambda a,b,r,*args:r), \
                patch.object(sync,'wait_creator_content',side_effect=lambda a,b,r,*args:r):
            result = sync.prove_native_list_start('adb','serial',page(list('ABCDE')),guard or Mock(),events)
        return result,events,swipe

    def test_fresh_unchanged_leading_row_confirms_start(self):
        _,events,swipe = self.run_proof([page(list('ABCDE'))])
        swipe.assert_called_once()
        self.assertTrue(swipe.call_args.kwargs['reverse'])
        self.assertIn('list_top_confirmed_by_reverse_scroll', events)

    def test_changed_first_row_requires_another_fresh_check(self):
        _,_,swipe = self.run_proof([page(list('ZABCD')),page(list('ZABCD'))])
        self.assertEqual(swipe.call_count,2)

    def test_unstable_start_is_bounded(self):
        with self.assertRaisesRegex(sync.ElementListReadError,'did not stabilize'):
            self.run_proof([page(list('ZABCD')),page(list('YZABC')),page(list('XYZAB'))])

    def test_occupancy_guard_prevents_input(self):
        with patch.object(sync,'swipe') as swipe:
            with self.assertRaisesRegex(RuntimeError,'occupied'):
                sync.prove_native_list_start('adb','serial',page(list('ABCDE')),
                    Mock(side_effect=RuntimeError('occupied')),[])
            swipe.assert_not_called()


def result(titles=('A','B','C')):
    return {'complete':True,'stop_reason':'older_than_window_visible','app_slot':'app1',
            'window_start_date':'2026-09-28','window_end_date':'2026-10-27',
            'list_scope_raw':'仅统计近一年发布的笔记','scrolls':3,'recovery_events':[], 'warnings':[],
            'notes':[{'title':x,'published_date':'2026-10-19','list_view_count':10} for x in titles]}


class IndependentPassTests(unittest.TestCase):
    def collect(self, first, second):
        with patch.object(sync,'collect_once',side_effect=[first,second]) as run:
            out = sync.collect(argparse.Namespace(app_slot='app1'))
        return out,run

    def test_equal_ordered_identities_accept_changed_metrics(self):
        a,b = result(),result()
        b['notes'][0]['list_view_count'] = 20
        out,run = self.collect(a,b)
        self.assertTrue(out['complete'])
        self.assertEqual(out['notes'][0]['list_view_count'],10)
        self.assertIn('collection_integrity:verified_two_pass',out['recovery_events'])
        self.assertTrue(run.call_args_list[1].args[0].verification_pass)
        digests = [e.split(':',1)[1] for e in out['recovery_events'] if '_sha256:' in e]
        self.assertEqual(len(digests),2)
        self.assertEqual(digests[0],digests[1])

    def test_missing_added_reordered_or_duplicate_post_cannot_pass(self):
        for first,second in [(result(),result(('A','C'))),
                             (result(),result(('A','B','C','D'))),
                             (result(),result(('A','C','B'))),
                             (result(('A','A')),result(('A','A')))]:
            out,_ = self.collect(first,second)
            self.assertFalse(out['complete'])
            self.assertEqual(out['stop_reason'],'verification_unproven')
            self.assertNotIn('collection_integrity:verified_two_pass',out['recovery_events'])

    def test_scope_date_slot_and_terminal_are_required(self):
        for key,value in [('app_slot','app2'),('window_start_date','2026-09-29'),
                          ('window_end_date','2026-10-28'),('list_scope_raw',None),
                          ('complete',False),('stop_reason','list_stagnant')]:
            second=result();second[key]=value
            with self.subTest(key=key):
                self.assertFalse(self.collect(result(),second)[0]['complete'])

    def test_incomplete_first_pass_does_not_start_verification(self):
        first=result();first['complete']=False
        out,run=self.collect(first,result())
        self.assertFalse(out['complete']);run.assert_called_once()

    def test_element_failure_never_serializes_provisional_complete(self):
        out,_=self.collect(result(),sync.ElementListReadError('missing native row'))
        self.assertFalse(out['complete'])

    def test_cancel_or_occupancy_propagates_for_existing_cleanup(self):
        with self.assertRaisesRegex(RuntimeError,'cancelled'):
            self.collect(result(),RuntimeError('cancelled'))

    def test_loading_reopen_budget_is_carried_between_passes(self):
        first=result();first['recovery_events']=['data_center_loading_reopen:1','works_native_more_recovery_attempted']
        _,run=self.collect(first,result())
        self.assertEqual(run.call_args_list[1].args[0].used_loading_reopens,2)

    def test_empty_scans_still_require_matching_proven_boundary(self):
        a,b=result(()),result(())
        a['stop_reason']=b['stop_reason']='list_end_visible'
        self.assertTrue(self.collect(a,b)[0]['complete'])


class VerificationStrideTests(unittest.TestCase):
    def distance(self, events):
        with patch.object(sync,'adb') as adb, patch.object(sync,'wake_if_asleep'), \
                patch.object(sync.time,'sleep'):
            sync.swipe('adb','serial',page(list('ABCDE')),Mock(),events)
        args=adb.call_args.args
        return int(args[-4])-int(args[-2])

    def test_audit_uses_a_smaller_step_on_same_native_rows(self):
        self.assertLess(self.distance(['collection_verification_pass']),self.distance([]))


if __name__ == '__main__':
    unittest.main()
