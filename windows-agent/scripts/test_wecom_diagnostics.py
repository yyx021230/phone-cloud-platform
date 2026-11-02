import io
import json
import socket
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import wecom_platform_preview as host
from wecom_diagnostics import ExecutionTrace, PREFIX
import test_wecom_platform_preview as host_tests


class NativeDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.trace_patch = patch.object(host, 'trace', ExecutionTrace(clock=lambda: time.monotonic()), create=True)
        self.trace_patch.start()
        self.addCleanup(self.trace_patch.stop)
        host.CANCELLED.clear()
        host.cleaning_up = False
        host.deadline = time.monotonic()+30

    def test_trickling_adb_response_cannot_outlive_foreground_budget(self):
        # A real socket sends data frequently enough never to hit the old 6s
        # inactivity timeout. The phase must stop it without a click/retry.
        left, right = socket.socketpair(); stop = threading.Event()
        def writer():
            try:
                while not stop.wait(.01): right.sendall(b'x')
            except OSError: pass
        worker = threading.Thread(target=writer); worker.start()
        started = time.monotonic()
        try:
            with self.assertRaisesRegex(host.SafeStop, 'wecom_launch_not_ready'):
                with host.trace.phase('foreground_wait', .09, 'wecom_launch_not_ready'):
                    host.exact(left, 1000)
            self.assertLess(time.monotonic()-started, 1)
            self.assertEqual(host.trace.summary()['failurePhase'], 'foreground_wait')
        finally:
            stop.set(); left.close(); right.close(); worker.join(timeout=1)

    def test_slow_selector_observation_gets_remaining_stage_timeout(self):
        clock = [0]; timeouts = []
        class Response:
            def settimeout(self, timeout): timeouts.append(timeout)
            def recv(self, n): clock[0] += .4; return b'X'
        with patch.object(host.time, 'monotonic', side_effect=lambda: clock[0]):
            host.trace = ExecutionTrace(clock=lambda: clock[0]); host.deadline = 210
            with self.assertRaisesRegex(host.SafeStop, 'wecom_launch_not_ready'):
                with host.trace.phase('foreground_wait', 1, 'wecom_launch_not_ready'):
                    host.exact(Response(), 20)
        self.assertEqual(len(timeouts), 3)
        self.assertAlmostEqual(timeouts[-1], .2)
        self.assertEqual(host.trace.summary()['failurePhase'], 'foreground_wait')

    def test_cleanup_gets_its_own_budget_after_foreground_timeout(self):
        clock = [0]
        with patch.object(host.time, 'monotonic', side_effect=lambda: clock[0]):
            host.trace = ExecutionTrace(clock=lambda: clock[0]); host.deadline = 210
            with self.assertRaises(host.SafeStop):
                with host.trace.phase('foreground_wait', 1, 'wecom_launch_not_ready'):
                    clock[0] = 2; host.budget()
            host.cleaning_up = True; host.deadline = 14
            self.assertEqual(host.io_timeout(6), 6)
            host.trace.cleanup(False)
        self.assertEqual(host.trace.summary()['cleanupConfirmed'], False)
        self.assertEqual(host.trace.summary()['failurePhase'], 'foreground_wait')

    def test_sleeping_25_is_woken_before_poco_not_after_failed_health(self):
        value = host_tests.HostGuardTests().config('25'); calls = []; state = {'awake': False, 'pid': False}
        stat = '123 (poco) '+' '.join(['S']+['0']*18+['789'])
        def shell(cmd, keep=False):
            calls.append(cmd)
            if cmd.startswith('pm '): return 'package:fixture'
            if cmd == 'dumpsys power': return 'mWakefulness='+('Awake' if state['awake'] else 'Asleep')
            if cmd == 'input keyevent 224': state['awake'] = True
            if cmd == 'dumpsys window policy':
                return 'KeyguardServiceDelegate\n secure=false\n mIsShowing=false\n mCurrentUserId=0\n'
            if cmd == 'pidof com.netease.open.pocoservice': return '123' if state['pid'] else ''
            if cmd == 'am force-stop com.netease.open.pocoservice': state['pid'] = False
            if cmd.startswith('am start -n com.netease'): state['pid'] = True
            if cmd.startswith('cat /proc/'): return stat
            if cmd.startswith('cmd package resolve-activity'): raise host.SafeStop('fixture_passed_health')
            if keep: return SimpleNamespace(close=lambda: None)
            return ''
        with patch.object(host, 'adb_identity', return_value=1), patch.object(host, 'lease_valid', return_value=True), patch.object(host, 'shell', side_effect=host_tests.checked_pid_shell(shell)), patch.object(host, 'host', side_effect=lambda cmd: '' if cmd == 'host:list-forward' else '12345' if cmd.endswith('10080') else '12346'), patch.object(host, 'health', side_effect=lambda port: state['awake']), patch.object(host, 'connection', return_value=SimpleNamespace(close=lambda: None)), patch.object(host, 'command'):
            with self.assertRaisesRegex(host.SafeStop, 'fixture_passed_health'): host.run_host(value)
        self.assertLess(calls.index('input keyevent 224'), calls.index('am start -n com.netease.open.pocoservice/.TestActivity'))
        self.assertEqual(calls.count('input keyevent 224'), 1)
        self.assertEqual(host.trace.summary()['failurePhase'], 'wecom_launch')
        self.assertTrue(host.trace.summary()['cleanupConfirmed'])

    def test_unknown_or_awake_power_never_triggers_early_wake(self):
        for raw in ['', 'mWakefulness=Awake', 'untrusted Asleep']:
            with patch.object(host, 'shell', return_value=raw), patch.object(host, 'mutate', side_effect=AssertionError('no early write')):
                self.assertFalse(host.prepare_screen_before_poco())

    def test_sleeping_secure_25_stops_before_poco_without_menu_or_pin(self):
        calls = []
        def shell(cmd):
            calls.append(cmd)
            if cmd == 'dumpsys power': return 'mWakefulness=Asleep'
            return 'KeyguardServiceDelegate\n secure=true\n mIsShowing=true\n mCurrentUserId=0\n'
        with patch.object(host, 'config', {'deviceNumber': '25'}, create=True), patch.object(host, 'selected_user', 0, create=True), patch.object(host, 'shell', side_effect=host_tests.checked_pid_shell(shell)), patch.object(host, 'lease_valid', return_value=True):
            with self.assertRaisesRegex(host.w.StopPreview, 'device_unlock_requires_user'): host.prepare_screen_before_poco()
        self.assertNotIn('input keyevent 82', calls)
        self.assertFalse(any('am start' in cmd for cmd in calls))

    def test_lost_lease_during_sleep_prepare_never_sends_wake(self):
        with patch.object(host, 'shell', return_value='mWakefulness=Asleep') as shell, patch.object(host, 'lease_valid', return_value=False):
            with self.assertRaisesRegex(host.SafeStop, 'device_lease_lost'): host.prepare_screen_before_poco()
        self.assertEqual([c.args[0] for c in shell.call_args_list], ['dumpsys power'])

    def test_expired_budget_is_not_swallowed_as_retryable_navigation_error(self):
        from test_wecom_invite_preview import PROFILE, PHONE, Poco
        driver = host.PreviewRemarkEntryDriver(Poco(PROFILE), lambda: host.w.PACKAGE, lambda: True)
        with patch.object(host.remarks.PocoRemarkDriver, 'apply', side_effect=host.SafeStop('preview_job_budget_exhausted')) as apply:
            with self.assertRaisesRegex(host.w.StopPreview, 'preview_job_budget_exhausted'): driver.apply('open_remark', PROFILE, PHONE)
        self.assertEqual(apply.call_count, 1)

    def test_observed_43_main_and_clone_labels_select_only_bound_slot(self):
        def node(text): return SimpleNamespace(text=text)
        for user, expected in [(0, '企业微信'), (999, 'Ⅱ·企业微信')]:
            selected = []
            def click(poco, package, context, selector):
                self.assertEqual(package, 'com.android.intentresolver')
                self.assertTrue(context(SimpleNamespace(nodes=[node('选择要使用的应用：')])) )
                self.assertFalse(context(SimpleNamespace(nodes=[node('其他未知页面')])) )
                selected.extend(n.text for n in [node('企业微信'), node('Ⅱ·企业微信'), node('始终')] if selector(n))
            with patch.object(host, 'selected_user', user, create=True), patch.object(host, 'foreground_info', return_value=('com.android.intentresolver', 0, 'com.android.intentresolver/.DoubleAppResolverActivity')), patch.object(host, 'startup_click', side_effect=click):
                self.assertTrue(host.resolve_observed_wecom_slot(None))
            self.assertEqual(selected, [expected])

    def test_owned_shell_socket_is_closed_if_transport_handshake_times_out(self):
        sock = SimpleNamespace(close=lambda: None)
        with patch.object(host, 'connection', return_value=sock), patch.object(host, 'SERIAL', 'synthetic', create=True), patch.object(host, 'command', side_effect=host.SafeStop('adb_io_timeout')), patch.object(sock, 'close') as close:
            with self.assertRaisesRegex(host.SafeStop, 'adb_io_timeout'): host.shell('dumpsys power', keep=True)
            close.assert_called_once()

    def test_stage_error_frames_have_no_exception_or_request_text(self):
        stream = io.StringIO(); host.trace = ExecutionTrace(stream)
        with patch.object(host, 'foreground', side_effect=RuntimeError('private target/token')):
            with self.assertRaises(RuntimeError): host.wait_for_wecom_foreground(None, 18)
        self.assertEqual(host.trace.summary()['failurePhase'], 'foreground_wait')
        self.assertNotIn('private', stream.getvalue())

    def test_trace_is_bounded_fixed_vocabulary_and_retains_failure_after_cleanup(self):
        clock = [0]; stream = io.StringIO(); trace = ExecutionTrace(stream, clock=lambda: clock[0])
        with self.assertRaises(RuntimeError):
            with trace.phase('foreground_wait'):
                with trace.phase('selector_click'):
                    raise RuntimeError('private phone token UI')
        for _ in range(30): trace.emit('cleanup', 'begin')
        trace.cleanup(False)
        summary = trace.summary()
        self.assertEqual(summary['failurePhase'], 'selector_click')
        self.assertEqual(len(summary['events']), 24)
        self.assertNotIn('private', stream.getvalue())
        for line in stream.getvalue().splitlines():
            self.assertTrue(line.startswith(PREFIX)); json.loads(line[len(PREFIX):])
        with self.assertRaises(ValueError): trace.emit('private unknown phase', 'begin')

if __name__ == '__main__': unittest.main()
