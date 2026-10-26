"""Fast scans preserve complete rows, fresh double reads, continuity and cleanup."""
import copy
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET
import xhs_native_window as native

S = Path(__file__).parent
spec = importlib.util.spec_from_file_location('pair_sync', S/'小红书数据同步.py')
sync = importlib.util.module_from_spec(spec); spec.loader.exec_module(sync)
FOCUS = 'mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'


class PairScanTests(unittest.TestCase):
    def setUp(self):
        self.before = ET.parse(S/'fixtures/xhs/works-elements-141.xml').getroot()
        self.after = copy.deepcopy(self.before)
        title = sync.note_cards(self.after)[-1][1]['title']
        next(n for n in self.after.iter('node') if n.get('text') == title).set('text', 'new synthetic note')
        self.events = ['collection_slot_requested:app1']

    def read(self, enabled=True):
        return sync.read_scrolled_content('adb', 'serial', self.before, lambda: None, self.events, enabled)

    def test_probe_requires_both_fresh_trees_to_match_stock_fields(self):
        for trees, expected in [((self.before, copy.deepcopy(self.before)), True),
                                ((self.before, self.after), False), ((self.after, self.after), False)]:
            with self.subTest(expected=expected), patch.object(sync, 'adb', return_value='30'), patch.object(sync, 'capture_element_pair', return_value=trees):
                self.assertEqual(sync.probe_element_pair('adb', 'serial', self.before, lambda: None, []), expected)

    def test_older_sdk_does_not_launch_new_reader(self):
        with patch.object(sync, 'adb', return_value='23'), patch.object(sync, 'capture_element_pair') as read:
            self.assertFalse(sync.probe_element_pair('adb', 'serial', self.before, lambda: None, []))
        read.assert_not_called()

    def test_progressing_pair_returns_complete_data_without_third_capture_or_filter_toggle(self):
        with patch.object(sync, 'capture_element_pair', return_value=(self.after, copy.deepcopy(self.after))), \
                patch.object(sync, 'navigation_capture') as stock, patch.object(sync, 'refresh_scrolled_webview') as refresh:
            root, fast, enabled = self.read()
        self.assertTrue(fast and enabled)
        self.assertEqual(sync.element_page_signature(root), sync.element_page_signature(self.after))
        stock.assert_not_called(); refresh.assert_not_called()

    def test_stale_clipped_or_changing_counts_use_old_refresh_and_stability_path(self):
        changed = copy.deepcopy(self.after)
        next(n for n in changed.iter('node') if n.get('text') == '252').set('text', '253')
        for pair in [(self.before, self.before), (self.after, changed), (ET.Element('hierarchy'), self.after)]:
            with self.subTest(), patch.object(sync, 'capture_element_pair', return_value=pair), \
                    patch.object(sync, 'navigation_capture', return_value=self.after) as stock, \
                    patch.object(sync, 'refresh_scrolled_webview', return_value=self.after) as refresh, \
                    patch.object(sync, 'wait_creator_content', return_value=self.after) as wait:
                _, fast, enabled = self.read()
            self.assertFalse(fast or enabled); stock.assert_called_once(); refresh.assert_called_once(); wait.assert_called_once()

    def test_disabled_pair_does_not_retry_on_following_pages(self):
        with patch.object(sync, 'capture_element_pair') as pair, \
                patch.object(sync, 'navigation_capture', return_value=self.after), \
                patch.object(sync, 'refresh_scrolled_webview', return_value=self.after), \
                patch.object(sync, 'wait_creator_content', return_value=self.after):
            self.read(enabled=False)
        pair.assert_not_called()

    def test_server_error_is_not_accepted_as_stable_content(self):
        with patch.object(sync, 'require_creator_service_available', side_effect=RuntimeError('server error')):
            with self.assertRaisesRegex(RuntimeError, 'server error'):
                sync.stable_pair_signature((self.before, self.before))

    def test_disjoint_stable_page_is_rejected_without_accepting_or_another_swipe(self):
        disjoint = copy.deepcopy(self.after)
        for _, item in sync.note_cards(disjoint):
            next(n for n in disjoint.iter('node') if n.get('text') == item['title']).set('text', 'disjoint ' + item['title'])
        with patch.object(sync, 'capture_element_pair', return_value=(disjoint, copy.deepcopy(disjoint))), \
                patch.object(sync, 'navigation_capture') as stock:
            with self.assertRaisesRegex(sync.ElementListReadError, 'continuity'):
                self.read()
        stock.assert_not_called()

    def test_unavailable_pair_disables_fast_path_but_cleanup_failure_is_fatal(self):
        with patch.object(sync, 'capture_element_pair', side_effect=native.NativePairUnavailable('unsupported')), \
                patch.object(sync, 'navigation_capture', return_value=self.after), \
                patch.object(sync, 'refresh_scrolled_webview', return_value=self.after), \
                patch.object(sync, 'wait_creator_content', return_value=self.after):
            _, fast, enabled = self.read()
        self.assertFalse(fast or enabled)
        with patch.object(sync, 'capture_element_pair', side_effect=RuntimeError('cleanup unproven')), \
                patch.object(sync, 'navigation_capture') as stock:
            with self.assertRaisesRegex(RuntimeError, 'cleanup'):
                self.read()
        stock.assert_not_called()

    def test_foreign_slot_or_changed_foreground_never_reaches_next_action(self):
        for focus in [FOCUS.replace('u0', 'u999'), FOCUS.replace('WebViewActivityV2', 'NoteDetailActivity')]:
            with patch.object(sync, 'focus', side_effect=[FOCUS, focus]), patch.object(sync, 'assert_no_poco'), \
                    patch.object(native, 'read', return_value=(self.before, self.before)):
                with self.assertRaises(RuntimeError):
                    sync.capture_element_pair('adb', 'serial', lambda: None, self.events)

    def test_logout_during_pair_remains_an_account_error(self):
        logout = 'mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.login.device.offline.DeviceOfflineRemindActivity}'
        with patch.object(sync, 'focus', side_effect=[FOCUS, logout]), patch.object(sync, 'assert_no_poco'), \
                patch.object(native, 'read', side_effect=RuntimeError('foreground changed')):
            with self.assertRaisesRegex(RuntimeError, 'logged out; manual login'):
                sync.capture_element_pair('adb', 'serial', lambda: None, self.events)


