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
        self.assertEqual(s['calls'],[['shell','cmd','statusbar','collapse']])
    def test_shade_to_home_reobserves_without_tapping_background(self):
        r,s,root=fixture()
        with clock():self.assertTrue(r.recover_page_mismatch('account-home',root=root,parent={}))
        self.assertEqual(s['calls'],[['shell','cmd','statusbar','collapse']])
    def test_post_input_shade_preserves_input_and_detects_challenge(self):
        r,s,root=fixture()
        for value in (lookup.VERIFICATION_TITLE,lookup.JIGSAW_VERIFICATION_ACTION):ET.SubElement(root,'node',{'text':value})
        with clock(),self.assertRaisesRegex(RuntimeError,'human_verification_required'):
            r.recover_page_mismatch('result',root=root,parent={},phone_query_started=True)
        self.assertEqual(len(s['calls']),1)
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
        self.assertEqual(len(s['calls']),1)
    def test_collapse_failure_preserves_error(self):
        r,s,root=fixture();r.adb=mock.Mock(side_effect=RuntimeError('collapse_failed'))
        with clock(),self.assertRaisesRegex(RuntimeError,'collapse_failed'):r.recover_page_mismatch('account-home',root=root,parent={})
        self.assertEqual(r.adb.call_count,1)

if __name__=='__main__':unittest.main()
