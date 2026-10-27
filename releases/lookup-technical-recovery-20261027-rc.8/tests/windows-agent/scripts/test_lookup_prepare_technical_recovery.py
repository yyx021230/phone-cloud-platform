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

class StackedCanvasTests(unittest.TestCase):
    def runner(self, after=None):
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'stacked'})
        tree=home();node(tree,desc='全屏广告')
        r.focus_state=mock.Mock(return_value=([],HOME,lookup.ALIPAY_PACKAGE))
        r.emit=mock.Mock();r.adb=mock.Mock(return_value=b'image')
        r.dump=mock.Mock(return_value=(after or home(),parents(after or home())))
        r.dismiss_canvas_real_name_prompt=mock.Mock(return_value=True)
        r.dismiss_known_overlay=mock.Mock(return_value=False)
        return r,tree
    def test_canvas_above_stale_ad_uses_exact_visual_handler_once(self):
        r,tree=self.runner()
        with clock(),mock.patch.object(lookup,'real_name_canvas_evidence',return_value={'close':[360,1252]}):
            self.assertTrue(r.recover_page_mismatch('account-navigation-cover',root=tree,parent=parents(tree)))
        r.dismiss_canvas_real_name_prompt.assert_called_once_with(None,'account-navigation-cover')
        r.dismiss_known_overlay.assert_not_called()
        self.assertEqual(r._page_overlay_budget['actions'],1)
    def test_captcha_after_canvas_close_enters_manual(self):
        after=home();node(after,text=lookup.VERIFICATION_TITLE)
        r,tree=self.runner(after)
        with clock(),mock.patch.object(lookup,'real_name_canvas_evidence',return_value={'close':[360,1252]}):
            with self.assertRaisesRegex(RuntimeError,'human_verification_required'):
                r.recover_page_mismatch('account-navigation-cover',root=tree,parent=parents(tree))
        r.dismiss_canvas_real_name_prompt.assert_called_once()
    def test_unknown_ad_without_exact_image_stays_untouched(self):
        r,tree=self.runner();r.dump.return_value=(tree,parents(tree))
        with clock(),mock.patch.object(lookup,'real_name_canvas_evidence',return_value={'close':None}):
            with self.assertRaisesRegex(RuntimeError,'close_unverified:fullscreen_ad'):
                r.recover_page_mismatch('unknown',root=tree,parent=parents(tree))
        r.dismiss_canvas_real_name_prompt.assert_not_called()
        self.assertFalse(any(c.args[0][:2]==['shell','input'] for c in r.adb.call_args_list))
    def test_query_started_or_foreign_focus_never_probes_canvas(self):
        for mode in ('query','foreign','captcha'):
            r,tree=self.runner();r.dump.return_value=(tree,parents(tree))
            if mode=='foreign':r.focus_state.return_value=([],'other.app/.Home',lookup.ALIPAY_PACKAGE)
            if mode=='captcha':node(tree,text=lookup.VERIFICATION_TITLE)
            with clock(),mock.patch.object(lookup,'real_name_canvas_evidence') as image:
                try:r.recover_page_mismatch('guard',root=tree,parent=parents(tree),phone_query_started=mode=='query')
                except RuntimeError:pass
                image.assert_not_called()
            r.dismiss_canvas_real_name_prompt.assert_not_called()

class VerifiedAccountWarmReturnTests(unittest.TestCase):
    def test_only_fresh_verified_noncooling_preflight_return_avoids_force_stop(self):
        for verified,reason,cooling,warm in [(True,'account-preflight-complete',False,True),
                (False,'account-preflight-complete',False,False),
                (True,'account-switch-complete',False,True),
                (False,'account-switch-complete',False,False),
                (True,'account-switch-complete',True,False),
                (True,'ordinary-query-recovery',False,False),
                (True,'account-preflight-complete',True,False)]:
            r=lookup.Runner({'serial':'SYNTHETIC','taskId':'warm'})
            r.account_identity_verified=verified;r.current_account_after_switch='test-account'
            r.cooling_accounts=lambda:{'test-account'} if cooling else set()
            r.adb=mock.Mock(return_value='');r.emit=mock.Mock();r.dismiss_known_overlay=mock.Mock()
            with clock():r.launch(reason)
            args=[c.args[0] for c in r.adb.call_args_list]
            self.assertEqual(any('force-stop' in a for a in args),not warm)
            starts=[a for a in args if a[:3]==['shell','am','start']]
            self.assertEqual(len(starts),1)
            self.assertIn('0x14200000' if warm else '0x10008000',starts[0])
            r.dismiss_known_overlay.assert_called_once()
            self.assertFalse(any('tap' in a or 'text' in a for a in args))

class WarmHomeTabTests(unittest.TestCase):
    def fixture(self):
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'home-tab'})
        r._verified_account_home_return=True;r.account_identity_verified=True;r.current_account_after_switch='test-account'
        root=home();root.remove(root[0]);root[-1].set('selected','true')
        node(root,text='首页',rid=lookup.TAB_DESCRIPTION_ID,selected='false',bounds='[40,1500][100,1590]')
        r.focus_state=mock.Mock(return_value=([],HOME,lookup.ALIPAY_PACKAGE));r.emit=mock.Mock();r.adb=mock.Mock()
        return r,root
    def test_selected_my_tab_returns_home_once_and_reobserves_search(self):
        for token in ['home-account-preflight-complete','home-account-preflight-switch-complete']:
            r,tree=self.fixture();after=home();r.dump=mock.Mock(side_effect=[(tree,parents(tree)),(after,parents(after))])
            r.recover_page_mismatch=mock.Mock(return_value=False)
            with clock():r.wait_unique(token,desc='搜索框',package=lookup.ALIPAY_PACKAGE)
            r.adb.assert_called_once_with(['shell','input','tap','70','1545'],timeout=8)
            self.assertEqual(r.dump.call_count,2)
    def test_no_tap_for_foreign_unverified_cooling_or_ambiguous_tab(self):
        for mode in ('foreign','unverified','cooling','ambiguous','not-preflight'):
            r,tree=self.fixture()
            if mode=='foreign':r.focus_state.return_value=([],'other.app/.Home',lookup.ALIPAY_PACKAGE)
            if mode=='unverified':r.account_identity_verified=False
            if mode=='cooling':r.cooling_accounts=lambda:{'test-account'}
            if mode=='ambiguous':node(tree,text='首页',rid=lookup.TAB_DESCRIPTION_ID,selected='false')
            if mode=='not-preflight':r._verified_account_home_return=False
            self.assertFalse(r.return_verified_account_home_tab(tree,parents(tree)));r.adb.assert_not_called()
    def test_captcha_keeps_manual_and_does_not_tap_home(self):
        r,tree=self.fixture();node(tree,text=lookup.VERIFICATION_TITLE)
        with self.assertRaisesRegex(RuntimeError,'human_verification_required'):r.return_verified_account_home_tab(tree,parents(tree))
        r.adb.assert_not_called()

if __name__=='__main__':unittest.main()
