"""Stateful device I/O simulation of shared mismatch recovery; no real ADB."""
import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock
import xml.etree.ElementTree as ET
import alipay_name_lookup as lookup

HOME='mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/com.eg.android.AlipayGphone.AlipayLogin}'
SEARCH='mCurrentFocus=Window{x u0 com.eg.android.AlipayGphone/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity}'
PHONE='19900000000'

def node(root, text='', desc='', rid='', bounds='[0,0][100,100]', **extra):
    return ET.SubElement(root,'node',{'text':text,'content-desc':desc,'resource-id':rid,'package':lookup.ALIPAY_PACKAGE,'bounds':bounds,'clickable':'true','enabled':'true',**extra})

def home():
    r=ET.Element('hierarchy')
    node(r,desc='搜索框',bounds='[100,50][600,150]')
    node(r,desc='首页',rid=lookup.TAB_SELECTED_FRAME_ID,selected='true')
    node(r,text='我的',rid=lookup.TAB_DESCRIPTION_ID,selected='false')
    return r

def popup(kind, background=True):
    r=home() if background else ET.Element('hierarchy')
    if kind=='real_name':
        node(r,text=lookup.ALIPAY_REAL_NAME_PROMPT_TITLE)
        node(r,text=lookup.ALIPAY_REAL_NAME_PROMPT_ACTION)
    if kind=='fullscreen_ad': node(r,desc='全屏广告')
    if kind in ('real_name','fullscreen_ad'):
        node(r,desc='关闭',bounds='[330,1220][390,1280]',**{'class':'android.widget.ImageView'})
    return r

def parents(r): return {c:p for p in r.iter() for c in p}

@contextlib.contextmanager
def clock():
    now=[100.]
    with mock.patch.object(lookup.time,'time',side_effect=lambda:now[0]),mock.patch.object(lookup.time,'monotonic',side_effect=lambda:now[0]),mock.patch.object(lookup.time,'perf_counter',side_effect=lambda:now[0]),mock.patch.object(lookup.time,'sleep',side_effect=lambda s:now.__setitem__(0,now[0]+s)):
        yield now

def fixture(kind='real_name',stage='search',sticky=False,after='normal'):
    r=lookup.Runner({'serial':'SYNTHETIC','taskId':'overlay-flow','accountCooldownProtocol':1})
    st={'page':'home','overlay':None,'fired':False,'inputs':0,'closes':0,'searchTaps':0,'accountSelections':0,'commands':[]}
    r.emit=lambda step,**d:r.log.append({'step':step,**d})
    r.focus_state=lambda:([],SEARCH if st['page']=='search' else HOME,lookup.ALIPAY_PACKAGE)
    r.focus=lambda **kw:[r.focus_state()[1]]
    r.display_size=lambda:(720,1600)
    r.dismiss_honor_software_update_overlay=lambda *a:False
    r.dismiss_vivo_wlan_risk_overlay=lambda *a:False
    r.dismiss_canvas_real_name_prompt=mock.Mock(return_value=False)
    r.launch=lambda *a:st.update(page='home')
    r.open_account_picker=lambda *a:[('synthetic-account',True,ET.Element('node'))]
    r.focused_search_input_ready=lambda:False
    r.clear_search_input=lambda *a:None
    r.wait_before_phone_input=lambda *a:None
    def dump(token, **options):
        if st['overlay']:
            root=popup(st['overlay'],background=st['page']=='home')
        elif st['page']=='search':
            root=ET.Element('hierarchy');node(root,rid=lookup.SEARCH_INPUT_ID,text=PHONE if st['inputs'] else '')
        else: root=home()
        if after=='login' and st['closes']:
            root=ET.Element('hierarchy')
            for t in ('短信验证码登录','其他验证方式','换号'):node(root,text=t)
        if after=='captcha' and st['closes']:
            root=ET.Element('hierarchy')
            for t in (lookup.VERIFICATION_TITLE,lookup.JIGSAW_VERIFICATION_ACTION):node(root,text=t)
        return root,parents(root)
    r.dump=dump
    def adb(args,**kw):
        st['commands'].append(args)
        if args==['shell','input','tap','360','1250']:
            st['closes']+=1
            if not sticky:st['overlay']=None
            return ''
        if args==['shell','input','tap','350','100']:
            st['searchTaps']+=1
            if stage=='search' and not st['fired']:
                st.update(overlay=kind,fired=True)
            elif not st['overlay']: st['page']='search'
            return ''
        raise AssertionError('Unexpected device command '+repr(args))
    r.adb=adb
    def input_phone(*a,**kw):
        st['inputs']+=1
        if stage=='input' and not st['fired']: st.update(overlay=kind,fired=True)
    r.input_phone_humanized=input_phone
    r.parse_result=lambda root,parent,phone:({'notFound':False,'alipayDisplayName':'测试(*甲)','realNameTailCharacter':'甲'} if st['inputs'] and not st['overlay'] else None)
    return r,st

