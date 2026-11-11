"""Observed native preparation regression; device I/O is simulated."""
import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import alipay_name_lookup as lookup
from test_lookup_overlay_guard import clock

SHADE='mCurrentFocus=Window{com.android.systemui:abc u0 NotificationShade type=2040}'
HOME='mCurrentFocus=Window{abc u0 com.eg.android.AlipayGphone/com.eg.android.AlipayGphone.AlipayLogin}'
LOGIN='mCurrentFocus=Window{abc u0 com.eg.android.AlipayGphone/com.ali.user.mobile.loginupgrade.activity.GuideActivity}'
APP='mFocusedApp=ActivityRecord{abc u0 com.eg.android.AlipayGphone/com.ali.user.mobile.loginupgrade.activity.GuideActivity t1 d0}'

def fixture(after=HOME):
    r=lookup.Runner({'serial':'SYNTHETIC','taskId':'shade-prepare','accountCooldownProtocol':1})
    state={'collapsed':False,'calls':[]}
    r.emit=lambda step,**data:r.log.append({'step':step,**data})
    r.focus=lambda **kw: ['mCurrentFocus=null','mFocusedApp=null',after if state['collapsed'] else SHADE,APP]
    def adb(args,**kw):
        state['calls'].append(args)
        if args==['shell','dumpsys','power']: return 'mWakefulness=Awake'
        if args==['shell','cmd','statusbar','collapse']: state['collapsed']=True;return ''
        raise AssertionError('Unexpected command')
    r.adb=adb
    root=ET.Element('hierarchy')
    r.dump=mock.Mock(return_value=(root,{}))
    return r,state,root

class PreparationShade(unittest.TestCase):
    def test_account_prepare_shade_to_login_stops_before_account_or_input(self):
        r,s,root=fixture(LOGIN);r.dismiss_vivo_usb_mode_dialog=lambda:False
        with clock(),self.assertRaisesRegex(RuntimeError,'login_required'):
            r.enter_my_settings('native-case')
        self.assertEqual(s['calls'],[['shell','dumpsys','power'],['shell','cmd','statusbar','collapse']])
    def test_shade_to_home_reobserves_without_tapping_background(self):
        r,s,root=fixture()
        with clock():self.assertTrue(r.recover_page_mismatch('account-home',root=root,parent={}))
        self.assertEqual(s['calls'],[['shell','dumpsys','power'],['shell','cmd','statusbar','collapse']])
    def test_post_input_shade_preserves_input_and_detects_challenge(self):
        r,s,root=fixture()
        for value in (lookup.VERIFICATION_TITLE,lookup.JIGSAW_VERIFICATION_ACTION):ET.SubElement(root,'node',{'text':value})
        with clock(),self.assertRaisesRegex(RuntimeError,'human_verification_required'):
            r.recover_page_mismatch('result',root=root,parent={},phone_query_started=True)
        self.assertEqual(len(s['calls']),2)
    def test_unrelated_underlying_app_never_collapses(self):
        r,s,root=fixture();r.focus=lambda **kw:[SHADE,APP.replace(lookup.ALIPAY_PACKAGE,lookup.ALIPAY_PACKAGE+'.fake')]
        with clock():self.assertFalse(r.recover_page_mismatch('account-home',root=root,parent={}))
        self.assertFalse(s['calls'])
    def test_ambiguous_windows_never_collapse(self):
        r,s,root=fixture();r.focus=lambda **kw:[SHADE,'mCurrentFocus=Window{abc u0 other.app/.Main}',APP]
        with clock():self.assertFalse(r.recover_page_mismatch('account-home',root=root,parent={}))
        self.assertFalse(s['calls'])
    def test_permission_dialog_never_collapses(self):
        r,s,root=fixture();r.focus=lambda **kw:[SHADE.replace('NotificationShade','PermissionDialog'),APP]
        with clock():self.assertFalse(r.recover_page_mismatch('account-home',root=root,parent={}))
        self.assertFalse(s['calls'])
    def test_reappeared_shade_not_collapsed_twice(self):
        r,s,root=fixture()
        with clock() as now:
            self.assertTrue(r.recover_page_mismatch('account-home',root=root,parent={}))
            s['collapsed']=False;now[0]+=2
            with self.assertRaisesRegex(RuntimeError,'known_overlay_reappeared'):r.recover_page_mismatch('account-home',root=root,parent={})
        self.assertEqual(len(s['calls']),2)
    def test_dozing_keyguard_wakes_before_collapse_without_navigation(self):
        r,s,root=fixture();original_adb=r.adb
        power=iter(['mWakefulness=Dozing','mWakefulness=Awake','mWakefulness=Awake'])
        def adb(args,**kw):
            if args==['shell','dumpsys','power']:
                s['calls'].append(args);return next(power)
            if args in (['shell','input','keyevent','224'],['shell','wm','dismiss-keyguard']):
                s['calls'].append(args);return ''
            return original_adb(args,**kw)
        r.adb=adb
        with clock():self.assertTrue(r.recover_page_mismatch('result',root=root,parent={},phone_query_started=True))
        self.assertEqual(s['calls'],[
            ['shell','dumpsys','power'],['shell','input','keyevent','224'],
            ['shell','wm','dismiss-keyguard'],['shell','dumpsys','power'],
            ['shell','dumpsys','power'],['shell','cmd','statusbar','collapse']])
    def test_collapse_failure_preserves_error(self):
        r,s,root=fixture();r.adb=mock.Mock(side_effect=RuntimeError('collapse_failed'))
        with clock(),self.assertRaisesRegex(RuntimeError,'collapse_failed'):r.recover_page_mismatch('account-home',root=root,parent={})
        self.assertEqual(r.adb.call_count,1)

