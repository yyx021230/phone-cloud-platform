"""Recorded preparation layouts; all device I/O simulated, no ADB calls."""
import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import alipay_name_lookup as lookup
from test_lookup_overlay_guard import HOME, home, node, parents, clock


def upgrade():
    root=ET.Element('hierarchy')
    node(root,text='应用中心升级',bounds='[250,670][475,720]')
    node(root,text='你可以在更多-右上角“设置”-选择回到老版本')
    node(root,text='完成',bounds='[70,1470][650,1570]')
    node(root,text='\ue626',bounds='[650,665][690,705]')
    return root

class TechnicalRecovery(unittest.TestCase):
    def fixture(self, after=None):
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'local-recovery'})
        state={'closed':False,'taps':[]}
        r.emit=mock.Mock();r.focus_state=mock.Mock(return_value=([],HOME,lookup.ALIPAY_PACKAGE))
        r.focus=mock.Mock(return_value=[HOME])
        r.dump=lambda *a,**kw: ((after or home()),parents(after or home())) if state['closed'] else (upgrade(),parents(upgrade()))
        def adb(args,**kw):
            self.assertEqual(args,['shell','input','tap','670','685'])
            state['taps'].append(args);state['closed']=True;return ''
        r.adb=mock.Mock(side_effect=adb)
        return r,state
    def test_upgrade_closes_only_x_then_returns_original_home_wait(self):
        r,s=self.fixture()
        with clock():r.wait_unique('account-switch-returned-home',timeout=20,text='我的')
        self.assertTrue(s['closed']);self.assertEqual(len(s['taps']),1)
    def test_changed_foreground_blocks_x(self):
        r,s=self.fixture();r.focus_state.return_value=([], 'other.app/.Home',lookup.ALIPAY_PACKAGE)
        self.assertFalse(r.dismiss_app_center_upgrade());r.adb.assert_not_called()
    def test_changed_sheet_or_ambiguous_x_never_tapped(self):
        for mode in ['duplicate','wrong_hint','far_away']:
            r,s=self.fixture();tree=upgrade()
            if mode=='duplicate':node(tree,text='\ue626',bounds='[650,665][690,705]')
            if mode=='wrong_hint':tree[1].set('text','别的升级提示')
            if mode=='far_away':tree[-1].set('bounds','[650,1200][690,1250]')
            r.dump=lambda *a,**kw:(tree,parents(tree))
            self.assertFalse(r.dismiss_app_center_upgrade());r.adb.assert_not_called()
    def test_captcha_after_close_enters_manual_without_second_tap(self):
        tree=ET.Element('hierarchy')
        for t in (lookup.VERIFICATION_TITLE,lookup.JIGSAW_VERIFICATION_ACTION):node(tree,text=t)
        r,s=self.fixture(tree)
        with clock(),self.assertRaisesRegex(RuntimeError,'human_verification_required'):
            r.wait_unique('account-switch-returned-home',timeout=20,text='我的')
        self.assertEqual(len(s['taps']),1)
    def test_dismissal_at_deadline_gets_one_final_home_observation(self):
        r,s=self.fixture()
        with clock() as now:
            original=r.recover_page_mismatch
            def slow(*a,**kw):
                result=original(*a,**kw);now[0]+=21;return result
            r.recover_page_mismatch=slow
            r.wait_unique('account-switch-returned-home',timeout=20,text='我的')
        self.assertEqual(len(s['taps']),1)
    def test_desc_only_home_tab_is_arrival_not_a_new_account_click(self):
        r,s=self.fixture();s['closed']=True;tree=home()
        tree[-1].set('text','');tree[-1].set('content-desc','我的');r.dump=lambda *a,**kw:(tree,parents(tree))
        with clock():r.wait_unique('account-switch-returned-home',timeout=20,text='我的')
        r.adb.assert_not_called()
    def test_cold_restriction_with_keyboard_and_search_layers_preserves_identity_check(self):
        from test_lookup_cold_restriction import ColdRestrictionTests
        from test_lookup_overlay_guard import SEARCH
        r=ColdRestrictionTests().runner();state={'backs':0}
        r.exit_search_activity_for_account_navigation=lookup.Runner.exit_search_activity_for_account_navigation.__get__(r)
        r.focus_state=lambda:([],SEARCH if state['backs']<3 else HOME,'')
        def adb(args,**kw):
            self.assertEqual(args,['shell','input','keyevent','4']);state['backs']+=1;return ''
        r.adb=mock.Mock(side_effect=adb)
        r.tap_unique=mock.Mock(side_effect=RuntimeError('exact_back_unavailable'))
        with clock(),self.assertRaisesRegex(RuntimeError,'restriction_before_search'):
            r.prepare_available_account()
        self.assertEqual(state['backs'],3)
        self.assertTrue(r.account_identity_verified)
        r.switch_account.assert_not_called();r.open_search.assert_not_called()

if __name__=='__main__':unittest.main()
