"""Observed partial tab tree and bounded loading/retry behavior; no devices."""
import copy
import importlib.util
from contextlib import ExitStack
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

S = Path(__file__).parent
spec = importlib.util.spec_from_file_location('loading_sync', S/'小红书数据同步.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
CURRENT = 'mCurrentFocus=Window{x u999 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}'


def fixture(name):
    return ET.parse(S/'fixtures/xhs'/name).getroot()


class LoadingWaitTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.now = 0.0
        self.events = ['collection_slot_requested:app2', 'clone_user_requested:999', 'creator_more_selected']
        self.stack.enter_context(patch.object(sync.time, 'monotonic', side_effect=lambda: self.now))
        self.stack.enter_context(patch.object(sync.time, 'sleep', side_effect=self.advance))
        self.focus = self.stack.enter_context(patch.object(sync, 'focus', return_value=CURRENT))
        self.stack.enter_context(patch.object(sync, 'wake_if_asleep', return_value=False))
        self.adb = self.stack.enter_context(patch.object(sync, 'adb'))
        self.missing = fixture('data-center-loading-missing-tab-25.xml')
        self.header = fixture('data-center-loading-header-25.xml')
        self.good = fixture('works-elements-141.xml')

    def advance(self, seconds):
        self.now += seconds

    def run_wait(self, root=None, content=False, guard=lambda: None):
        return sync.wait_data_center_loading('adb', 'serial', root if root is not None else self.missing,
                                             guard, self.events, require_content=content)

    def test_observed_missing_tab_waits_twenty_seconds_then_clicks_once(self):
        self.assertFalse(sync.data_center_tab_header(self.missing))
        self.assertTrue(sync.data_center_tab_header(self.header))
        self.adb.side_effect = lambda *a, **kw: self.assertGreaterEqual(self.now, 20)
        def read(*args):
            if self.adb.call_count:
                return self.good
            return self.header if self.now >= 20 else self.missing
        with patch.object(sync, 'navigation_capture', side_effect=read):
            self.assertIs(self.run_wait(), self.good)
        self.assertEqual(self.adb.call_count, 1)
        self.assertEqual(self.adb.call_args.args[2:5], ('shell', 'input', 'tap'))
        self.assertLess(self.now, 45)
        self.assertNotIn('data_center_loading_active', self.events)

    def test_two_reopens_only_after_full_deadlines_then_timeout_not_zero(self):
        center = ET.fromstring('<hierarchy><node text="创作中心" bounds="[0,0][100,100]"/>'
                              '<node text="最新笔记" bounds="[0,100][100,200]"/>'
                              '<node text="更多" bounds="[0,200][100,300]"/></hierarchy>')
        state = {'returning': False}
        back_times = []
        def command(*args, **kwargs):
            self.assertEqual(args[2:], ('shell', 'input', 'keyevent', '4'))
            back_times.append(self.now)
            state['returning'] = True
        self.adb.side_effect = command
        def capture(*args):
            if state['returning']:
                state['returning'] = False
                return center
            return self.missing
        with patch.object(sync, 'navigation_capture', side_effect=capture), patch.object(sync, 'tap_label') as tap:
            with self.assertRaisesRegex(sync.ElementListReadError, 'loading timed out'):
                self.run_wait()
        self.assertEqual(back_times, [45, 90])
        self.assertEqual(self.now, 135)
        self.assertEqual(tap.call_count, 2)
        self.assertEqual(sync.data_center_reopen_count(self.events), 2)
        self.assertNotIn('data_center_loading_active', self.events)

    def test_ready_content_returns_after_two_reads_not_after_fixed_delay(self):
        with patch.object(sync, 'navigation_capture', return_value=copy.deepcopy(self.good)) as capture:
            self.run_wait(self.good, content=True)
        self.assertEqual(capture.call_count, 1)
        self.assertEqual(self.now, 2)
        self.adb.assert_not_called()

    def test_changed_counts_reset_the_pair(self):
        changed = copy.deepcopy(self.good)
        next(n for n in changed.iter('node') if n.get('text') == '252').set('text', '253')
        with patch.object(sync, 'navigation_capture', side_effect=[changed, copy.deepcopy(changed)]) as capture:
            result = self.run_wait(self.good, content=True)
        self.assertEqual(capture.call_count, 2)
        self.assertEqual(sync.element_page_signature(result), sync.element_page_signature(changed))

    def test_mid_scan_waits_but_never_reopens_or_selects_tabs(self):
        self.events.append('collection_scan_as_of:2026-10-22')
        with patch.object(sync, 'navigation_capture', return_value=self.header), patch.object(sync, 'open_works_tab') as tab:
            with self.assertRaisesRegex(sync.ElementListReadError, 'loading timed out'):
                self.run_wait(self.header, content=True)
        self.assertEqual(self.now, 45)
        tab.assert_not_called()
        self.adb.assert_not_called()

    def test_tab_action_is_not_replayed_when_result_stays_loading(self):
        self.events += ['data_center_loading_reopen:1', 'data_center_loading_reopen:2']
        with patch.object(sync, 'navigation_capture', return_value=self.header):
            with self.assertRaisesRegex(sync.ElementListReadError, 'loading timed out'):
                self.run_wait(self.header)
        self.assertEqual(self.adb.call_count, 1)
        self.assertEqual(self.adb.call_args.args[2:5], ('shell', 'input', 'tap'))

    def test_prior_native_entry_recovery_consumes_shared_retry_budget(self):
        self.events += ['works_native_more_recovery_attempted', 'data_center_loading_reopen:2']
        with patch.object(sync, 'navigation_capture', return_value=self.missing):
            with self.assertRaisesRegex(sync.ElementListReadError, 'loading timed out'):
                self.run_wait()
        self.adb.assert_not_called()
        self.assertEqual(self.now, 45)

    def test_occupancy_or_cancellation_stops_before_another_read(self):
        for reason in ('occupied', 'cancelled'):
            with self.subTest(reason=reason), patch.object(sync, 'navigation_capture') as capture:
                with self.assertRaisesRegex(RuntimeError, reason):
                    self.run_wait(guard=Mock(side_effect=RuntimeError(reason)))
                capture.assert_not_called()
        self.adb.assert_not_called()

    def test_foreign_user_or_activity_stops_without_retry(self):
        for current in (CURRENT.replace('u999', 'u0'), CURRENT.replace('com.xingin.xywebview.activity.WebViewActivityV2', 'com.xingin.xhs.note.NoteDetailActivity')):
            self.focus.return_value = current
            with self.subTest(current=current), patch.object(sync, 'navigation_capture') as capture:
                with self.assertRaises(RuntimeError):
                    self.run_wait()
                capture.assert_not_called()
        self.adb.assert_not_called()

    def test_login_and_account_abnormal_are_not_loading(self):
        self.focus.return_value = CURRENT.replace('com.xingin.xywebview.activity.WebViewActivityV2', 'com.xingin.login.device.offline.DeviceOfflineRemindActivity')
        with self.assertRaisesRegex(RuntimeError, 'logged out'):
            self.run_wait()
        self.focus.return_value = CURRENT
        root = copy.deepcopy(self.missing)
        ET.SubElement(root, 'node', {'text':'账号异常', 'bounds':'[0,0][100,100]'})
        with self.assertRaisesRegex(RuntimeError, 'abnormal'):
            self.run_wait(root)
        self.adb.assert_not_called()

    def test_reader_failure_is_not_swallowed_as_loading(self):
        with patch.object(sync, 'navigation_capture', side_effect=RuntimeError('native cleanup unproven')):
            with self.assertRaisesRegex(RuntimeError, 'cleanup unproven'):
                self.run_wait()
        self.adb.assert_not_called()

    def test_wrong_return_page_does_not_get_an_entry_click(self):
        with patch.object(sync, 'navigation_capture', return_value=ET.Element('hierarchy')), patch.object(sync, 'tap_label') as tap:
            with self.assertRaisesRegex(sync.ElementListReadError, 'proven Creator Center'):
                sync.reopen_loading_data_center('adb', 'serial', self.missing, lambda:None, self.events)
        self.assertEqual(self.adb.call_count, 1)
        tap.assert_not_called()

    def test_foreground_change_between_tab_proof_and_action_is_rejected(self):
        self.focus.side_effect = [CURRENT, CURRENT, CURRENT.replace('u999', 'u0')]
        with self.assertRaisesRegex(sync.ElementListReadError, 'foreground changed'):
            self.run_wait(self.header)
        self.adb.assert_not_called()

    def test_slow_read_counts_toward_deadline_and_no_next_read_starts(self):
        self.events += ['data_center_loading_reopen:1','data_center_loading_reopen:2']
        def slow(*args):
            self.advance(44)
            return self.missing
        with patch.object(sync, 'navigation_capture', side_effect=slow) as capture:
            with self.assertRaisesRegex(sync.ElementListReadError, 'loading timed out'):
                self.run_wait()
        self.assertEqual(capture.call_count, 1)
        self.adb.assert_not_called()

if __name__ == '__main__':
    unittest.main()
