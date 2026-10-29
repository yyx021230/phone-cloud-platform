import subprocess
import unittest
from unittest import mock
import alipay_name_lookup as lookup


class FreshXmlTests(unittest.TestCase):
    def test_failed_repeat_cannot_reuse_previous_restriction_tree(self):
        r = lookup.Runner({'serial': 'SYNTHETIC', 'taskId': 'same-task'})
        files = {}; paths = []; deleted = []
        def adb(args, **kw):
            if args[:3] == ['shell', 'uiautomator', 'dump']:
                paths.append(args[-1])
                if len(paths) == 1:
                    files[args[-1]] = b'<hierarchy><node text="old restriction"/></hierarchy>'
                return 'ERROR: could not get idle state'
            if args[:2] == ['exec-out', 'cat']:
                if args[-1] not in files: raise RuntimeError('cat: No such file or directory')
                return files[args[-1]]
            if args[:3] == ['shell', 'rm', '-f']:
                deleted.append(args[-1])
                # Simulate unsuccessful cleanup: the old file still exists.
            return ''
        r.adb = adb
        self.assertEqual(r.dump('same-token', allow_tty_fallback=False)[0][0].get('text'), 'old restriction')
        with self.assertRaisesRegex(RuntimeError, 'uiautomator_hierarchy_missing'):
            r.dump('same-token', allow_tty_fallback=False)
        self.assertEqual(len(set(paths)), 2)
        self.assertEqual(deleted, paths)

    def test_failed_file_dump_can_use_fresh_tty_observation(self):
        r = lookup.Runner({'serial': 'SYNTHETIC'})
        def adb(args, **kw):
            if args[:2] == ['exec-out', 'cat']: raise RuntimeError('No such file or directory')
            if args == ['exec-out', 'uiautomator', 'dump', '/dev/tty']:
                return b'<hierarchy><node text="current home"/></hierarchy>'
            return ''
        r.adb = mock.Mock(side_effect=adb)
        self.assertEqual(r.dump('repeat')[0][0].get('text'), 'current home')

    def test_cleanup_cannot_replace_original_timeout_or_touch_other_files(self):
        r = lookup.Runner({'serial': 'SYNTHETIC'}); r.emit = mock.Mock()
        def adb(args, **kw):
            if args[:3] == ['shell', 'uiautomator', 'dump']:
                raise subprocess.TimeoutExpired('first dump', 2)
            if args[:3] == ['shell', 'rm', '-f']: raise RuntimeError('device offline')
            return ''
        r.adb = mock.Mock(side_effect=adb)
        with self.assertRaises(subprocess.TimeoutExpired) as e: r.dump('repeat')
        self.assertEqual(e.exception.cmd, 'first dump')
        calls = [c.args[0] for c in r.adb.call_args_list]
        self.assertEqual(calls[-1][-1], calls[-2][-1])
        self.assertNotIn('*', calls[-1][-1])

    def test_device_error_does_not_trigger_tty_fallback(self):
        r = lookup.Runner({'serial': 'SYNTHETIC'})
        def adb(args, **kw):
            if args[:2] == ['exec-out', 'cat']: raise RuntimeError('device offline')
            return ''
        r.adb = mock.Mock(side_effect=adb)
        with self.assertRaisesRegex(RuntimeError, 'device offline'): r.dump('x')
        self.assertFalse(any('/dev/tty' in c.args[0] for c in r.adb.call_args_list))

if __name__ == '__main__': unittest.main()
