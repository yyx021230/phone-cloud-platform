"""Local runner integration with simulated device I/O; never a real phone test."""
import json
import sys
import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import alipay_name_lookup as lookup

HOME='mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/com.eg.android.AlipayGphone.AlipayLogin}'
USB='mCurrentFocus=Window{x u0 com.coloros.securepay/.Warning}'
SEARCH='mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}'
def tree(*texts):
    root=ET.Element('hierarchy')
    for text in texts: ET.SubElement(root,'node',{'text':text})
    return root

def usb_flow(after='home', ignore_id='android:id/button2'):
    r=lookup.Runner({'serial':'SYNTHETIC','accountCooldownProtocol':1})
    state={'page':'usb','commands':[]}
    root=tree()
    for text,rid,bounds in [(lookup.COLOROS_USB_TRANSFER_TITLE,'com.coloros.securepay:id/alertTitle','[0,0][500,100]'),(lookup.COLOROS_REMOTE_CONTROL_RISK,'com.coloros.securepay:id/tv_message','[0,100][500,200]'),('忽略',ignore_id,'[0,200][200,300]'),('仅充电','android:id/button1','[200,200][400,300]')]:
        ET.SubElement(root,'node',{'text':text,'resource-id':rid,'package':lookup.COLOROS_SECUREPAY_PACKAGE,'bounds':bounds,'clickable':'true','enabled':'true'})
    def adb(args,**kwargs):
        state['commands'].append(args)
        if args==['shell','input','tap','100','250']: state['page']=after
        else: raise AssertionError('Unexpected device command '+repr(args))
        return ''
    r.adb=adb
    r.focus=lambda **kw:[USB if state['page']=='usb' else HOME if state['page'] in ('home','settings') else 'mCurrentFocus=null']
    r.focus_state=lambda:([],r.focus()[0],lookup.ALIPAY_PACKAGE)
    r.dismiss_honor_software_update_overlay=lambda *a:False
    r.dismiss_vivo_wlan_risk_overlay=lambda *a:False
    r.dismiss_vivo_usb_mode_dialog=lambda:False
    r.dismiss_phone_credit_promo_xml=lambda *a:False
    r.dismiss_real_name_prompt_xml=lambda *a:False
    def dump(token,*a,**kw):
        if state['page']=='usb':return root,{}
        x=tree();ET.SubElement(x,'node',{'text':'我的','resource-id':lookup.TAB_DESCRIPTION_ID})
        if state['page']=='settings':ET.SubElement(x,'node',{'content-desc':'设置','resource-id':lookup.SETTINGS_ENTRY_ID})
        return x,{}
    r.dump=dump
    r.dismiss_canvas_real_name_prompt=lambda *a:False
    r.launch=lambda *a:None
    r.open_search=lambda *a:state.update(page='query_ready')
    def picker(token):
        r.enter_my_settings(token)
        assert state['page']=='picker'
        return [('synthetic-account',True,ET.Element('node'))]
    r.open_account_picker=picker
    def tap(root,parent,action,**kw):
        assert state['page']!='usb'
        if action=='open_my_tab':state['page']='settings'
        if action=='open_settings':state['page']='picker'
    r.tap_unique=tap
    clock=[100.]
    with mock.patch.object(lookup.time,'time',side_effect=lambda:clock[0]),mock.patch.object(lookup.time,'sleep',side_effect=lambda s:clock.__setitem__(0,clock[0]+s)):
        result=r.prepare_available_account()
    assert state['page']=='query_ready'
    assert state['commands']==[['shell','input','tap','100','250']]
    assert not any('restrict' in e['step'] for e in r.log)
    return {'closed':True,'continuedToSettings':True,'accountPrepared':result,'commands':len(state['commands']),'steps':[e['step'] for e in r.log]}

def resume_flow(editable_length=0, observation_only=False, phone='19900000000', named=True):
    r=lookup.Runner({'serial':'SYNTHETIC','taskId':'runner-bridge'})
    node=mock.Mock();state={'written':False,'inputCalls':0}
    node.attr=lambda key: phone if state['written'] else '推荐搜索5元话费'
    poco=mock.Mock();poco.freeze.return_value=object()
    r.focus=lambda **kw:[SEARCH]
    r.poco_nodes=lambda *a,**kw:[node]
    r.poco_text=lambda n:n.attr('text')
    r.poco_raise_if_account_restricted=lambda *a,**kw:None
    r.poco_raise_if_login_required=lambda *a,**kw:None
    r.poco_verification_evidence=lambda *a:None
    r.poco_tap=lambda n:None
    r.poco_observe_result_transition=lambda *a:None
    r.wait_before_phone_input=lambda *a:None
    r.focused_search_input_length=lambda:editable_length
    r.parse_poco_result=lambda *a:({'alipayDisplayName':'测试(*甲)' if named else '', 'realNameTailCharacter':'甲' if named else '', 'notFound':not named} if state['written'] else None)
    r.poco_visual_result_readonly=mock.Mock(side_effect=RuntimeError('local_lookup_result_unconfirmed:input_changed'))
    def adb(args,**kw):
        if args==['shell','input','keyevent','123']:return ''
        assert args==['shell','input','keyevent',*[str(7+int(n)) for n in phone]]
        state['written']=True;state['inputCalls']+=1
        return ''
    r.adb=adb;clock=[100.]
    with mock.patch.object(lookup.time,'time',side_effect=lambda:clock[0]),mock.patch.object(lookup.time,'sleep',side_effect=lambda s:clock.__setitem__(0,clock[0]+s)):
        result=r.query_once_poco(poco,phone,resume_after_input=True,observation_only_resume=observation_only)
    assert state['inputCalls']==1
    return {'result':result,'name':result['alipayDisplayName'],'inputCalls':state['inputCalls'],'steps':[e['step'] for e in r.log]}

