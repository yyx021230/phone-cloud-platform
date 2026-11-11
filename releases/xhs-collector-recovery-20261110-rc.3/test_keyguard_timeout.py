import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch

RELEASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('candidate', (Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

LOCKED = 'mKeyguardOccluded=false\nKeyguardServiceDelegate\n showing=true\n secure=false\nKeyguardStateMonitor\n'
UNLOCKED = '''Display: mDisplayId=0 (built-in)
 mAwake=true mScreenOnEarly=true mScreenOnFully=true
KeyguardServiceDelegate
 showing=false
 secure=false
 occluded=false
 inputRestricted=false
KeyguardStateMonitor
mCurrentFocus=Window{next u0 com.xingin.xhs/.index.v2.IndexActivityV2}
'''
LOCK_FOCUS = 'mCurrentFocus=Window{old u0 NotificationShade}'


class KeyguardTimeoutTests(unittest.TestCase):
    def run_swipe(self, readback, expected_exception=None, guard=None):
        events = ['collection_slot_requested:app1']
        timeout = subprocess.TimeoutExpired('adb input swipe', 7)
        def command(_adb, _serial, *args, **kwargs):
            if args == ('shell', 'dumpsys', 'window', 'policy'):
                return LOCKED
            if args == ('shell', 'wm', 'size'):
                return 'Physical size: 720x1600'
            if args[:3] == ('shell', 'input', 'swipe'):
                raise timeout
            if args == ('shell', 'dumpsys', 'window'):
                return readback
            return ''
        with patch.object(sync, 'adb', side_effect=command) as adb, \
             patch.object(sync, 'focus', return_value=LOCK_FOCUS), patch.object(sync.time, 'sleep'):
            if expected_exception is None:
                self.assertTrue(sync.dismiss_unsecured_keyguard('adb', 'serial', guard or Mock(), events))
            else:
                with self.assertRaises(expected_exception):
                    sync.dismiss_unsecured_keyguard('adb', 'serial', guard or Mock(), events)
            calls = [c.args[2:] for c in adb.call_args_list]
        self.assertEqual(sum(c[:3] == ('shell', 'input', 'swipe') for c in calls), 1)
        return events, calls

    def test_unlocked_lit_default_display_and_requested_slot_continue(self):
        events, calls = self.run_swipe(UNLOCKED)
        self.assertIn('unsecured_keyguard_swipe_completed_after_timeout', events)
        self.assertIn('unsecured_keyguard_dismissed', events)
        self.assertEqual(calls[-1], ('shell', 'dumpsys', 'window'))

    def test_incomplete_or_unsafe_readback_never_touches_again(self):
        for old, new in (
            ('showing=false', 'showing=true'),
            ('secure=false', 'secure=true'),
            ('occluded=false', 'occluded=true'),
            ('inputRestricted=false', 'inputRestricted=true'),
            ('mScreenOnFully=true', 'mScreenOnFully=false'),
            ('mDisplayId=0', 'mDisplayId=90000'),
            ('secure=false', 'secure=false\n secure=true'),
        ):
            with self.subTest(new=new):
                events, _ = self.run_swipe(UNLOCKED.replace(old, new), subprocess.TimeoutExpired)
                self.assertNotIn('unsecured_keyguard_dismissed', events)

    def test_wrong_user_and_occupied_device_fail_closed(self):
        self.run_swipe(UNLOCKED.replace(' u0 ', ' u999 '), RuntimeError)
        events, calls = self.run_swipe(UNLOCKED, RuntimeError,
                                       guard=Mock(side_effect=[None, None, RuntimeError('occupied')]))
        self.assertNotIn('unsecured_keyguard_dismissed', events)
        self.assertNotIn(('shell', 'dumpsys', 'window'), calls)


if __name__ == '__main__':
    unittest.main()
