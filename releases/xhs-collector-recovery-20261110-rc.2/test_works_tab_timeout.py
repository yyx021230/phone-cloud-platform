import importlib.util
from pathlib import Path
import subprocess
import time
import unittest
from unittest.mock import Mock, call, patch
from xml.etree import ElementTree as ET

RELEASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('candidate', (Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
FOCUS = ('mCurrentFocus=Window{test u0 '
         'com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}')
TAP = call('adb', 'serial', 'shell', 'input', 'tap', '270', '211', timeout=7)


def overview():
    root = ET.Element('hierarchy', {'data-source': 'xml', 'native-window-reader': '1'})
    def node(parent, text, kind, box, **attributes):
        return ET.SubElement(parent, 'node', dict(package=sync.XHS_PACKAGE, text=text,
                             bounds=box, enabled='true', **{'class': kind}, **attributes))

    view = node(root, '数据中心', 'android.webkit.WebView', '[0,0][720,1504]')
    header = node(view, '', 'android.view.View', '[0,168][720,254]')
    for i, title in enumerate(('账号概览', '作品分析', '粉丝数据', '收入数据')):
        node(header, title, 'android.view.View', f'[{i*180},168][{(i+1)*180},254]',
             clickable='true', **{'visible-to-user': 'true'})
    node(view, '账号诊断', 'android.view.View', '[60,308][186,348]')
    node(view, '观看数据', 'android.view.View', '[56,1192][170,1230]')
    return root


def works_list():
    path = RELEASE.parents[1] / 'windows-agent/scripts/fixtures/xhs/works-elements-141.xml'
    return ET.parse(path).getroot()


def timed_out():
    return subprocess.TimeoutExpired(['adb', 'shell', 'input', 'tap'], 7)


class WorksTabTimeoutTests(unittest.TestCase):
    def setUp(self):
        self.root = overview()
        self.events = ['collection_slot_requested:app1']
        self.guard = Mock()
        self.focus = self.start_patch('focus', return_value=FOCUS)
        self.tap = self.start_patch('adb', side_effect=[timed_out(), ''])
        self.native = self.start_patch('native_window_capture', side_effect=[overview(), overview()])
        self.start_patch('wake_if_asleep', return_value=False)
        self.start_patch('resume_vivo_update_entry', return_value=None)
        self.start_patch('navigation_capture', return_value=works_list())
        sleep = patch.object(sync.time, 'sleep')
        sleep.start()
        self.addCleanup(sleep.stop)

    def start_patch(self, name, **kwargs):
        patcher = patch.object(sync, name, **kwargs)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def open(self, deadline=None):
        return sync.open_works_tab('adb', 'serial', self.root, self.guard, self.events,
                                   expected_foreground=FOCUS,
                                   deadline=deadline if deadline is not None else time.monotonic()+45)

    def test_loader_proves_still_on_overview_then_retries_once(self):
        result = sync.wait_data_center_loading('adb', 'serial', self.root, self.guard, self.events)
        self.assertTrue(sync.creator_list(result))
        self.assertEqual(self.tap.call_args_list, [TAP, TAP])
        self.assertEqual(self.native.call_count, 2)
        self.assertIn('data_center_works_tab_retry_after_timeout', self.events)

    def test_late_success_uses_readback_without_another_tap(self):
        self.native.side_effect = [overview(), works_list()]
        self.assertTrue(self.open())
        self.assertEqual(self.tap.call_args_list, [TAP])
        self.assertIn('data_center_works_tab_ready_after_timeout', self.events)

    def test_ambiguous_second_read_never_retries(self):
        for case in ('moved', 'duplicate', 'permission', 'missing-overview', 'loading', 'foreign'):
            with self.subTest(case=case):
                root = overview()
                tab, = sync.label(root, '作品分析')
                if case == 'moved':
                    tab.set('bounds', '[182,168][362,254]')
                elif case == 'duplicate':
                    root[0][0].append(ET.fromstring(ET.tostring(tab)))
                elif case == 'permission':
                    ET.SubElement(root[0], 'node', dict(text='开通数据权限', bounds='[0,300][400,500]'))
                elif case == 'missing-overview':
                    root[0].remove(sync.label(root, '账号诊断')[0])
                elif case == 'loading':
                    ET.SubElement(root[0], 'node', {'class': 'android.widget.ProgressBar',
                                  'package': sync.XHS_PACKAGE, 'bounds': '[0,300][400,500]'})
                else:
                    tab.set('package', 'another.app')
                self.events[:] = ['collection_slot_requested:app1']
                self.tap.reset_mock(side_effect=True)
                self.tap.side_effect = [timed_out()]
                self.native.side_effect = [overview(), root]
                with self.assertRaises(subprocess.TimeoutExpired):
                    self.open()
                self.assertEqual(self.tap.call_args_list, [TAP])

    def test_changed_window_before_retry_prevents_tap(self):
        self.focus.side_effect = [FOCUS]*7 + [FOCUS.replace('{test ', '{other ')]
        with self.assertRaises(subprocess.TimeoutExpired):
            self.open()
        self.assertEqual(self.native.call_count, 2)
        self.assertEqual(self.tap.call_args_list, [TAP])

    def test_occupied_before_retry_prevents_tap(self):
        self.guard.side_effect = [None, None, None, RuntimeError('occupied')]
        with self.assertRaisesRegex(RuntimeError, 'occupied'):
            self.open()
        self.assertEqual(self.tap.call_args_list, [TAP])

    def test_expired_budget_prevents_new_read_and_tap(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.open(time.monotonic()-1)
        self.native.assert_not_called()
        self.assertEqual(self.tap.call_args_list, [TAP])

    def test_second_timeout_cannot_reenter_recovery(self):
        self.tap.side_effect = [timed_out(), timed_out(), timed_out()]
        with self.assertRaises(subprocess.TimeoutExpired):
            self.open()
        with self.assertRaises(subprocess.TimeoutExpired):
            self.open()
        self.assertEqual(self.tap.call_args_list, [TAP, TAP, TAP])
        self.assertEqual(self.native.call_count, 2)


if __name__ == '__main__':
    unittest.main()
