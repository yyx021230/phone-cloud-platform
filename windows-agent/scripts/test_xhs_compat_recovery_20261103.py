"""Real generic element-layout regressions; all device actions are mocks."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock,patch
import xml.etree.ElementTree as ET

ROOT=Path(__file__).parent
spec=importlib.util.spec_from_file_location('repair_sync',ROOT/'小红书数据同步.py')
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
LOGIN='mCurrentFocus=Window{old u0 com.xingin.xhs/com.xingin.login.halfwelcome.HalfWelcomeActivity}'
HONOR='mCurrentFocus=Window{old u0 com.hihonor.ouc}'
INDEX='mCurrentFocus=Window{old u0 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2}'
def login_tree():
    root=ET.Element('hierarchy')
    for i,text in enumerate(('登录后，体验更多功能','一键登录','微信登录','其他登录方式')):
        ET.SubElement(root,'node',{'package':sync.XHS_PACKAGE,'class':'android.widget.TextView','text':text,'bounds':f'[0,{i*80}][200,{i*80+70}]'})
    return root

class PhoneOnlyWelcomeTests(unittest.TestCase):
    current='mCurrentFocus=Window{fresh u0 com.xingin.xhs/com.xingin.login.activity.WelcomeActivity}'
    def tree(self):return ET.parse(ROOT/'fixtures/xhs/honor-phone-only-welcome-elements.xml').getroot()
    def carrier(self):return ET.parse(ROOT/'fixtures/xhs/honor-carrier-welcome-elements.xml').getroot()
    def test_carrier_roles_do_not_depend_on_the_sim_phone_number(self):
        root=self.carrier()
        next(n for n in root.iter('node') if n.get('resource-id','').endswith(':id/phoneNumText')).set('text','')
        self.assertEqual(sync.login_element_evidence(root,self.current,['collection_slot_requested:app1']),
                         'carrier_quick_welcome_controls')
    def test_incomplete_or_mixed_carrier_and_phone_controls_are_unproven(self):
        for mode in ('missing_other','disabled_quick','wrong_parent','protocol','mixed','duplicate'):
            root=self.carrier();nodes=list(root.iter('node'))
            other=next(n for n in nodes if n.get('resource-id','').endswith(':id/otherLoginWays'))
            quick=next(n for n in nodes if n.get('resource-id','').endswith(':id/quickLoginBtn'))
            protocol=next(n for n in nodes if n.get('resource-id','').endswith(':id/loginProtocol'))
            if mode=='missing_other':other.set('resource-id','')
            if mode=='disabled_quick':quick.set('enabled','false')
            if mode=='wrong_parent':
                parent=next(n for n in nodes if other in list(n));parent.remove(other);root.append(other)
            if mode=='protocol':protocol.set('text','未知运营商条款')
            if mode=='mixed':root.append(copy.deepcopy(next(n for n in self.tree().iter('node') if n.get('resource-id','').endswith(':id/mPhoneLoginView'))))
            if mode=='duplicate':root.append(copy.deepcopy(quick))
            with self.subTest(mode=mode):self.assertIsNone(sync.login_element_evidence(root,self.current,['collection_slot_requested:app1']))
    def test_carrier_transition_discards_pair_once_and_reads_two_new_trees(self):
        events=['collection_slot_requested:app1','native_window_elements_enabled']
        with patch.object(sync,'native_window_capture',side_effect=[self.tree(),self.carrier(),self.carrier(),self.carrier()]) as reader,patch.object(sync,'focus',return_value=self.current),patch.object(sync.time,'sleep'),patch.object(sync,'adb') as adb:
            with self.assertRaisesRegex(RuntimeError,'account is logged out'):
                sync.confirm_logged_out('adb','serial',ET.Element('hierarchy'),lambda:None,events)
            self.assertEqual(reader.call_count,4);self.assertEqual(events.count('native_welcome_confirmation_recheck_once'),1);adb.assert_not_called()
    def test_oscillating_welcome_controls_stop_after_one_new_pair(self):
        events=['collection_slot_requested:app1','native_window_elements_enabled']
        with patch.object(sync,'native_window_capture',side_effect=[self.tree(),self.carrier(),self.tree(),self.carrier()]) as reader,patch.object(sync,'focus',return_value=self.current),patch.object(sync.time,'sleep'):
            with self.assertRaisesRegex(sync.ElementListReadError,'state changed'):
                sync.confirm_logged_out('adb','serial',ET.Element('hierarchy'),lambda:None,events)
            self.assertEqual(reader.call_count,4)
    def test_native_phone_only_roles_are_evidence_without_image_or_title_inference(self):
        self.assertEqual(sync.login_element_evidence(self.tree(),self.current,['collection_slot_requested:app1']),
                         'phone_only_welcome_controls')
        self.assertIsNone(sync.login_element_evidence(self.tree(),INDEX,['collection_slot_requested:app1']))
    def test_incomplete_wrong_parent_wrong_package_or_duplicate_roles_are_not_logout(self):
        for mode in ('missing','foreign','parent','duplicate','protocol','disabled','logged_in'):
            root=self.tree();nodes=list(root.iter('node'));phone=next(n for n in nodes if n.get('resource-id','').endswith(':id/mPhoneLoginView'))
            text=next(n for n in nodes if n.get('resource-id','').endswith(':id/mPhoneLoginTextView'))
            protocol=next(n for n in nodes if n.get('resource-id','').endswith(':id/loginProtocol'))
            if mode=='missing':text.set('resource-id','')
            if mode=='foreign':text.set('package','other.app')
            if mode=='parent':phone.remove(text);root.append(text)
            if mode=='duplicate':phone.append(copy.deepcopy(text))
            if mode=='protocol':protocol.set('text','未知协议')
            if mode=='disabled':phone.set('enabled','false')
            if mode=='logged_in':ET.SubElement(root,'node',{'package':sync.XHS_PACKAGE,'text':'作品分析','bounds':'[0,0][100,100]'})
            with self.subTest(mode=mode):self.assertIsNone(sync.login_element_evidence(root,self.current,['collection_slot_requested:app1']))
    def test_confirmation_requires_two_fresh_matching_native_trees_without_any_click(self):
        events=['collection_slot_requested:app1','native_window_elements_enabled'];a=self.tree();b=self.tree()
        with patch.object(sync,'native_window_capture',side_effect=[a,b]) as reader,patch.object(sync,'focus',return_value=self.current),patch.object(sync.time,'sleep'),patch.object(sync,'adb') as adb:
            with self.assertRaisesRegex(RuntimeError,'account is logged out'):
                sync.confirm_logged_out('adb','serial',ET.Element('hierarchy'),lambda:None,events)
            self.assertEqual(reader.call_count,2);adb.assert_not_called()
    def test_second_read_losing_a_role_is_unproven_not_logged_out(self):
        events=['collection_slot_requested:app1','native_window_elements_enabled'];a=self.tree();b=self.tree()
        next(n for n in b.iter('node') if n.get('resource-id','').endswith(':id/privacyCheck')).set('resource-id','')
        with patch.object(sync,'native_window_capture',side_effect=[a,b]),patch.object(sync,'focus',return_value=self.current),patch.object(sync.time,'sleep'):
            with self.assertRaisesRegex(sync.ElementListReadError,'state changed'):
                sync.confirm_logged_out('adb','serial',ET.Element('hierarchy'),lambda:None,events)
    def test_requested_clone_cannot_be_classified_using_owner_login_elements(self):
        with self.assertRaisesRegex(RuntimeError,'does not match'):
            sync.login_element_evidence(self.tree(),self.current,['collection_slot_requested:app2','clone_user_requested:128'])


class WarnedCreatorDataEntryTests(unittest.TestCase):
    def tree(self,more=False):
        root=ET.Element('hierarchy',{'data-source':'xml'})
        def node(parent,text,cls='android.widget.TextView',click='false',box='[0,0][200,100]'):
            return ET.SubElement(parent,'node',{'package':sync.XHS_PACKAGE,'class':cls,'text':text,'clickable':click,'enabled':'true','bounds':box})
        node(root,'创作中心');node(root,'账号异常')
        if more:
            node(root,'最新笔记');parent=node(root,'','android.widget.LinearLayout','true','[0,200][300,400]');node(parent,'更多',box='[0,250][100,300]')
        else:
            node(root,'近 7 日数据');parent=node(root,'','android.widget.LinearLayout','true','[0,200][300,400]');node(parent,'观看',box='[0,250][100,300]')
        return root
    def test_status_badge_keeps_warning_but_does_not_deny_a_proven_existing_entry(self):
        for more in (False,True):
            events=[];root=self.tree(more)
            self.assertTrue(sync.allow_warned_creator_data_entry(root,events))
            self.assertTrue(sync.allow_warned_creator_data_entry(root,events))
            self.assertEqual(events,['creator_account_status_abnormal_observed'])
    def test_permission_only_or_disabled_foreign_and_ambiguous_actions_stay_blocked(self):
        for mode in ('no_entry','disabled','foreign','ambiguous'):
            root=self.tree();parent=next(n for n in root.iter('node') if n.get('clickable')=='true')
            if mode=='no_entry':root.remove(parent)
            if mode=='disabled':parent.set('enabled','false')
            if mode=='foreign':parent.set('package','other.app')
            if mode=='ambiguous':root.append(copy.deepcopy(parent))
            events=[]
            with self.subTest(mode=mode):self.assertFalse(sync.allow_warned_creator_data_entry(root,events));self.assertEqual(events,[])
    def test_normal_overview_navigation_continues_without_tapping_account_or_permission(self):
        root=self.tree();listing=ET.Element('hierarchy')
        for value in ('数据中心','作品分析','全部笔记'):
            ET.SubElement(listing,'node',{'text':value,'bounds':'[0,0][200,100]'})
        events=[]
        with patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'navigation_capture',return_value=listing),patch.object(sync,'recover_known_overlay',return_value=False),patch.object(sync,'tap_label') as tap,patch.object(sync.time,'sleep'):
            self.assertIs(sync.ensure_creator_list('adb','serial',root,'app1',lambda:None,events),listing)
            self.assertEqual([c.args[3] for c in tap.call_args_list],['观看'])
        self.assertIn('creator_account_status_abnormal_observed',events)
    def test_permission_gate_is_not_accepted_or_clicked_even_with_a_status_badge(self):
        root=self.tree();ET.SubElement(root,'node',{'package':sync.XHS_PACKAGE,'text':'开通数据权限','bounds':'[0,450][200,500]'})
        with patch.object(sync,'wake_if_asleep',return_value=False),patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'recover_known_overlay',return_value=False),patch.object(sync,'tap_label') as tap:
            with self.assertRaisesRegex(RuntimeError,'permission is not enabled'):
                sync.ensure_creator_list('adb','serial',root,'app1',lambda:None,[])
            tap.assert_not_called()


class ElementCompatibilityTests(unittest.TestCase):
    def test_blank_creator_center_is_an_exact_native_skeleton_not_zero_or_login(self):
        root=ET.parse(ROOT/'fixtures/xhs/creator-center-blank-91.xml').getroot()
        current=INDEX.replace('com.xingin.xhs.index.v2.IndexActivityV2','com.xingin.reactnative.ui.XhsReactActivity')
        self.assertTrue(sync.blank_creator_center_loading(root,current))
        for mode in ('permission','foreign','wrong_activity','missing_scroll','duplicate'):
            r=copy.deepcopy(root);focus=current
            if mode=='permission':ET.SubElement(r,'node',{'package':sync.XHS_PACKAGE,'text':'开通数据权限','bounds':'[0,0][100,100]'})
            if mode=='foreign':next(r.iter('node')).set('package','other.app')
            if mode=='wrong_activity':focus=INDEX
            if mode=='missing_scroll':next(n for n in r.iter('node') if n.get('content-desc')=='创作中心滚动区').set('content-desc','')
            if mode=='duplicate':r.append(copy.deepcopy(next(n for n in r.iter('node') if n.get('content-desc')=='创作中心滚动区')))
            with self.subTest(mode=mode):self.assertFalse(sync.blank_creator_center_loading(r,focus))
    def test_blank_creator_center_reopens_only_once_after_wait_and_proves_return(self):
        root=ET.parse(ROOT/'fixtures/xhs/creator-center-blank-91.xml').getroot()
        current=INDEX.replace('com.xingin.xhs.index.v2.IndexActivityV2','com.xingin.reactnative.ui.XhsReactActivity')
        drawer=ET.fromstring('<hierarchy><node text="我的草稿" bounds="[0,0][100,100]"/><node text="创作者中心" bounds="[0,100][100,200]"/></hierarchy>')
        for mode in ('valid','already_reopened','unknown_return','wrong_user'):
            events=['collection_slot_requested:app1']
            if mode=='already_reopened':events.append('creator_center_blank_reopened')
            state=current.replace('u0','u999') if mode=='wrong_user' else current
            with self.subTest(mode=mode),patch.object(sync,'focus',side_effect=lambda *_:state),patch.object(sync,'navigation_capture',return_value=ET.Element('hierarchy') if mode=='unknown_return' else drawer),patch.object(sync,'adb') as adb:
                if mode=='valid':self.assertIs(sync.wait_creator_center_loading('adb','serial',root,lambda:None,events,budget=0),drawer)
                else:
                    with self.assertRaises(RuntimeError):sync.wait_creator_center_loading('adb','serial',root,lambda:None,events,budget=0)
                self.assertEqual(adb.call_count,int(mode in ('valid','unknown_return')))
                if adb.call_count:adb.assert_called_once_with('adb','serial','shell','input','keyevent','4',timeout=7)
    def test_creator_center_becoming_available_during_wait_does_not_reopen(self):
        root=ET.parse(ROOT/'fixtures/xhs/creator-center-blank-91.xml').getroot()
        current=INDEX.replace('com.xingin.xhs.index.v2.IndexActivityV2','com.xingin.reactnative.ui.XhsReactActivity')
        loaded=ET.fromstring('<hierarchy><node package="com.xingin.xhs" text="最新笔记" bounds="[0,0][100,100]"/></hierarchy>')
        with patch.object(sync,'focus',return_value=current),patch.object(sync,'navigation_capture',return_value=loaded),patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
            self.assertIs(sync.wait_creator_center_loading('adb','serial',root,lambda:None,['collection_slot_requested:app1']),loaded)
            adb.assert_not_called()
    def test_exit_notice_variant_requires_exact_body_and_two_unchanged_element_trees(self):
        activity=INDEX.replace('com.xingin.xhs.index.v2.IndexActivityV2','com.xingin.login.device.offline.DeviceOfflineRemindActivity')
        root=ET.Element('hierarchy')
        for text in ('账号下线提示','账号已退出登录，请尝试重新登录','重新登录'):
            ET.SubElement(root,'node',{'package':sync.XHS_PACKAGE,'text':text,'bounds':'[0,0][400,100]'})
        for mode in ('exact','missing_body','foreign','changed_second','wrong_user'):
            first=copy.deepcopy(root);second=copy.deepcopy(root);events=['collection_slot_requested:app1','native_window_elements_enabled']
            if mode=='missing_body':first[1].set('text','请重新登录以领取奖励')
            if mode=='foreign':first[1].set('package','other.app')
            if mode=='changed_second':second[1].set('text','请重新登录以领取奖励')
            with self.subTest(mode=mode),patch.object(sync,'focus',return_value=activity.replace('u0','u999') if mode=='wrong_user' else activity),patch.object(sync,'native_window_capture',return_value=first),patch.object(sync,'navigation_capture',return_value=second),patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
                with self.assertRaises(RuntimeError) as result:sync.confirm_logged_out('adb','serial',first,lambda:None,events)
                self.assertEqual('account is logged out' in str(result.exception),mode=='exact')
                adb.assert_not_called()
    def test_login_to_update_preflight_race_discards_tree_once_without_login_or_input(self):
        update=INDEX.replace('com.xingin.xhs.index.v2.IndexActivityV2','com.xingin.update.UpdateDialogActivity')
        fresh=ET.fromstring('<hierarchy><node package="com.xingin.xhs" text="免流量升级"/></hierarchy>')
        for mode in ('exact','before_read','during_read','repeated','foreign','wrong_user','cleanup_failed'):
            events=['collection_slot_requested:app1']
            if mode=='repeated':events.append('login_confirmation_update_recheck')
            current=update.replace('com.xingin.xhs/','other.app/') if mode=='foreign' else update.replace('u0','u999') if mode=='wrong_user' else update
            error=('native elements foreground changed during read' if mode=='during_read' else
                   'native elements foreground changed before read' if mode=='before_read' else
                   'native elements temporary file cleanup is unproven' if mode=='cleanup_failed' else
                   'native elements foreground changed before staging')
            with self.subTest(mode=mode),patch.object(sync,'focus',side_effect=[LOGIN,current]),patch.object(sync,'native_window_capture',side_effect=RuntimeError(error)),patch.object(sync,'navigation_capture',return_value=fresh) as capture,patch.object(sync,'adb') as adb:
                allowed=mode in ('exact','before_read','during_read')
                if allowed:self.assertIs(sync.confirm_logged_out('adb','serial',ET.Element('hierarchy'),lambda:None,events),fresh)
                else:
                    with self.assertRaises(RuntimeError):sync.confirm_logged_out('adb','serial',ET.Element('hierarchy'),lambda:None,events)
                self.assertEqual(capture.call_count,int(allowed));adb.assert_not_called()
    def test_honor_notification_uses_only_exact_decline_and_confirms_requested_app(self):
        root=ET.parse(ROOT/'fixtures/xhs/honor-notification-192.xml').getroot()
        current='mCurrentFocus=Window{x u0 com.hihonor.android.pushagent/com.hihonor.android.pushagent.activity.NotificationDialogForOverMagic6Activity}'
        state=[current];events=['collection_slot_requested:app1'];closed=login_tree()
        def command(_adb,_serial,*args,**kwargs):
            self.assertEqual(args[:3],('shell','input','tap'));state[0]=INDEX
        with patch.object(sync,'focus',side_effect=lambda *_:state[0]),patch.object(sync,'navigation_capture',return_value=closed),patch.object(sync,'adb',side_effect=command) as adb,patch.object(sync.time,'sleep'):
            self.assertTrue(sync.recover_known_overlay('adb','serial',root,lambda:None,events))
        adb.assert_called_once_with('adb','serial','shell','input','tap','305','2154',timeout=7)
        self.assertEqual(events[-1],'honor_notification_denied')
    def test_honor_notification_unknown_wrong_app_foreign_disabled_or_duplicate_never_acts(self):
        original=ET.parse(ROOT/'fixtures/xhs/honor-notification-192.xml').getroot()
        current='mCurrentFocus=Window{x u0 com.hihonor.android.pushagent/com.hihonor.android.pushagent.activity.NotificationDialogForOverMagic6Activity}'
        for mode in ('wrong_app','message','disabled','duplicate','foreign','wrong_user'):
            root=copy.deepcopy(original);focused=current
            button=next(n for n in root.iter('node') if n.get('resource-id')=='android:id/button2')
            if mode=='wrong_app':next(n for n in root.iter('node') if n.get('resource-id','').endswith('tvTitle')).set('text','是否允许“其他应用”发送通知？')
            if mode=='message':next(n for n in root.iter('node') if n.get('resource-id')=='android:id/message').set('text','访问通讯录')
            if mode=='disabled':button.set('enabled','false')
            if mode=='duplicate':root.append(copy.deepcopy(button))
            if mode=='foreign':button.set('package','other.app')
            if mode=='wrong_user':focused=focused.replace('u0','u999')
            with self.subTest(mode=mode),patch.object(sync,'focus',return_value=focused),patch.object(sync,'adb') as adb:
                try:result=sync.recover_known_overlay('adb','serial',root,lambda:None,['collection_slot_requested:app1'])
                except sync.ElementListReadError:pass
                else:self.assertFalse(result)
                adb.assert_not_called()
    def test_honor_notification_staying_open_stops_without_repeated_taps(self):
        root=ET.parse(ROOT/'fixtures/xhs/honor-notification-192.xml').getroot();current='mCurrentFocus=Window{x u0 com.hihonor.android.pushagent/com.hihonor.android.pushagent.activity.NotificationDialogForOverMagic6Activity}'
        with patch.object(sync,'focus',return_value=current),patch.object(sync,'navigation_capture',return_value=root),patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
            with self.assertRaisesRegex(sync.ElementListReadError,'remained after decline'):sync.recover_known_overlay('adb','serial',root,lambda:None,['collection_slot_requested:app1'])
        self.assertEqual(adb.call_count,1)
    def test_incomplete_login_stock_tree_needs_two_full_native_trees(self):
        for valid in (False,True):
            events=['collection_slot_requested:app1']
            def native(*_):
                events.append('native_window_elements_enabled');return login_tree() if valid else ET.Element('hierarchy')
            with patch.object(sync,'focus',return_value=LOGIN),patch.object(sync,'native_window_capture',side_effect=native),patch.object(sync,'navigation_capture',return_value=login_tree()) as second,patch.object(sync.time,'sleep'):
                with self.assertRaises(RuntimeError) as result:sync.confirm_logged_out('adb','serial',ET.Element('hierarchy'),lambda:None,events)
                self.assertEqual('account is logged out' in str(result.exception),valid)
                self.assertEqual(second.call_count,int(valid))
    def test_update_race_after_native_rejection_needs_exact_fresh_postcondition(self):
        update=INDEX.replace('com.xingin.xhs.index.v2.IndexActivityV2','com.xingin.update.UpdateDialogActivity')
        profile=ET.fromstring('<hierarchy><node package="com.xingin.xhs" content-desc="我" selected="true" bounds="[0,0][40,40]"/><node package="com.xingin.xhs" content-desc="菜单" bounds="[0,50][40,90]"/></hierarchy>')
        for detail in ('own profile menu unproven','profile query is ambiguous','native action rejected'):
            error=RuntimeError('native navigation command failed: native_navigation_unproven:IllegalStateException:'+detail)
            states=[INDEX,update,INDEX,INDEX] if detail=='native action rejected' else [INDEX,update,INDEX]
            with patch.object(sync,'focus',side_effect=states),patch.object(sync,'navigation_capture',return_value=profile),patch.object(sync,'recover_known_overlay',return_value=True),patch.object(sync,'assert_no_poco'),patch('xhs_native_navigation.perform',side_effect=[error,None]) as action:
                sync.native_index_navigation('menu','adb','serial',lambda:None,['collection_slot_requested:app1'])
                self.assertEqual(action.call_count,2)
        error=RuntimeError('native navigation command failed: native_navigation_unproven:IllegalStateException:native action rejected')
        with patch.object(sync,'focus',side_effect=[INDEX,update,INDEX]),patch.object(sync,'navigation_capture',return_value=login_tree()),patch.object(sync,'recover_known_overlay',return_value=True),patch.object(sync,'assert_no_poco'),patch('xhs_native_navigation.perform',side_effect=error) as action:
            with self.assertRaisesRegex(sync.ElementListReadError,'postcondition is unproven'):sync.native_index_navigation('menu','adb','serial',lambda:None,['collection_slot_requested:app1'])
            action.assert_called_once()
    def test_observed_vivo_store_detail_only_backs_to_requested_xhs_slot(self):
        current='mCurrentFocus=Window{x u0 com.bbk.appstore/com.bbk.appstore.ui.details.AppDetailActivity}'
        root=ET.fromstring('<hierarchy><node package="com.bbk.appstore" resource-id="com.bbk.appstore:id/package_detail_title" text="丰巢" bounds="[0,200][200,280]"/><node package="com.bbk.appstore" resource-id="com.bbk.appstore:id/originui_vtoolbar_navigation_view_btn_rom14_0" content-desc="返回" class="android.widget.ImageButton" enabled="true" clickable="true" bounds="[12,82][104,174]"/></hierarchy>')
        for foreign in (False,True):
            events=['collection_slot_requested:app1','xhs_cold_started']
            with patch.object(sync,'focus',side_effect=[current,INDEX.replace('u0','u999') if foreign else INDEX]),patch.object(sync,'adb',side_effect=['VIVO','']) as adb,patch.object(sync.time,'sleep'):
                if foreign:
                    with self.assertRaisesRegex(RuntimeError,'requested slot'):sync.recover_vivo_store_detail('adb','serial',root,'app1',current,lambda:None,events)
                else:self.assertTrue(sync.recover_vivo_store_detail('adb','serial',root,'app1',current,lambda:None,events))
                self.assertEqual(adb.call_args.args[2:],('shell','input','keyevent','4'))
    def test_update_before_native_navigation_is_deferred_then_single_action(self):
        update=INDEX.replace('com.xingin.xhs.index.v2.IndexActivityV2','com.xingin.update.UpdateDialogActivity')
        with patch.object(sync,'focus',side_effect=[update,INDEX]),patch.object(sync,'navigation_capture',return_value=login_tree()),patch.object(sync,'recover_known_overlay',return_value=True) as defer,patch.object(sync,'assert_no_poco'),patch('xhs_native_navigation.perform') as action:
            events=['collection_slot_requested:app1'];sync.native_index_navigation('menu','adb','serial',lambda:None,events)
            action.assert_called_once();defer.assert_called_once()
            self.assertIn('native_navigation_update_before_action',events)
    def test_unknown_native_action_outcome_or_cleanup_is_never_replayed(self):
        for error in ('native navigation action result is unproven','native navigation temporary file cleanup is unproven',
                      'native navigation command failed: native_navigation_unproven:IllegalStateException:native action rejected'):
            with patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'assert_no_poco'),patch('xhs_native_navigation.perform',side_effect=RuntimeError(error)) as action,patch.object(sync,'recover_known_overlay') as defer:
                with self.assertRaisesRegex(RuntimeError,'native navigation'):sync.native_index_navigation('menu','adb','serial',lambda:None,['collection_slot_requested:app1'])
                action.assert_called_once();defer.assert_not_called()
    def test_observed_login_copy_requires_two_matching_fresh_slot_trees(self):
        events=['collection_slot_requested:app1']
        with patch.object(sync,'focus',return_value=LOGIN),patch.object(sync,'capture',return_value=login_tree()) as read,patch.object(sync.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'account is logged out'):
                sync.confirm_logged_out('adb','serial',login_tree(),lambda:None,events)
        read.assert_called_once();self.assertIn('login_state_confirmed:login_controls',events)
    def test_new_login_copy_does_not_prove_wrong_slot_partial_or_changed_tree(self):
        for mode in ('wrong_slot','missing_controls','changed_second_tree'):
            root=login_tree();fresh=login_tree();focus=LOGIN
            if mode=='wrong_slot':focus=LOGIN.replace('u0','u999')
            if mode=='missing_controls':root.remove(list(root)[1])
            if mode=='changed_second_tree':fresh=ET.Element('hierarchy')
            events=['collection_slot_requested:app1']
            with self.subTest(mode=mode),patch.object(sync,'focus',return_value=focus),patch.object(sync,'capture',return_value=fresh),patch.object(sync.time,'sleep'):
                with self.assertRaises(RuntimeError) as result:
                    sync.confirm_logged_out('adb','serial',root,lambda:None,events)
                self.assertNotIn('account is logged out',str(result.exception))
                self.assertFalse(any(e.startswith('login_state_confirmed:') for e in events))
    def test_detailed_offline_copy_is_confirmed_but_a_changed_account_body_is_not(self):
        root=ET.Element('hierarchy')
        body='你的小红书账号测试昵称于2026-10-21 14:26:04在其他设备vivo V2357A登录。该账号的在线设备数量已达上限，本设备将自动退出登录'
        for i,text in enumerate(('账号下线通知',body,'重新登录')):
            ET.SubElement(root,'node',{'package':sync.XHS_PACKAGE,'text':text,'bounds':f'[0,{i*80}][200,{i*80+70}]'})
        current=LOGIN.replace('halfwelcome.HalfWelcomeActivity','device.offline.DeviceOfflineRemindActivity')
        for changed in (False,True):
            fresh=copy.deepcopy(root)
            if changed:list(fresh)[1].set('text',body.replace('测试昵称','另一个测试昵称'))
            with self.subTest(changed=changed),patch.object(sync,'focus',return_value=current),patch.object(sync,'capture',return_value=fresh),patch.object(sync.time,'sleep'):
                with self.assertRaises(RuntimeError) as result:sync.confirm_logged_out('adb','serial',root,lambda:None,['collection_slot_requested:app1'])
                self.assertEqual('account is logged out' in str(result.exception),not changed)
    def test_one_key_profile_requires_selected_me_terms_and_enabled_alternative(self):
        root=ET.Element('hierarchy')
        for i,text in enumerate(('登录后展示自己','一键登录','其他登录方式','我已阅读并同意《用户协议》《隐私政策》《未成年人个人信息保护规则》')):
            ET.SubElement(root,'node',{'package':sync.XHS_PACKAGE,'text':text,'clickable':'true','enabled':'true','bounds':f'[0,{i*80}][200,{i*80+70}]'})
        profile=ET.SubElement(root,'node',{'package':sync.XHS_PACKAGE,'class':'android.view.ViewGroup','content-desc':'我','selected':'true','bounds':'[0,400][200,470]'})
        self.assertEqual(sync.login_element_evidence(root,INDEX,['collection_slot_requested:app1']),'login_controls')
        profile.set('selected','false');self.assertIsNone(sync.login_element_evidence(root,INDEX,['collection_slot_requested:app1']))
    def test_observed_50_likes_sheet_closes_only_exact_icon(self):
        root=ET.parse(ROOT/'fixtures/xhs/milestone-50-likes-58.xml').getroot()
        with patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'navigation_capture',return_value=ET.Element('hierarchy')),patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
            self.assertTrue(sync.recover_known_overlay('adb','serial',root,lambda:None,[]))
        adb.assert_called_once_with('adb','serial','shell','input','tap','686','905',timeout=7)
    def test_changed_milestone_subtitle_stays_fail_closed(self):
        root=ET.parse(ROOT/'fixtures/xhs/milestone-50-likes-58.xml').getroot()
        next(n for n in root.iter('node') if n.get('text')=='发笔记被更多人看见👀').set('text','unknown future offer')
        with patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'adb') as adb:
            with self.assertRaisesRegex(RuntimeError,'layout is not proven'):
                sync.recover_known_overlay('adb','serial',root,lambda:None,[])
        adb.assert_not_called()
    def test_honor_auto_download_confirmation_only_cancels(self):
        root=ET.parse(ROOT/'fixtures/xhs/honor-auto-download-confirm-192.xml').getroot();events=[]
        with patch.object(sync,'focus',return_value=HONOR),patch.object(sync,'navigation_capture',return_value=ET.Element('hierarchy')),patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
            self.assertTrue(sync.recover_known_overlay('adb','serial',root,lambda:None,events))
        adb.assert_called_once_with('adb','serial','shell','input','tap','305','2154',timeout=7)
        self.assertEqual(events,['honor_auto_download_cancelled'])
    def test_honor_unknown_foreign_disabled_or_duplicate_cancel_never_taps(self):
        original=ET.parse(ROOT/'fixtures/xhs/honor-auto-download-confirm-192.xml').getroot()
        for mode in ('foreign','disabled','duplicate','message_changed','wrong_user'):
            root=copy.deepcopy(original);cancel=next(n for n in root.iter('node') if n.get('resource-id')=='android:id/button3');focus=HONOR
            if mode=='foreign':cancel.set('package','foreign.app')
            if mode=='disabled':cancel.set('enabled','false')
            if mode=='duplicate':root.append(copy.deepcopy(cancel))
            if mode=='message_changed':next(n for n in root.iter('node') if n.get('resource-id')=='android:id/message').set('text','install now')
            if mode=='wrong_user':focus=HONOR.replace('u0','u999')
            with self.subTest(mode=mode),patch.object(sync,'focus',return_value=focus),patch.object(sync,'adb') as adb:
                with self.assertRaises(RuntimeError):sync.recover_known_overlay('adb','serial',root,lambda:None,[])
                adb.assert_not_called()
    def test_honor_second_confirmation_after_defer_is_handled_once(self):
        primary=ET.Element('hierarchy')
        for text in ('软件更新','下载并安装','稍后'):
            ET.SubElement(primary,'node',{'package':'com.hihonor.ouc','text':text,'clickable':'true','enabled':'true','bounds':'[100,2100][980,2300]'})
        secondary=ET.parse(ROOT/'fixtures/xhs/honor-auto-download-confirm-192.xml').getroot();events=[]
        with patch.object(sync,'focus',return_value=HONOR),patch.object(sync,'navigation_capture',side_effect=[secondary,ET.Element('hierarchy')]),patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
            self.assertTrue(sync.recover_known_overlay('adb','serial',primary,lambda:None,events))
        self.assertEqual(adb.call_count,2);self.assertEqual(events,['honor_auto_download_cancelled','honor_update_deferred'])

if __name__=='__main__':unittest.main()