class PreparationArrivalBoundary(unittest.TestCase):
    def run_case(self, after='home', recovered=True, verified=True):
        from test_lookup_overlay_guard import home
        r=lookup.Runner({'serial':'SYNTHETIC'})
        r.account_identity_verified=verified;r.current_account_after_switch='fixture-account'
        empty=ET.Element('hierarchy');arrival=home()
        if after=='duplicate':
            ET.SubElement(arrival,'node',{'content-desc':'搜索框','package':lookup.ALIPAY_PACKAGE})
        r.dump=mock.Mock(side_effect=[(empty,{}),(arrival,{})])
        r.emit=mock.Mock();r.focus=lambda **kw:[]
        r.focus_state=lambda:([], HOME if after!='other-app' else 'mCurrentFocus=Window{x u0 other.app/.Main}', '')
        r.account_restriction_evidence=mock.Mock(side_effect=[None, {'kind':'fixture-limit'} if after=='restricted' else None])
        r.raise_account_restriction=mock.Mock(side_effect=RuntimeError('fixture-restriction'))
        r.page_overlay_protected=lambda *a,**kw:after=='puzzle'
        r.page_overlay_kind=lambda **kw:None
        r.return_verified_account_home_tab=lambda *a:False
        r.adb=mock.Mock(side_effect=AssertionError('No input allowed'))
        with clock() as now:
            def recover(*a,**kw):now[0]+=13;return recovered
            r.recover_page_mismatch=recover
            try:
                out=r.wait_unique('home-account-preflight-complete',timeout=12,desc='搜索框',package=lookup.ALIPAY_PACKAGE)
                return r,out
            except Exception as e:return r,e

    def test_confirmed_dismissal_at_deadline_observes_home_once_without_input(self):
        r,out=self.run_case();self.assertNotIsInstance(out,Exception)
        self.assertEqual(r.dump.call_count,2)
        self.assertEqual(r.dump.call_args.kwargs,dict(command_timeout=3,read_timeout=2,allow_tty_fallback=False))
        r.adb.assert_not_called()

    def test_final_frame_keeps_limit_puzzle_and_foreign_page_protection(self):
        for state,reason in [('restricted','fixture-restriction'),('puzzle','human_verification_required'),('other-app','selector_missing'),('duplicate','selector_missing')]:
            r,out=self.run_case(state);self.assertIsInstance(out,RuntimeError);self.assertIn(reason,str(out));r.adb.assert_not_called()

    def test_no_confirmed_recovery_or_account_does_not_extend_wait(self):
        for recovered,verified in [(False,True),(True,False)]:
            r,out=self.run_case(recovered=recovered,verified=verified)
            self.assertIsInstance(out,RuntimeError);self.assertEqual(r.dump.call_count,1)

if __name__=='__main__':unittest.main()