def full_flow(kind='real_name',stage='search'):
    r,s=fixture(kind,stage)
    with clock():
        account=r.prepare_available_account()
        result=r.query_once(PHONE)
    assert s['closes']==1 and s['inputs']==1
    assert s['searchTaps']==(2 if stage=='search' else 1)
    assert s['accountSelections']==0
    assert any(e['step']=='page_mismatch_overlay_cleared' for e in r.log)
    return {'accountPrepared':account,'result':result,'overlay':kind,'stage':stage,'closeCount':s['closes'],'inputCount':s['inputs'],'searchTaps':s['searchTaps'],'replayedAccountSelection':False,'steps':[e['step'] for e in r.log]}

class OverlayGuardTests(unittest.TestCase):
    def test_late_realname_start_to_query(self): full_flow()
    def test_late_ad_start_to_query(self): full_flow('fullscreen_ad')
    def test_post_input_realname_same_number_once(self): full_flow(stage='input')
    def test_post_input_ad_same_number_once(self): full_flow('fullscreen_ad','input')
    def test_sticky_overlay_fails_without_second_close(self):
        r,s=fixture(sticky=True)
        with clock(),self.assertRaisesRegex(RuntimeError,'known_overlay_not_dismissed'):r.prepare_available_account()
        self.assertEqual(s['closes'],1);self.assertEqual(s['inputs'],0)
    def test_after_close_login_is_not_a_device_failure(self):
        r,s=fixture(after='login')
        with clock(),self.assertRaisesRegex(RuntimeError,'login_required'):r.prepare_available_account()
        self.assertEqual(s['closes'],1);self.assertEqual(s['inputs'],0)
    def test_after_close_captcha_stops_before_any_input(self):
        r,s=fixture(after='captcha')
        with clock(),self.assertRaisesRegex(RuntimeError,'human_verification_required'):r.prepare_available_account()
        self.assertEqual(s['closes'],1);self.assertEqual(s['inputs'],0)
    def test_normal_path_no_added_commands(self):
        r,s=fixture(stage='none')
        with clock():r.prepare_available_account();r.query_once(PHONE)
        self.assertEqual(s['commands'],[['shell','input','tap','350','100']])
    def test_unknown_close_is_never_clicked(self):
        r,s=fixture();root=ET.Element('hierarchy');node(root,desc='关闭',bounds='[330,1220][390,1280]')
        with clock():self.assertFalse(r.recover_page_mismatch('unknown',root=root,parent=parents(root)))
        self.assertFalse(s['commands'])
    def test_foreign_focus_never_dismisses(self):
        r,s=fixture();root=popup('real_name');r.focus_state=lambda:([],'mCurrentFocus=Window{x u0 other.app/.Main}',lookup.ALIPAY_PACKAGE)
        with clock():self.assertFalse(r.recover_page_mismatch('foreign',root=root,parent=parents(root)))
        self.assertFalse(s['commands'])
    def test_expected_background_node_is_not_tapped_through_ad(self):
        r,s=fixture();s['overlay']='fullscreen_ad';s['fired']=True
        with clock():r.open_search('covered')
        self.assertEqual(s['closes'],1);self.assertEqual(s['searchTaps'],1)
    def test_reappearance_not_clicked_twice(self):
        r,s=fixture();s['overlay']='real_name'
        with clock() as now:
            root,parent=r.dump('before');self.assertTrue(r.recover_page_mismatch('first',root=root,parent=parent))
            now[0]+=2;s['overlay']='real_name';root,parent=r.dump('again')
            with self.assertRaisesRegex(RuntimeError,'known_overlay_reappeared'):r.recover_page_mismatch('second',root=root,parent=parent)
        self.assertEqual(s['closes'],1)
    def test_captcha_has_priority_over_optional_ad(self):
        r,s=fixture();root=popup('fullscreen_ad')
        for t in (lookup.VERIFICATION_TITLE,lookup.JIGSAW_VERIFICATION_ACTION):node(root,text=t)
        with clock(),self.assertRaisesRegex(RuntimeError,'human_verification_required'):r.recover_page_mismatch('protected',root=root,parent=parents(root))
        self.assertFalse(s['commands'])
    def test_unknown_pages_are_bounded_without_closing(self):
        r,s=fixture();root=ET.Element('hierarchy');r.focus_state=mock.Mock(return_value=([],HOME,lookup.ALIPAY_PACKAGE))
        with clock():
            for _ in range(100):self.assertFalse(r.recover_page_mismatch('unknown',root=root,parent={}))
        self.assertEqual(r.focus_state.call_count,1);self.assertFalse(s['commands'])
    def test_element_read_failure_preserves_transport_error(self):
        r,s=fixture();poco=mock.Mock();poco.freeze.side_effect=RuntimeError('device offline')
        with clock(),self.assertRaisesRegex(RuntimeError,'device offline'):r.recover_page_mismatch('poco-missing',poco=poco)
        self.assertFalse(s['commands'])

