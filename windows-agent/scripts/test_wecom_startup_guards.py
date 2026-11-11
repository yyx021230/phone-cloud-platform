"""Observed 25 MIUI conditions; no device, subprocess, or network calls."""
from dataclasses import replace
import unittest
import wecom_invite_preview as w
import wecom_startup_guards as g
from test_wecom_invite_preview import HOME


def policy(showing=True, secure=False, user=0):
    return ('KeyguardServiceDelegate\n  secure=' + str(secure).lower() +
            '\n KeyguardStateMonitor\n  mIsShowing=' + str(showing).lower() +
            '\n  mCurrentUserId=' + str(user) + '\nLooper state:\n')


OVERLAY = w.Screen(w.PACKAGE, (
    w.Node('android.widget.TextView', text='请勿遮挡听筒区域', name=g.SUMMARY),
    w.Node('android.widget.TextView', text='或按下 “音量+”', name=g.HINT),
    w.Node('android.widget.ImageView', name=g.ANIMATION)))


class StartupGuardTests(unittest.TestCase):
    def test_policy_requires_exact_unambiguous_nonsecure_current_user(self):
        self.assertEqual(g.keyguard_state(policy(), 0), 'nonsecure_showing')
        self.assertEqual(g.keyguard_state(policy(False), 0), 'nonsecure_clear')
        self.assertEqual(g.keyguard_state(policy(secure=True), 0), 'secure')
        for raw in ('', policy(user=999), policy().replace('Looper state:', '  secure=false\nLooper state:'),
                    policy().replace('mCurrentUserId=0', 'mCurrentUserId=-10000')):
            self.assertEqual(g.keyguard_state(raw, 0), 'unknown')

    def test_one_menu_only_and_already_unlocked_does_not_touch_phone(self):
        states = iter([policy(), policy(), policy(False)]); keys = []
        self.assertTrue(g.dismiss_nonsecure_keyguard(lambda: next(states), lambda: True,
                                                    lambda: keys.append('MENU'), sleep=lambda _: None))
        self.assertEqual(keys, ['MENU'])
        self.assertFalse(g.dismiss_nonsecure_keyguard(lambda: policy(False), lambda: True,
                                                     lambda: keys.append('MENU')))
        self.assertEqual(keys, ['MENU'])

    def test_secure_unknown_changed_or_lost_lease_cannot_send_menu(self):
        for states, lease in (([policy(secure=True)], True), ([''], True),
                              ([policy(), policy(secure=True)], True),
                              ([policy(), policy()], False)):
            reads = iter(states); keys = []
            with self.assertRaises(w.StopPreview):
                g.dismiss_nonsecure_keyguard(lambda: next(reads), lambda: lease, lambda: keys.append('MENU'))
            self.assertFalse(keys)

    def test_menu_timeout_is_not_replayed(self):
        keys = []
        def unknown():
            keys.append('MENU'); raise TimeoutError('uncertain key delivery')
        with self.assertRaises(TimeoutError):
            g.dismiss_nonsecure_keyguard(policy, lambda: True, unknown)
        self.assertEqual(keys, ['MENU'])

    def test_exact_overlay_hint_followed_once_then_regular_home_observed(self):
        reads = iter([OVERLAY, OVERLAY, HOME]); keys = []
        self.assertTrue(g.dismiss_miui_proximity(lambda: next(reads), lambda: w.PACKAGE,
                                               lambda: True, lambda: policy(False),
                                               lambda: keys.append('VOLUME_UP'), sleep=lambda _: None))
        self.assertEqual(keys, ['VOLUME_UP'])

    def test_wrong_missing_duplicate_disabled_or_password_context_never_acts(self):
        for page in (HOME, replace(OVERLAY, package='other'),
                     replace(OVERLAY, nodes=OVERLAY.nodes[:2]),
                     replace(OVERLAY, nodes=OVERLAY.nodes + (OVERLAY.nodes[0],)),
                     replace(OVERLAY, nodes=(replace(OVERLAY.nodes[0], enabled=False),) + OVERLAY.nodes[1:]),
                     replace(OVERLAY, nodes=(replace(OVERLAY.nodes[0], text='安全验证'),) + OVERLAY.nodes[1:])):
            keys = []
            self.assertFalse(g.dismiss_miui_proximity(lambda: page, lambda: w.PACKAGE, lambda: True,
                                                     lambda: policy(False), lambda: keys.append('UP')))
            self.assertFalse(keys)
        for lease, package, current_policy in ((False, w.PACKAGE, policy(False)),
                                               (True, 'other', policy(False)),
                                               (True, w.PACKAGE, policy(False, True))):
            keys = []
            with self.assertRaises(w.StopPreview):
                g.dismiss_miui_proximity(lambda: OVERLAY, lambda: package, lambda: lease,
                                        lambda: current_policy, lambda: keys.append('UP'))
            self.assertFalse(keys)

    def test_changed_page_budget_and_uncertain_volume_never_replay(self):
        for mode in ('changed', 'budget', 'transport'):
            reads = iter([OVERLAY, HOME if mode == 'changed' else OVERLAY]); keys = []
            def press():
                keys.append('UP'); raise TimeoutError('uncertain key delivery')
            def budget():
                if mode == 'budget':
                    raise w.StopPreview('timeout')
            with self.assertRaises((w.StopPreview, TimeoutError)):
                g.dismiss_miui_proximity(lambda: next(reads), lambda: w.PACKAGE, lambda: True,
                                        lambda: policy(False), press, check_budget=budget)
            self.assertEqual(keys, ['UP'] if mode == 'transport' else [])