class FlowTests(unittest.TestCase):
    def test_real_overlay_handler_and_account_navigation_continue(self):
        self.assertTrue(usb_flow()['continuedToSettings'])
    def test_button3_native_ignore_continues_original_account_prepare(self):
        self.assertTrue(usb_flow(ignore_id='android:id/button3')['continuedToSettings'])
    def test_unknown_focus_after_click_is_not_success(self):
        with self.assertRaisesRegex(RuntimeError,'dismiss_timeout'):usb_flow('unknown')
    def test_placeholder_is_recovered_only_with_zero_editable_content(self):
        self.assertEqual(resume_flow()['inputCalls'],1)
    def test_nonempty_editable_content_never_overwritten(self):
        for length in [3,11,None]:
            with self.subTest(length=length),self.assertRaisesRegex(RuntimeError,'state_mismatch'):resume_flow(length)
    def test_observation_resume_remains_read_only(self):
        with self.assertRaisesRegex(RuntimeError,'input_changed'):resume_flow(observation_only=True)
    def risk_runner(self,after):
        from test_lookup_account_cooldown import AccountCooldownTests
        r=AccountCooldownTests().runner();risk=tree(lookup.DEVICE_RISK_TITLE,lookup.DEVICE_RISK_HINT)
        r.dump=mock.Mock(side_effect=[(risk,{}),(after,{})])
        r.focus_state=mock.Mock(return_value=([],SEARCH,lookup.ALIPAY_PACKAGE))
        return r
    def test_risk_back_retains_restriction_until_current_account_is_verified(self):
        r=self.risk_runner(tree('我的'))
        with mock.patch.object(lookup.time,'sleep',return_value=None),self.assertRaisesRegex(RuntimeError,'restriction_before_search:device_risk'):r.prepare_available_account()
        self.assertEqual(r.current_account(),'A');r.switch_account.assert_not_called()
        r.adb.assert_called_once_with(['shell','input','keyevent','4'],timeout=5)
        r.open_search.assert_not_called()
        event=r.emit.call_args.kwargs
        self.assertEqual(event['currentAccount'],'A');self.assertTrue(event['accountIdentityVerified'])
        self.assertEqual(event['reason'],'device_risk');self.assertFalse(event['phoneQueryStarted'])
        self.assertTrue(event['accountSwitchRequired']);r.open_account_picker.assert_called_once()
    def test_risk_unknown_picker_does_not_attribute_cooldown(self):
        r=self.risk_runner(tree('我的'));r.open_account_picker.side_effect=RuntimeError('alipay_saved_account_current_unverified')
        with mock.patch.object(lookup.time,'sleep',return_value=None),self.assertRaisesRegex(RuntimeError,'current_unverified'):r.prepare_available_account()
        r.open_search.assert_not_called();r.switch_account.assert_not_called()
        self.assertFalse(any(call.args and call.args[0]=='alipay_account_restriction_detected' for call in r.emit.call_args_list))
    def test_risk_already_cooling_keeps_original_clock_and_uses_verified_picker(self):
        r=self.risk_runner(tree('我的'));r.payload['accountCooldowns']=[{'account':'A','cooldownUntil':'2099-01-01T00:00:00Z'}]
        with mock.patch.object(lookup.time,'sleep',return_value=None):r.prepare_available_account()
        r.switch_account.assert_called_once_with(reason='cooldown',excluded_accounts={'A'},reuse_open_picker=True,verify_current_marker=True)
        self.assertFalse(any(call.args and call.args[0]=='alipay_account_restriction_detected' for call in r.emit.call_args_list))
    def test_risk_all_accounts_cooling_does_not_open_search(self):
        r=self.risk_runner(tree('我的'));r.payload['accountCooldowns']=[{'account':a,'cooldownUntil':'2099-01-01T00:00:00Z'} for a in ['A','B']]
        with mock.patch.object(lookup.time,'sleep',return_value=None),self.assertRaisesRegex(RuntimeError,'no_available_account'):r.prepare_available_account()
        r.open_search.assert_not_called();r.switch_account.assert_not_called()
    def test_risk_persists_no_loop_and_no_account_cooldown(self):
        r=self.risk_runner(tree(lookup.DEVICE_RISK_TITLE,lookup.DEVICE_RISK_HINT))
        with mock.patch.object(lookup.time,'sleep',return_value=None),self.assertRaisesRegex(RuntimeError,'alipay_startup_device_risk'):r.prepare_available_account()
        self.assertEqual(r.adb.call_count,1);r.switch_account.assert_not_called();r.open_account_picker.assert_not_called()
    def test_risk_back_captcha_enters_manual_flow(self):
        r=self.risk_runner(tree(lookup.VERIFICATION_TITLE,lookup.JIGSAW_VERIFICATION_ACTION))
        with mock.patch.object(lookup.time,'sleep',return_value=None),self.assertRaisesRegex(RuntimeError,'human_verification_required'):r.prepare_available_account()
        r.open_account_picker.assert_not_called()
    def test_risk_foreign_focus_no_back(self):
        r=self.risk_runner(tree());r.focus_state.return_value=([],'mCurrentFocus=Window{x u0 other.app/.Page}','other.app')
        with self.assertRaisesRegex(RuntimeError,'alipay_startup_device_risk'):r.prepare_available_account()
        r.adb.assert_not_called()

if __name__=='__main__':
    if '--bridge-usb' in sys.argv:print(json.dumps(usb_flow()))
    elif '--bridge-resume' in sys.argv:print(json.dumps(resume_flow(phone=sys.argv[sys.argv.index('--phone')+1] if '--phone' in sys.argv else '19900000000',named='--empty' not in sys.argv)))
    else:unittest.main()