class CanvasAndRaceTests(unittest.TestCase):
    def test_canvas_missing_elements_closes_through_shared_wait(self):
        r,st=fixture(kind="canvas_real_name")
        r.dismiss_canvas_real_name_prompt=lookup.Runner.dismiss_canvas_real_name_prompt.__get__(r)
        previous_adb=r.adb
        def adb(args,**kw):
            if args==['exec-out','screencap','-p']:return b'fixture-pixels'
            return previous_adb(args,**kw)
        r.adb=adb
        visible={'visible':True,'close':[360,1250]};gone={'visible':False,'close':None}
        def image(raw):return visible if st['overlay'] else gone
        with clock(),mock.patch.object(lookup,'real_name_canvas_evidence',side_effect=image):
            account=r.prepare_available_account();result=r.query_once(PHONE)
        self.assertEqual(st['closes'],1);self.assertEqual(st['inputs'],1)
        self.assertTrue(account['accountIdentityVerified']);self.assertEqual(result['realNameTailCharacter'],'甲')
    def test_repeated_unreadable_tree_uses_exact_canvas_then_continues(self):
        r,st=fixture();r.dismiss_canvas_real_name_prompt=mock.Mock(return_value=True)
        target=home();sequence=[RuntimeError('uiautomator_hierarchy_missing'),RuntimeError('uiautomator_hierarchy_missing'),(target,parents(target)),(target,parents(target))]
        r.dump=mock.Mock(side_effect=sequence)
        with clock():r.wait_unique('blocked-tree',text='我的')
        r.dismiss_canvas_real_name_prompt.assert_called_once_with(None,'blocked-tree')
        self.assertEqual(st['inputs'],0);self.assertEqual(st['searchTaps'],0)
    def test_new_captcha_between_detection_and_close_no_click(self):
        r,st=fixture();st['overlay']='real_name';old=r.dump
        def dump(token, **options):
            root,parent=old(token)
            if token=='overlay-mismatch-confirm':
                node(root,text=lookup.VERIFICATION_TITLE);node(root,text=lookup.JIGSAW_VERIFICATION_ACTION)
            return root,parents(root)
        r.dump=dump;root,parent=old('initial')
        with clock(),self.assertRaisesRegex(RuntimeError,'human_verification_required'):
            r.recover_page_mismatch('late',root=root,parent=parent)
        self.assertEqual(st['closes'],0)
    def test_account_rows_covered_by_ad_are_reobserved_without_reopening(self):
        from test_lookup_account_picker_transition import tree
        r,st=fixture();st['overlay']='fullscreen_ad'
        def dump(token, **options):
            root=tree(action=False)
            if st['overlay']:
                node(root,desc='全屏广告');node(root,desc='关闭',bounds='[330,1220][390,1280]')
            return root,parents(root)
        r.dump=dump
        with clock():rows=r.wait_account_picker('covered-list')
        self.assertEqual(len(rows),2);self.assertEqual(st['closes'],1)
        self.assertEqual(st['searchTaps'],0);self.assertEqual(st['inputs'],0)
    def test_missing_xml_does_not_become_cooldown(self):
        r,st=fixture();r.dump=mock.Mock(side_effect=RuntimeError('uiautomator_hierarchy_missing'))
        with clock(),self.assertRaisesRegex(RuntimeError,'uiautomator_hierarchy_missing'):
            r.recover_page_mismatch('empty')
        self.assertEqual(st['closes'],0);self.assertFalse(r.restricted_accounts)
    def test_confirmation_uses_new_close_coordinates(self):
        r,st=fixture();st['overlay']='real_name';old=r.dump
        def dump(token, **options):
            root,parent=old(token)
            if token=='overlay-mismatch-confirm':
                for n in root.iter('node'):
                    if n.get('content-desc')=='关闭':n.set('bounds','[332,1222][392,1282]')
            return root,parents(root)
        old_adb=r.adb
        def adb(args,**kw):
            if args==['shell','input','tap','362','1252']:
                st['freshClose']=True;return old_adb(['shell','input','tap','360','1250'],**kw)
            return old_adb(args,**kw)
        r.dump=dump;r.adb=adb;root,parent=old('initial')
        with clock():self.assertTrue(r.recover_page_mismatch('fresh',root=root,parent=parent))
        self.assertTrue(st['freshClose'])

