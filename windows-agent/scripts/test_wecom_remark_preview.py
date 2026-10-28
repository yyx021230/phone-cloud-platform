"""Offline remark safety/state tests. No device or network imports."""
from dataclasses import replace
import json
import unittest
import wecom_invite_preview as w
import wecom_remark_preview as r
from test_wecom_invite_preview import PHONE, OTHER, PATH, PROFILE, PREVIEW, Poco, frame, text


def remark(name='', description='添加更多备注信息'):
    return frame('设置备注和描述','备注名','企业','电话','描述','保存',
                 w.Node('android.widget.TextView', name=r.BACK_ID, position=(.05,.065)),
                 w.Node('android.widget.EditText', name=r.NAME_ID, text=name),
                 w.Node('android.widget.EditText', name='com.tencent.wework:id/d_f', text='添加企业名称'),
                 w.Node('android.widget.EditText', name='android.widget.EditText', text=PHONE),
                 w.Node('android.widget.EditText', name='android.widget.EditText', text='添加电话号码'),
                 w.Node('android.widget.EditText', name=r.DESCRIPTION_ID, text=description))


def scenario(name='', description='添加更多备注信息'):
    pages = PATH[:6] + [remark(name, description)]
    actions = ['open_menu','open_add','open_search','enter_phone','search','open_remark']
    final_name = r.DEFAULT_REMARK if name in r.EMPTY_VALUES[r.NAME_ID] else name
    final_desc = r.DEFAULT_DESCRIPTION if description in r.EMPTY_VALUES[r.DESCRIPTION_ID] else description
    if name in r.EMPTY_VALUES[r.NAME_ID]:
        pages.append(remark(final_name, description));actions.append('fill_remark')
    if description in r.EMPTY_VALUES[r.DESCRIPTION_ID]:
        pages.append(remark(final_name, final_desc));actions.append('fill_description')
    if (final_name,final_desc) != (name,description):
        pages += [PROFILE, remark(final_name,final_desc)]
        actions += ['save_remark','open_remark']
    pages += [PROFILE,PREVIEW];actions += ['close_remark','open_preview']
    return pages,actions


class Driver:
    def __init__(self, name='', description='添加更多备注信息'):
        self.pages,self.expected_actions = scenario(name,description)
        self.index=0;self.calls=[]
    def snapshot(self):return self.pages[self.index]
    def apply(self, action, expected, phone, check_budget, context=None):
        check_budget()
        if expected != self.snapshot():raise w.StopPreview('page_changed_before_action')
        if action in r.REMARK_ACTIONS:r.resolve_remark(action,expected,phone,context)
        else:w.resolve_action(action,expected,phone)
        if self.expected_actions[self.index] != action:raise AssertionError('unexpected mutation')
        self.calls.append(action);self.index+=1


def run(driver,**kwargs):
    return r.run_customer_preview(driver,{'phoneNumber':PHONE},sleep=lambda _:None,**kwargs)


