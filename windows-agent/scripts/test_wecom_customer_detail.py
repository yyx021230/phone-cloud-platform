"""Observed 23 layout, with synthetic target; no phone/SDK."""
import unittest
from dataclasses import replace
import wecom_invite_preview as w
import wecom_remark_preview as r
from test_wecom_invite_preview import PHONE,OTHER,PATH,HOME,MENU,ADD,EMPTY,TYPED,frame,text,Device,run,ACTIONS

CUSTOMER=frame(text('客户详情',name='com.tencent.wework:id/n26'),text('描述',name='com.tencent.wework:id/cii'),text('设置标签',name='com.tencent.wework:id/cii'),text('发消息',name='com.tencent.wework:id/bg6'),PHONE)

class CustomerDetailTests(unittest.TestCase):
    def test_exact_observed_customer_layout_recognized_only_for_exact_target(self):
        self.assertTrue(w.profile_matches(CUSTOMER,PHONE));self.assertFalse(w.profile_matches(CUSTOMER,OTHER))
    def test_fresh_home_to_query_returns_already_contact_without_invitation(self):
        device=Device([HOME,MENU,ADD,EMPTY,TYPED,CUSTOMER]);result=run(device)
        self.assertEqual(result['code'],'already_contact');self.assertFalse(result['invitationSent']);self.assertFalse(result['readyToSend']);self.assertEqual(device.calls,ACTIONS[:5])
    def test_existing_initial_profile_cannot_stand_in_for_a_new_query(self):
        device=Device([CUSTOMER]);self.assertEqual(run(device)['code'],'unsupported_start_page');self.assertFalse(device.calls)
    def test_wrong_target_or_loose_lookalike_does_not_open_preview(self):
        for page in (frame('客户详情','描述','设置标签','发消息',PHONE),replace(CUSTOMER,nodes=tuple(replace(n,text=OTHER)if n.text==PHONE else n for n in CUSTOMER.nodes)),replace(CUSTOMER,package='other'),replace(CUSTOMER,nodes=tuple(replace(n,text='199****0001')if n.text==PHONE else n for n in CUSTOMER.nodes))):
            self.assertFalse(w.profile_matches(page,PHONE))
    def test_layout_controls_must_be_unique_and_not_hidden_or_disabled(self):
        for page in (replace(CUSTOMER,nodes=CUSTOMER.nodes+(CUSTOMER.nodes[0],)),replace(CUSTOMER,nodes=tuple(replace(n,visible=False)if n.text=='发消息'else n for n in CUSTOMER.nodes)),frame(*CUSTOMER.nodes,w.Node('android.widget.EditText',text=PHONE))):
            self.assertFalse(w.profile_matches(page,PHONE))
    def test_already_contact_never_enters_remark_or_invitation_actions(self):
        with self.assertRaisesRegex(w.StopPreview,'already_contact'):w.resolve_action('open_preview',CUSTOMER,PHONE)
        with self.assertRaises(w.StopPreview):r.resolve_remark('open_remark',CUSTOMER,PHONE)

    def test_return_only_old_A_then_fresh_B_query_does_not_inherit_A_result(self):
        old=replace(CUSTOMER,nodes=tuple(replace(n,text=OTHER)if n.text==PHONE else n for n in CUSTOMER.nodes))
        back=[]
        self.assertTrue(w.return_from_customer_detail(old,snapshot=lambda:old,foreground=lambda:w.PACKAGE,back=lambda:back.append('back'),check_budget=lambda:None))
        self.assertEqual(back,['back']);self.assertFalse(w.profile_matches(old,PHONE))
        for frames,expected in (([HOME,MENU,ADD,EMPTY,TYPED,CUSTOMER],'already_contact'),(PATH,'stopped_before_send')):
            device=Device(frames);result=run(device);self.assertEqual(result['code'],expected)
            self.assertFalse(result['invitationSent']);self.assertEqual(device.calls[:5],ACTIONS[:5])
        stale=Device([old]);self.assertEqual(run(stale)['code'],'unsupported_start_page');self.assertFalse(stale.calls)
    def test_return_only_negative_contexts_do_not_press_back(self):
        invalid=[frame(*CUSTOMER.nodes,OTHER),frame(*CUSTOMER.nodes,w.Node('android.widget.EditText',text='手机号')),
            frame(*CUSTOMER.nodes,'拖动滑块'),replace(CUSTOMER,nodes=tuple(replace(n,text='199****0001')if n.text==PHONE else n for n in CUSTOMER.nodes)),
            replace(CUSTOMER,nodes=tuple(replace(n,name='com.tencent.wework:id/wrong')if n.text=='客户详情'else n for n in CUSTOMER.nodes))]
        for page in invalid:
            actions=[];self.assertFalse(w.return_from_customer_detail(page,snapshot=lambda:page,foreground=lambda:w.PACKAGE,back=lambda:actions.append('back'),check_budget=lambda:None));self.assertFalse(actions)
    def test_return_only_rechecks_frame_foreground_and_cancel_before_back(self):
        for snapshot,foreground,budget in ((lambda:HOME,lambda:w.PACKAGE,lambda:None),(lambda:CUSTOMER,lambda:'other',lambda:None),(lambda:CUSTOMER,lambda:w.PACKAGE,lambda:(_ for _ in ()).throw(w.StopPreview('cancelled')))):
            actions=[]
            with self.assertRaises(w.StopPreview):w.return_from_customer_detail(CUSTOMER,snapshot=snapshot,foreground=foreground,back=lambda:actions.append('back'),check_budget=budget)
            self.assertFalse(actions)

if __name__=='__main__':unittest.main()