class PocoNode:
    def __init__(self,**attrs):self.attrs=attrs
    def attr(self,key):return self.attrs.get(key,'')
    def get_position(self):return self.attrs.get('position',(.5,.78))

class PocoGuardTests(unittest.TestCase):
    def runner(self,sticky=False):
        r=lookup.Runner({'serial':'SYNTHETIC'});s={'covered':True,'taps':0};r.emit=mock.Mock()
        r.focus_state=lambda:([],HOME,lookup.ALIPAY_PACKAGE)
        ad=PocoNode(desc='全屏广告');close=PocoNode(desc='关闭');target=PocoNode(name='target',position=(.2,.2))
        def freeze():return [ad,close] if s['covered'] else [target]
        class Poco:
            def freeze(self):return freeze()
            def __call__(self,**q):return target
        poco=Poco();r.poco_nodes=lambda snap,**q:[n for n in snap if all(n.attr(k)==v for k,v in q.items())]
        r.poco_snapshot_texts=lambda snap,limit:[n.attr('text') or n.attr('desc') for n in snap]
        r.poco_verification_evidence=lambda snap:None
        r.poco_tap=lambda n:(s.update(taps=s['taps']+1),s.update(covered=sticky))
        return r,poco,s,target
    def test_missing_target_reobserves_after_close(self):
        r,p,s,target=self.runner()
        with clock():self.assertIs(r.poco_unique(p,name='target',live=False),target)
        self.assertEqual(s['taps'],1)
    def test_poco_sticky_ad_does_not_loop(self):
        r,p,s,target=self.runner(True)
        with clock(),self.assertRaisesRegex(RuntimeError,'not_dismissed'):r.poco_unique(p,name='target')
        self.assertEqual(s['taps'],1)
    def test_poco_restriction_has_priority(self):
        r,p,s,target=self.runner();r.poco_raise_if_account_restricted=mock.Mock(side_effect=RuntimeError('poco_alipay_access_denied'))
        with clock(),self.assertRaisesRegex(RuntimeError,'access_denied'):r.poco_unique(p,name='target')
        self.assertEqual(s['taps'],0)
    def test_poco_login_has_priority(self):
        r,p,s,target=self.runner();r.poco_raise_if_login_required=mock.Mock(side_effect=RuntimeError('poco_alipay_login_required'))
        with clock(),self.assertRaisesRegex(RuntimeError,'login_required'):r.poco_unique(p,name='target')
        self.assertEqual(s['taps'],0)

if __name__=='__main__':
    if '--bridge' in sys.argv:
        index=int(sys.argv[sys.argv.index('--bridge')+1]);print(json.dumps(full_flow('real_name' if index%2 else 'fullscreen_ad','search' if index%3 else 'input'),ensure_ascii=False))
    else: unittest.main()