class PairTransportTests(unittest.TestCase):
    XML = b'<hierarchy data-source="xml" native-window-reader="1"><node package="com.xingin.xhs"/></hierarchy>'

    def runner(self, error=b'', retained=False):
        def run(adb, serial, *args, **kw):
            self.assertEqual((adb, serial), ('adb', 'selected'))
            if args[:2] == ('shell', 'ls'):
                return subprocess.CompletedProcess(args, 0 if retained else 1, b'', b'' if retained else b'No such file')
            if len(args) == 2 and 'NativeWindowPair' in args[1]:
                self.assertEqual(kw['timeout'], 25)
                self.assertIn('/system/bin/timeout 20 ', args[1])
                return subprocess.CompletedProcess(args, int(bool(error)), b'<native-pair>'+self.XML*2+b'</native-pair>', error)
            return subprocess.CompletedProcess(args, 0, b'', b'')
        return Mock(side_effect=run)

    def call(self, run):
        return native.read('adb', 'selected', run, lambda: FOCUS, lambda: None, FOCUS, pair=True)

    def test_two_snapshots_one_launch_and_owned_file_removed(self):
        run = self.runner(); trees = self.call(run)
        self.assertEqual(len(trees), 2)
        self.assertEqual(sum('NativeWindowPair' in str(c.args) for c in run.call_args_list), 1)
        self.assertEqual(run.call_args_list[-2].args[2:5], ('shell', 'rm', '-f'))

    def test_only_clean_rejected_reader_allows_fallback(self):
        for stderr in (b'native_pair_unproven:unsupported', b'Android runtime warning\nnative_pair_unproven:unsupported'):
            with self.subTest(stderr=stderr), self.assertRaises(native.NativePairUnavailable):
                self.call(self.runner(stderr))
        for error, retained in [(b'native_pair_unproven:unsupported\n'+b'x'*400+b'native_disconnect_failed', False),
                                (b'native_pair_unproven:unsupported', True)]:
            with self.subTest(), self.assertRaises(RuntimeError) as caught:
                self.call(self.runner(error, retained))
            self.assertNotIsInstance(caught.exception, native.NativePairUnavailable)

    def test_timeout_or_killed_reader_is_fatal_and_still_cleans_owned_file(self):
        for kind in ('timeout', 'killed'):
            run = self.runner(); original = run.side_effect
            def failing(adb, serial, *args, **kw):
                if len(args) == 2 and 'NativeWindowPair' in args[1]:
                    if kind == 'timeout':
                        raise subprocess.TimeoutExpired('pair', 25)
                    return subprocess.CompletedProcess(args, 137, b'', b'native_pair_unproven:killed')
                return original(adb, serial, *args, **kw)
            run.side_effect = failing
            with self.subTest(kind=kind), self.assertRaises((RuntimeError, subprocess.TimeoutExpired)) as caught:
                self.call(run)
            self.assertNotIsInstance(caught.exception, native.NativePairUnavailable)
            self.assertEqual(run.call_args_list[-2].args[2:5], ('shell', 'rm', '-f'))

    def test_partial_foreign_or_oversized_pair_never_returns_a_snapshot(self):
        for output in (b'<native-pair>'+self.XML+b'</native-pair>',
                       b'<native-pair>'+self.XML+self.XML.replace(b'com.xingin.xhs', b'foreign')+b'</native-pair>',
                       b'x'*8_000_129):
            run = self.runner(); original = run.side_effect
            def output_run(adb, serial, *args, **kw):
                if len(args) == 2 and 'NativeWindowPair' in args[1]:
                    return subprocess.CompletedProcess(args, 0, output, b'')
                return original(adb, serial, *args, **kw)
            run.side_effect = output_run
            with self.subTest(size=len(output)), self.assertRaises(RuntimeError):
                self.call(run)
            self.assertEqual(run.call_args_list[-2].args[2:5], ('shell', 'rm', '-f'))

    def test_cancellation_after_read_propagates_with_cleanup(self):
        run = self.runner()
        with self.assertRaisesRegex(RuntimeError, 'cancelled'):
            native.read('adb', 'selected', run, lambda: FOCUS,
                        Mock(side_effect=[None, None, RuntimeError('cancelled')]), FOCUS, pair=True)
        self.assertEqual(run.call_args_list[-2].args[2:5], ('shell', 'rm', '-f'))

    def test_same_two_snapshots_need_one_push_and_process_instead_of_two(self):
        run = self.runner(); original = run.side_effect
        def both(adb, serial, *args, **kw):
            if len(args) == 2 and 'NativeWindowReader' in args[1]:
                return subprocess.CompletedProcess(args, 0, self.XML, b'')
            return original(adb, serial, *args, **kw)
        run.side_effect = both
        for _ in range(2):
            native.read('adb', 'selected', run, lambda: FOCUS, lambda: None, FOCUS)
        self.assertEqual(run.call_count, 8)
        run.reset_mock(); self.call(run)
        self.assertEqual(run.call_count, 4)


if __name__ == '__main__':
    unittest.main()
