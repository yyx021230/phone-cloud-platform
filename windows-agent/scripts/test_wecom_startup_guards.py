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


DRAWER = w.Screen(w.PACKAGE, tuple(w.Node('android.widget.TextView',text=text,
    name='com.tencent.wework:id/'+name,position=(.25,y),size=(.2,.027))
    for name,text,y in (('nq','高级功能',.79875),('d7x','创建/加入企业',.869375),('lt_','设置',.919375))))

class AccountDrawerTests(unittest.TestCase):
    def test_exact_observed_bundle_only(self):
        self.assertTrue(g.is_wecom_account_drawer(DRAWER))
        for page in (replace(DRAWER,package='other'),replace(DRAWER,nodes=DRAWER.nodes[:2]),
                     replace(DRAWER,nodes=DRAWER.nodes+(DRAWER.nodes[0],))):
            self.assertFalse(g.is_wecom_account_drawer(page))
        for change in (dict(name='unknown'),dict(text='切换账号'),dict(enabled=False),
                       dict(position=(.25,.4)),dict(size=(float('nan'),.02))):
            self.assertFalse(g.is_wecom_account_drawer(replace(DRAWER,nodes=(replace(DRAWER.nodes[0],**change),)+DRAWER.nodes[1:])))



class DrawerRestartTests(unittest.TestCase):
    def test_restart_only_observed_clone_once(self):
        calls=[];fg=('com.tencent.wework',999,'com.tencent.wework/.launch.WwMainActivity')
        self.assertTrue(g.restart_observed_wecom_clone_drawer(lambda:DRAWER,lambda:fg,lambda:True,lambda:calls.append('RESTART_999'),999))
        self.assertEqual(calls,['RESTART_999'])
        for page,user in ((HOME,999),(DRAWER,0)):
            self.assertFalse(g.restart_observed_wecom_clone_drawer(lambda:page,lambda:fg,lambda:True,lambda:calls.append('RESTART_999'),user))
        self.assertEqual(calls,['RESTART_999'])

    def test_page_foreground_and_lease_changes_never_restart(self):
        fg=('com.tencent.wework',999,'com.tencent.wework/.launch.WwMainActivity')
        for current,lease,changed in ((('other',999,'other'),True,False),(fg,False,False),(fg,True,True)):
            calls=[];pages=iter([DRAWER,HOME if changed else DRAWER])
            with self.assertRaises(w.StopPreview):
                g.restart_observed_wecom_clone_drawer(lambda:next(pages),lambda:current,lambda:lease,lambda:calls.append('RESTART'),999)
            self.assertFalse(calls)

    def test_unknown_restart_delivery_is_never_replayed(self):
        calls=[]
        def unknown():calls.append('RESTART');raise TimeoutError()
        with self.assertRaises(TimeoutError):g.restart_observed_wecom_clone_drawer(lambda:DRAWER,lambda:('com.tencent.wework',999,'com.tencent.wework/.launch.WwMainActivity'),lambda:True,unknown,999)
        self.assertEqual(calls,['RESTART'])


if __name__ == '__main__':
    unittest.main()
