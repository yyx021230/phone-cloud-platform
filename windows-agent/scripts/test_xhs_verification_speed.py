"""Audit-only speedups preserve two ordered scans and the primary stable reader."""
import argparse
import copy
import unittest
from unittest.mock import Mock, patch
from test_xhs_completeness import sync, page

FOCUS = 'mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'

def native(titles):
    root=page(list(titles));root.set('native-window-reader','1')
    return root


class VerificationReadTests(unittest.TestCase):
    def read(self, after, verification=True, focus=FOCUS):
        events=['collection_slot_requested:app1']+(['collection_verification_pass'] if verification else [])
        with patch.object(sync,'navigation_capture',return_value=after) as capture, \
                patch.object(sync,'focus',return_value=focus), \
                patch.object(sync,'refresh_scrolled_webview',return_value=after) as refresh, \
                patch.object(sync,'wait_creator_content',return_value=after) as stable:
            out=sync.read_scrolled_content('adb','serial',native('ABCDE'),Mock(),events,False)
        return out,events,capture,refresh,stable

    def test_primary_still_uses_existing_stability_checks(self):
        _,events,capture,refresh,stable=self.read(native('CDEFG'),verification=False)
        capture.assert_called_once();refresh.assert_called_once();stable.assert_called_once()
        self.assertNotIn('verification_fresh_page_accepted',events)

    def test_new_complete_ordered_native_audit_page_avoids_redundant_capture(self):
        out,events,capture,refresh,stable=self.read(native('CDEFG'))
        capture.assert_called_once();refresh.assert_not_called();stable.assert_not_called()
        self.assertIn('verification_fresh_page_accepted',events)
        self.assertEqual(out[1:],(False,False)) # Not a native pair/probe read.

    def test_stale_or_non_native_page_uses_original_refresh_and_double_read(self):
        for after in [native('ABCDE'),page(list('CDEFG'))]:
            with self.subTest():
                _,events,capture,refresh,stable=self.read(after)
                capture.assert_called_once();refresh.assert_called_once();stable.assert_called_once()
                self.assertIn('verification_page_stability_fallback',events)

    def test_partial_native_page_cannot_skip_stability(self):
        after=native('CDEFG')
        with patch.object(sync,'element_page_signature',side_effect=sync.ElementListReadError('partial row')):
            _,events,_,refresh,stable=self.read(after)
        refresh.assert_called_once();stable.assert_called_once()
        self.assertNotIn('verification_fresh_page_accepted',events)

    def test_missing_or_reordered_overlap_stops_before_any_other_input(self):
        for titles in ['CEFGH','CEDFG','FGHIJ']:
            with self.subTest(titles=titles),self.assertRaises(sync.ElementListReadError):
                self.read(native(titles))

    def test_foreign_slot_is_not_read(self):
        with patch.object(sync,'navigation_capture') as capture, \
                patch.object(sync,'focus',return_value=FOCUS.replace('u0','u999')):
            with self.assertRaisesRegex(RuntimeError,'user does not match'):
                sync.read_scrolled_content('adb','serial',native('ABCDE'),Mock(),
                    ['collection_slot_requested:app1','collection_verification_pass'],False)
        capture.assert_not_called()

    def test_focus_change_during_capture_stops(self):
        with patch.object(sync,'navigation_capture',return_value=native('CDEFG')), \
                patch.object(sync,'focus',side_effect=[FOCUS,FOCUS.replace('u0','u999')]):
            with self.assertRaisesRegex(sync.ElementListReadError,'changed during read'):
                sync.read_scrolled_content('adb','serial',native('ABCDE'),Mock(),
                    ['collection_slot_requested:app1','collection_verification_pass'],False)

    def test_cancellation_prevents_any_capture(self):
        with patch.object(sync,'navigation_capture') as capture:
            with self.assertRaisesRegex(RuntimeError,'cancelled'):
                sync.read_scrolled_content('adb','serial',native('ABCDE'),
                    Mock(side_effect=RuntimeError('cancelled')),
                    ['collection_slot_requested:app1','collection_verification_pass'],False)
        capture.assert_not_called()


class VerificationEntryTests(unittest.TestCase):
    def args(self,slot='app1'):
        return argparse.Namespace(adb='adb',serial='serial',app_slot=slot,
            verified_entry_events=['collection_slot_requested:'+slot,'native_window_elements_enabled',
                'collection_scan_as_of:2026-10-27','data_center_loading_reopen:1']+
                (['clone_user_requested:999','clone_slot_selected:app2'] if slot=='app2' else []))

    def test_current_list_is_read_afresh_without_relaunch_and_slot_is_rechecked(self):
        for slot in ['app1','app2']:
            events=['collection_verification_pass'];root=native('ABCDE')
            focus=FOCUS if slot=='app1' else FOCUS.replace('u0','u999')
            with self.subTest(slot=slot),patch.object(sync,'focus',return_value=focus), \
                    patch.object(sync,'navigation_capture',return_value=root) as capture:
                self.assertIs(sync.verification_entry(self.args(slot),Mock(),events),root)
            capture.assert_called_once()
            self.assertIn('verification_existing_list_reused',events)
            self.assertIn('native_window_elements_enabled',events)
            self.assertNotIn('collection_scan_as_of:2026-10-27',events)
            self.assertNotIn('data_center_loading_reopen:1',events)
            if slot=='app2':self.assertIn('clone_slot_selected:app2',events)

    def test_no_primary_slot_proof_requires_full_entry(self):
        args=self.args();args.verified_entry_events=[]
        with patch.object(sync,'navigation_capture') as capture:
            self.assertIsNone(sync.verification_entry(args,Mock(),[]))
        capture.assert_not_called()

    def test_wrong_foreground_slot_never_reuses_entry(self):
        with patch.object(sync,'focus',return_value=FOCUS),patch.object(sync,'navigation_capture') as capture:
            with self.assertRaises(RuntimeError):sync.verification_entry(self.args('app2'),Mock(),[])
        capture.assert_not_called()

    def test_same_slot_non_list_returns_to_existing_navigation(self):
        with patch.object(sync,'focus',return_value=FOCUS.replace('WebViewActivityV2','OtherActivity')), \
                patch.object(sync,'navigation_capture') as capture:
            self.assertIsNone(sync.verification_entry(self.args(),Mock(),[]))
        capture.assert_not_called()

    def test_changed_focus_or_occupancy_stops_before_reopen(self):
        with patch.object(sync,'focus',side_effect=[FOCUS,FOCUS.replace('u0','u999')]), \
                patch.object(sync,'navigation_capture',return_value=native('ABCDE')):
            with self.assertRaisesRegex(sync.ElementListReadError,'entry foreground changed'):
                sync.verification_entry(self.args(),Mock(),[])
        with patch.object(sync,'navigation_capture') as capture:
            with self.assertRaisesRegex(RuntimeError,'occupied'):
                sync.verification_entry(self.args(),Mock(side_effect=RuntimeError('occupied')),[])
        capture.assert_not_called()


if __name__=='__main__':unittest.main()
