"""Synthetic focus transitions only; no phone, ADB, or model calls."""
import subprocess
import unittest
from unittest import mock
import alipay_name_lookup as lookup
import test_lookup_cold_restriction as fixtures
from test_lookup_overlay_guard import HOME, SEARCH, clock

NULL = 'mCurrentFocus=null'
FOREIGN = 'mCurrentFocus=Window{x u0 other.app/.Page}'


class NavigationFocusTransition(unittest.TestCase):
    def runner(self, frames):
        r = lookup.Runner({'serial': 'SYNTHETIC', 'taskId': 'focus-transition'})
        queue = list(frames)
        def focus(**kwargs):
            frame = queue.pop(0) if len(queue) > 1 else queue[0]
            return list(frame)
        r.focus = mock.Mock(side_effect=focus)
        r.adb = mock.Mock(side_effect=AssertionError('no phone action'))
        r.emit = mock.Mock()
        return r

    def test_transient_empty_focus_observes_home_without_action(self):
        for app in ['', 'mFocusedApp=null', 'mFocusedApp=ActivityRecord{x u0 '+lookup.ALIPAY_PACKAGE+'/.AlipayLogin}']:
            r = self.runner([(HOME, '')])
            with clock(): self.assertEqual(r.settle_cold_account_navigation_focus(NULL, app)[0], HOME)
            r.focus.assert_called_once_with(timeout=.5, recover=False)
            r.adb.assert_not_called()
            self.assertEqual(r.emit.call_args.kwargs['outcome'], 'home')

    def test_concrete_foreign_overlay_home_and_foreign_focused_app_never_wait(self):
        for current, app in [(FOREIGN, lookup.ALIPAY_PACKAGE), (HOME, ''),
                             ('mCurrentFocus=Window{x u0 com.android.systemui/.Dialog}', lookup.ALIPAY_PACKAGE),
                             ('mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/.Dialog}', lookup.ALIPAY_PACKAGE),
                             (NULL, 'mFocusedApp=ActivityRecord{x u0 other.app/.Page}')]:
            r = self.runner([(HOME, '')])
            with clock(): self.assertEqual(r.settle_cold_account_navigation_focus(current, app), (current, app))
            r.focus.assert_not_called(); r.adb.assert_not_called()

    def test_null_then_foreign_stops_without_waiting_for_later_home(self):
        r = self.runner([(FOREIGN, ''), (HOME, '')])
        with clock(): self.assertEqual(r.settle_cold_account_navigation_focus(NULL, '')[0], FOREIGN)
        self.assertEqual(r.focus.call_count, 1); r.adb.assert_not_called()

    def test_persistent_missing_focus_has_time_and_sample_bounds(self):
        r = self.runner([(NULL, 'mFocusedApp=null')])
        with clock() as now:
            self.assertEqual(r.settle_cold_account_navigation_focus(NULL, '')[0], NULL)
            self.assertLessEqual(now[0] - 100, 2.)
        self.assertEqual(r.focus.call_count, 8); r.adb.assert_not_called()
        self.assertEqual(r.emit.call_args.kwargs['outcome'], 'unresolved')

    def test_slow_reads_consume_monotonic_budget(self):
        r = self.runner([(NULL, 'mFocusedApp=null')])
        with clock() as now:
            def slow(**kwargs):
                now[0] += kwargs['timeout']
                return [NULL, 'mFocusedApp=null']
            r.focus.side_effect = slow
            self.assertEqual(r.settle_cold_account_navigation_focus(NULL, '')[0], NULL)
            self.assertLessEqual(now[0] - 100, 2.)
        self.assertLessEqual(r.focus.call_count, 4)
        self.assertTrue(all(c.kwargs['recover'] is False and 0 < c.kwargs['timeout'] <= .5 for c in r.focus.call_args_list))

    def test_real_focus_timeout_has_no_long_recovery_or_action(self):
        r = self.runner([(HOME, '')])
        r.focus = lookup.Runner.focus.__get__(r)
        r.adb.side_effect = subprocess.TimeoutExpired(['adb', 'shell', 'dumpsys', 'window'], .5)
        with clock(), self.assertRaisesRegex(RuntimeError, 'poco_android_window_service_timeout'):
            r.settle_cold_account_navigation_focus(NULL, '')
        r.adb.assert_called_once_with(['shell', 'dumpsys', 'window'], timeout=.5, check=False)
        self.assertEqual(r.emit.call_args.kwargs['outcome'], 'read_failed')

    def test_full_cold_preparation_keeps_back_identity_and_captcha_guards(self):
        for mode in ['normal', 'captcha', 'invalid-home-tree', 'ambiguous-marker', 'never-home']:
            r = fixtures.ColdRestrictionTests().runner()
            navigation = self.runner([(HOME, '')])
            navigation.focus_state = mock.Mock(side_effect=[([], SEARCH, ''), ([], NULL, 'mFocusedApp=null')])
            navigation.adb.side_effect = None; navigation.adb.return_value = ''
            r.exit_search_activity_for_account_navigation = navigation.exit_search_activity_for_account_navigation
            r.focus = mock.Mock(return_value=[NULL, 'mFocusedApp=null'] if mode == 'never-home' else [HOME])
            if mode == 'captcha': r.verification_evidence = mock.Mock(side_effect=[None, {'manual': True}])
            if mode == 'invalid-home-tree': r.canvas_real_name_home_evidence.return_value = False
            if mode == 'ambiguous-marker': r.open_account_picker.return_value = []
            expected = {'normal': 'restriction_before_search', 'captcha': 'human_verification_required',
                        'invalid-home-tree': 'identity_unverified', 'ambiguous-marker': 'alipay_saved_account_',
                        'never-home': 'identity_unverified'}[mode]
            with clock(), self.assertRaisesRegex(RuntimeError, expected): r.prepare_available_account()
            navigation.adb.assert_called_once_with(['shell', 'input', 'keyevent', '4'], timeout=5, check=False)
            r.switch_account.assert_not_called(); r.open_search.assert_not_called(); r.launch.assert_not_called()
            if mode != 'normal': self.assertFalse(r.account_identity_verified)


if __name__ == '__main__': unittest.main()