class RemarkFlowTests(unittest.TestCase):
    def test_saved_description_profile_still_verifies_full_phone(self):
        saved = frame('个人信息','电话',PHONE,'设置标签','添加为联系人',
                      text('描述',name='com.tencent.wework:id/csu'))
        self.assertTrue(w.profile_matches(saved,PHONE))
        self.assertFalse(w.profile_matches(saved,OTHER))
        self.assertEqual(r.resolve_remark('open_remark',saved,PHONE).name,'com.tencent.wework:id/csu')
        unknown = replace(saved,nodes=tuple(replace(n,name='unknown') if n.text=='描述' else n for n in saved.nodes))
        self.assertFalse(w.profile_matches(unknown,PHONE))
        d=Driver();d.pages[9]=saved;d.pages[11]=saved
        self.assertTrue(run(d)['readyToSend'])

    def test_defaults_saved_reopened_verified_then_stop_before_send(self):
        d=Driver();out=run(d)
        self.assertTrue(out['readyToSend']);self.assertTrue(out['remarkSaved'])
        self.assertEqual(out['remarkSaveStatus'],'confirmed')
        self.assertEqual(d.calls,d.expected_actions)
        self.assertEqual(d.calls.count('save_remark'),1)
        self.assertEqual(d.calls.count('open_remark'),2)
        self.assertFalse(out['invitationSent']);self.assertEqual(d.snapshot(),PREVIEW)
        self.assertNotIn(PHONE,json.dumps(out));self.assertNotIn(r.DEFAULT_DESCRIPTION,json.dumps(out))

    def test_existing_values_preserved_and_no_redundant_save(self):
        for name,desc in [('已有备注','已有描述'),('已有备注','添加更多备注信息'),('', '已有描述')]:
            d=Driver(name,desc);out=run(d)
            self.assertTrue(out['readyToSend']);self.assertEqual(d.calls,d.expected_actions)
            self.assertEqual(out['remarkSaveStatus'],'not_needed' if name and desc=='已有描述' else 'confirmed')
            self.assertEqual('fill_remark' in d.calls,not name)
            self.assertEqual('fill_description' in d.calls,desc=='添加更多备注信息')

    def test_phone_company_and_all_other_editors_must_survive_readback(self):
        for key in ('android.widget.EditText','com.tencent.wework:id/d_f'):
            d=Driver();page=d.pages[7]
            d.pages[7]=replace(page,nodes=tuple(replace(n,text=OTHER) if n.name==key else n for n in page.nodes))
            out=run(d);self.assertEqual(out['code'],'remark_readback_mismatch')
            self.assertNotIn('save_remark',d.calls);self.assertFalse(out['readyToSend'])

    def test_bad_readback_no_second_write_or_save(self):
        d=Driver();page=d.pages[7]
        d.pages[7]=replace(page,nodes=tuple(replace(n,text='wrong') if n.name==r.NAME_ID else n for n in page.nodes))
        self.assertEqual(run(d)['code'],'remark_readback_mismatch')
        self.assertEqual(d.calls.count('fill_remark'),1);self.assertNotIn('save_remark',d.calls)

    def test_uncertain_save_is_never_replayed_or_claimed_saved(self):
        d=Driver();original=d.apply
        def fail(action,*args,**kwargs):
            if action=='save_remark':
                d.calls.append(action);raise RuntimeError('private '+PHONE)
            return original(action,*args,**kwargs)
        d.apply=fail;out=run(d)
        self.assertEqual(out['code'],'executor_error_no_replay');self.assertFalse(out['remarkSaved'])
        self.assertEqual(out['remarkSaveStatus'],'unknown');self.assertEqual(d.calls.count('save_remark'),1)
        self.assertNotIn('open_preview',d.calls);self.assertNotIn(PHONE,json.dumps(out))

    def test_persistence_not_proven_by_successful_navigation(self):
        d=Driver();d.pages[10]=remark()
        out=run(d);self.assertEqual(out['code'],'remark_persistence_unconfirmed')
        self.assertEqual(out['remarkSaveStatus'],'unknown');self.assertFalse(out['remarkSaved'])
        self.assertNotIn('open_preview',d.calls)

    def test_wrong_target_after_save_stops_before_reopening(self):
        d=Driver();d.pages[9]=frame('个人信息','设置备注和描述',OTHER,'添加为联系人')
        self.assertEqual(run(d)['code'],'profile_phone_mismatch')
        self.assertEqual(d.calls.count('open_remark'),1);self.assertNotIn('open_preview',d.calls)

    def test_unsupported_duplicate_editor_bounded_without_write(self):
        d=Driver();page=d.pages[6]
        d.pages[6]=replace(page,nodes=page.nodes+(w.Node('android.widget.EditText',name=r.NAME_ID),))
        out=run(d);self.assertEqual(out['code'],'remark_observation_budget_exhausted')
        self.assertNotIn('fill_remark',d.calls);self.assertNotIn('save_remark',d.calls)

    def test_cancellation_after_first_write_prevents_save(self):
        d=Driver();out=run(d,cancelled=lambda:'fill_remark' in d.calls)
        self.assertEqual(out['code'],'cancelled');self.assertNotIn('save_remark',d.calls)
        self.assertFalse(out['readyToSend'])

    def test_old_preview_cannot_be_reused_to_edit_someone_else(self):
        d=Driver();d.pages=[PREVIEW]
        self.assertEqual(run(d)['code'],'preview_target_unverified');self.assertFalse(d.calls)


class RemarkAdapterTests(unittest.TestCase):
    def test_actual_adapter_full_flow_with_synthetic_poco(self):
        pages,actions=scenario()
        class Advancing(Poco):
            def __call__(self,**selector):
                items=super().__call__(**selector)
                for item in items:
                    click,set_text=item.click,item.set_text
                    def do_click(original=click):
                        original();self.screen=pages[len(self.effects)]
                    def do_set(value,original=set_text):
                        original(value);self.screen=pages[len(self.effects)]
                    item.click,item.set_text=do_click,do_set
                return items
        p=Advancing(pages[0]);d=r.PocoRemarkDriver(p,lambda:w.PACKAGE,lambda:True)
        out=run(d);self.assertTrue(out['readyToSend']);self.assertTrue(out['remarkSaved'])
        self.assertEqual(len(p.effects),len(actions));self.assertFalse(any(v==w.SEND for _,v in p.effects))

    def test_live_lease_lost_page_changed_and_budget_expired_prevent_save(self):
        screen=remark(r.DEFAULT_REMARK,r.DEFAULT_DESCRIPTION)
        for mode in ('lease','page','budget'):
            p=Poco(screen);d=r.PocoRemarkDriver(p,lambda:w.PACKAGE,lambda:True)
            expected=d.snapshot();budget=lambda:None
            if mode=='lease':d.lease_valid=lambda:False
            if mode=='page':p.screen=PREVIEW
            if mode=='budget':
                def budget():raise w.StopPreview('timeout')
            with self.assertRaises(w.StopPreview):d.apply('save_remark',expected,PHONE,budget,context=r.RemarkContext(r.values(screen)))
            self.assertFalse(p.effects)

    def test_never_overwrite_nonempty_or_use_unknown_actions_or_send(self):
        screen=remark('已有备注','已有描述');context=r.RemarkContext(r.values(screen),r.DEFAULT_REMARK)
        for action in ('fill_remark','fill_description','send','发消息','tap'):
            with self.assertRaises(w.StopPreview):r.resolve_remark(action,screen,PHONE,context)
        for action in r.REMARK_ACTIONS:
            with self.assertRaises(w.StopPreview):r.resolve_remark(action,PREVIEW,PHONE,context)


if __name__=='__main__':unittest.main()