class InitialInviteReturnTests(unittest.TestCase):
    def test_only_25_main_observed_activity_allows_initial_return(self):
        current=('com.tencent.wework',0,'com.tencent.wework/.friends.controller.WechatContactSendVerifyActivity')
        self.assertTrue(g.is_observed_25_invite_foreground('25',0,current))
        for number,user,fg in (('155',999,current),('23',0,current),('25',999,current),('25',0,('other',0,current[2])),('25',0,(current[0],999,current[2])),('25',0,(current[0],0,'com.tencent.wework/.OtherActivity'))):
            self.assertFalse(g.is_observed_25_invite_foreground(number,user,fg))


class ScreenWakeTests(unittest.TestCase):
    def test_awake_and_unrecognized_state_never_sends_keys(self):
        for state in ('mWakefulness=Awake','unknown'):
            calls=[];guard=g.ScreenWakeGuard(lambda:state,lambda:True,lambda:calls.append('WAKE'),lambda:calls.append('DISMISS'))
            self.assertFalse(guard.ensure_awake());self.assertFalse(calls)

    def test_only_sleeping_display_gets_one_normal_wake_and_os_dismissal(self):
        for state in ('Asleep','Dozing'):
            calls=[];guard=g.ScreenWakeGuard(lambda:'mWakefulness='+state,lambda:True,lambda:calls.append('WAKE'),lambda:calls.append('DISMISS'))
            self.assertTrue(guard.ensure_awake());self.assertEqual(calls,['WAKE','DISMISS']);self.assertEqual(guard.count,1)

    def test_lost_lease_before_or_after_wake_stops_further_operations(self):
        for leases,expected in (([False],[]),([True,False],['WAKE'])):
            values=iter(leases);calls=[];guard=g.ScreenWakeGuard(lambda:'mWakefulness=Asleep',lambda:next(values),lambda:calls.append('WAKE'),lambda:calls.append('DISMISS'))
            with self.assertRaises(w.StopPreview):guard.ensure_awake()
            self.assertEqual(calls,expected)

    def test_unknown_wake_delivery_is_not_replayed_or_followed_by_dismissal(self):
        calls=[]
        def unknown():calls.append('WAKE');raise TimeoutError()
        guard=g.ScreenWakeGuard(lambda:'mWakefulness=Asleep',lambda:True,unknown,lambda:calls.append('DISMISS'))
        with self.assertRaises(TimeoutError):guard.ensure_awake()
        self.assertEqual(calls,['WAKE'])

    def test_repeated_sleep_has_three_wake_limit_without_settings_changes(self):
        calls=[];guard=g.ScreenWakeGuard(lambda:'mWakefulness=Asleep',lambda:True,lambda:calls.append('WAKE'),lambda:calls.append('DISMISS'))
        for _ in range(3):self.assertTrue(guard.ensure_awake())
        with self.assertRaisesRegex(w.StopPreview,'repeated_display_sleep'):guard.ensure_awake()
        self.assertEqual(calls,['WAKE','DISMISS']*3)


if __name__ == '__main__':
    unittest.main()
