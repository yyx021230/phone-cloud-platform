"""Offline compatibility cases derived from 157 native UI; no device calls."""
from dataclasses import replace
import unittest
import wecom_invite_preview as w
from test_wecom_invite_preview import HOME,PHONE,Poco

NEW_MENU='com.tencent.wework:id/o70'
BUTTON=w.Node('android.widget.TextView',name=NEW_MENU,position=(.9333333333333333,.075),size=(.13333333333333333,.06))
NEW_HOME=replace(HOME,nodes=HOME.nodes[:-1]+(BUTTON,w.Node('android.widget.TextView',name='com.tencent.wework:id/o73',position=(.968,.062))))

class NewMenuTests(unittest.TestCase):
 def test_observed_new_build_unlabeled_plus_is_supported(self):
  for name in (NEW_MENU,'com.tencent.wework:id/ns5','com.tencent.wework:id/ns8','com.tencent.wework:id/n30','com.tencent.wework:id/nd7'):
   with self.subTest(resource=name):
    button=replace(BUTTON,name=name)
    page=replace(NEW_HOME,nodes=tuple(button if n==BUTTON else n for n in NEW_HOME.nodes))
    self.assertEqual(w.resolve_action('open_menu',page,PHONE),button)
 def test_legacy_menu_still_works(self):
  self.assertEqual(w.resolve_action('open_menu',HOME,PHONE),HOME.nodes[-1])
 def test_unknown_resource_type_geometry_and_disabled_are_rejected(self):
  for changed in (replace(BUTTON,name='com.tencent.wework:id/unknown'),replace(BUTTON,kind='android.view.View'),replace(BUTTON,position=(.5,.5)),replace(BUTTON,enabled=False),replace(BUTTON,visible=False),replace(BUTTON,text='unknown')):
   page=replace(NEW_HOME,nodes=tuple(changed if n==BUTTON else n for n in NEW_HOME.nodes))
   with self.assertRaises(w.StopPreview):w.resolve_action('open_menu',page,PHONE)
 def test_duplicate_or_missing_full_home_is_rejected(self):
  for page in (replace(NEW_HOME,nodes=NEW_HOME.nodes+(replace(BUTTON,position=(.9,.1)),)),replace(NEW_HOME,nodes=(BUTTON,))):
   with self.assertRaises(w.StopPreview):w.resolve_action('open_menu',page,PHONE)
 def test_actual_adapter_selects_exact_observed_resource(self):
  p=Poco(NEW_HOME);d=w.PocoPreviewDriver(p,lambda:w.PACKAGE,lambda:True)
  d.apply('open_menu',d.snapshot(),PHONE)
  self.assertEqual(p.effects,[('click','')])
 def test_changed_live_element_cannot_be_clicked(self):
  p=Poco(NEW_HOME);d=w.PocoPreviewDriver(p,lambda:w.PACKAGE,lambda:True);before=d.snapshot()
  p.screen=replace(NEW_HOME,nodes=NEW_HOME.nodes+(w.Node('android.widget.TextView',text='unexpected overlay'),))
  with self.assertRaises(w.StopPreview):d.apply('open_menu',before,PHONE)
  self.assertFalse(p.effects)


class SearchViewTests(unittest.TestCase):
 def test_searchview_path_keeps_exact_phone_and_profile_guards(self):
  from test_wecom_invite_preview import Device,PATH,PREVIEW,OTHER,frame,text
  empty=w.Node('android.widget.SearchView',name='com.tencent.wework:id/m0f',text='手机号',desc='手机号，搜索框，空白')
  typed=replace(empty,text=PHONE,desc='手机号，搜索框')
  path=PATH[:3]+[frame(empty),frame(typed,'网络查找手机/邮箱：'+PHONE)]+PATH[5:]
  d=Device(path);out=w.run_preview(d,{'phoneNumber':PHONE},sleep=lambda _:None)
  self.assertTrue(out['readyToSend']);self.assertEqual(d.calls.count('enter_phone'),1)
  d=Device(path[:4]+[frame(replace(typed,text=OTHER),'网络查找手机/邮箱：'+OTHER)]+path[5:])
  self.assertEqual(w.run_preview(d,{'phoneNumber':PHONE},sleep=lambda _:None)['code'],'phone_readback_mismatch')
  self.assertNotIn('search',d.calls)
 def test_unknown_searchview_and_duplicate_editors_are_rejected(self):
  from test_wecom_invite_preview import frame
  node=w.Node('android.widget.SearchView',name='unknown',text='手机号')
  with self.assertRaises(w.StopPreview):w.editor(frame(node))
  with self.assertRaises(w.StopPreview):w.editor(frame(replace(node,name='com.tencent.wework:id/m0f'),w.Node('android.widget.EditText',text='手机号')))
 def test_observed_searchview_input_uses_one_live_write_and_lost_lease_stops(self):
  from test_wecom_invite_preview import frame
  page=frame(w.Node('android.widget.SearchView',name='com.tencent.wework:id/m0f',text='手机号',desc='手机号，搜索框，空白'))
  p=Poco(page);d=w.PocoPreviewDriver(p,lambda:w.PACKAGE,lambda:True)
  d.apply('enter_phone',d.snapshot(),PHONE);self.assertEqual(p.effects,[('input',PHONE)])
  before=d.snapshot();d.lease_valid=lambda:False
  with self.assertRaises(w.StopPreview):d.apply('enter_phone',before,PHONE)
  self.assertEqual(p.effects,[('input',PHONE)])

class NetworkIndicatorTests(unittest.TestCase):
 def test_only_observed_status_speed_fields_are_filtered(self):
  for name,value in [('networkspeed_num','41.4'),('networkspeed_unit','KB/s')]:
   node=w.Node('android.widget.TextView',name='com.android.systemui:id/'+name,text=value,position=(.69,.02),size=(.06,.015))
   self.assertTrue(w.is_system_status_indicator(node))
   for changed in (replace(node,name='com.tencent.wework:id/'+name),replace(node,position=(.69,.3)),replace(node,desc='security overlay'),replace(node,text='unknown')):
    self.assertFalse(w.is_system_status_indicator(changed))

class AccountBoundaryTests(unittest.TestCase):
 def test_expired_login_and_colleague_verification_never_search(self):
  from test_wecom_invite_preview import Device,frame
  for value,code in [('登录失效，请重新登录。','login_required'),('同事辅助验证','human_required')]:
   d=Device([frame(value,'我知道了')]);out=w.run_preview(d,{'phoneNumber':PHONE},sleep=lambda _:None)
   self.assertEqual(out['code'],code);self.assertFalse(d.calls);self.assertFalse(out['invitationSent'])

class AddMenuBuildTests(unittest.TestCase):
 def test_observed_add_wechat_menu_uses_same_guarded_path(self):
  from test_wecom_invite_preview import Device,PATH,frame
  menu=frame('发起群聊','扫一扫',w.Node('android.widget.TextView',text='加微信',name='com.tencent.wework:id/ibi'))
  d=Device(PATH[:1]+[menu]+PATH[2:]);out=w.run_preview(d,{'phoneNumber':PHONE},sleep=lambda _:None)
  self.assertTrue(out['readyToSend']);self.assertEqual(d.calls.count('open_add'),1);self.assertFalse(out['invitationSent'])
  for bad in (frame('发起群聊','扫一扫','加好友'),frame('扫一扫','加微信'),frame('发起群聊','扫一扫','加微信','添加客户')):
   with self.assertRaises(w.StopPreview):w.resolve_action('open_add',bad,PHONE)

class AddPageBuildTests(unittest.TestCase):
 def test_external_contact_title_keeps_search_context_and_unique_action(self):
  from test_wecom_invite_preview import Device,PATH,frame
  page=frame('添加外部联系人','面对面添加','搜索手机号添加')
  d=Device(PATH[:2]+[page]+PATH[3:]);out=w.run_preview(d,{'phoneNumber':PHONE},sleep=lambda _:None)
  self.assertTrue(out['readyToSend']);self.assertEqual(d.calls.count('search'),1)
  for bad in (frame('添加外部联系人','搜索手机号添加'),frame('未知标题','面对面添加','搜索手机号添加'),frame('添加外部联系人','面对面添加','搜索手机号添加','搜索手机号添加')):
   with self.assertRaises(w.StopPreview):w.resolve_action('open_search',bad,PHONE)

class SavedProfileBuildTests(unittest.TestCase):
 def test_observed_saved_description_still_requires_phone_and_tag_context(self):
  import wecom_remark_preview as r
  from test_wecom_invite_preview import frame,text,OTHER
  for resource in w.OBSERVED_PROFILE_DESCRIPTIONS:
   page=frame('个人信息','电话',PHONE,'设置标签','添加为联系人',text('描述',name=resource))
   self.assertTrue(w.profile_matches(page,PHONE));self.assertFalse(w.profile_matches(page,OTHER))
   self.assertEqual(r.resolve_remark('open_remark',page,PHONE).name,resource)
   for changed in (replace(page,nodes=tuple(n for n in page.nodes if n.text!='设置标签')),replace(page,nodes=tuple(replace(n,name='unknown') if n.text=='描述' else n for n in page.nodes))):
    self.assertFalse(w.profile_matches(changed,PHONE))

class UntaggedProfileTests(unittest.TestCase):
 def test_145_profile_without_tags_requires_full_observed_bundle_and_phone(self):
  import wecom_remark_preview as r
  from test_wecom_invite_preview import frame,text,OTHER
  page=frame(PHONE,text('个人信息',name='com.tencent.wework:id/o64'),text('电话',name='com.tencent.wework:id/ldy'),text('描述',name='com.tencent.wework:id/cxu'),text('添加为联系人',name='com.tencent.wework:id/lm'))
  self.assertTrue(w.profile_matches(page,PHONE));self.assertFalse(w.profile_matches(page,OTHER))
  self.assertEqual(r.resolve_remark('open_remark',page,PHONE).name,'com.tencent.wework:id/cxu')
  for name in ('com.tencent.wework:id/o64','com.tencent.wework:id/ldy','com.tencent.wework:id/cxu','com.tencent.wework:id/lm'):
   bad=replace(page,nodes=tuple(replace(n,name='unknown') if n.name==name else n for n in page.nodes))
   self.assertFalse(w.profile_matches(bad,PHONE))
  self.assertFalse(w.profile_matches(replace(page,nodes=page.nodes+(text('描述',name='com.tencent.wework:id/cxu'),)),PHONE))

class RemarkBuildTests(unittest.TestCase):
 def translated(self,page,layout_index=1):
  import wecom_remark_preview as r
  mapping=dict(zip(r.REMARK_LAYOUTS[0],r.REMARK_LAYOUTS[layout_index]))
  return replace(page,nodes=tuple(replace(n,name=mapping.get(n.name,n.name)) for n in page.nodes))
 def driver(self,name='',description='添加更多备注信息',layout_index=1):
  from test_wecom_remark_preview import Driver
  d=Driver(name,description);d.pages=[self.translated(page,layout_index) for page in d.pages];return d
 def test_new_layout_defaults_and_persistence_use_same_real_resources(self):
  from test_wecom_remark_preview import run
  import wecom_remark_preview as r
  for layout_index in range(1,len(r.REMARK_LAYOUTS)):
   with self.subTest(layout=layout_index):
    d=self.driver(layout_index=layout_index);out=run(d)
    self.assertTrue(out['readyToSend']);self.assertTrue(out['remarkSaved'])
    self.assertEqual(d.calls.count('save_remark'),1);self.assertFalse(out['invitationSent'])
 def test_new_layout_preserves_existing_values_and_other_editors(self):
  from test_wecom_remark_preview import run
  d=self.driver('已有名字','已有描述');self.assertTrue(run(d)['readyToSend']);self.assertNotIn('save_remark',d.calls)
  d=self.driver();page=d.pages[7]
  d.pages[7]=replace(page,nodes=tuple(replace(n,text='企业变化') if n.name=='com.tencent.wework:id/d_f' else n for n in page.nodes))
  self.assertEqual(run(d)['code'],'remark_readback_mismatch');self.assertNotIn('save_remark',d.calls)
 def test_mixed_disabled_and_duplicate_layouts_cannot_write(self):
  import wecom_remark_preview as r
  from test_wecom_remark_preview import remark
  page=self.translated(remark());name=r.REMARK_LAYOUTS[1][0]
  for altered in (replace(page,nodes=tuple(replace(n,name=r.DESCRIPTION_ID) if n.name==r.REMARK_LAYOUTS[1][1] else n for n in page.nodes)),replace(page,nodes=page.nodes+(w.Node('android.widget.EditText',name=name),)),replace(page,nodes=tuple(replace(n,enabled=False) if n.name==name else n for n in page.nodes))):
   self.assertFalse(r.remark_page(altered))
   with self.assertRaises(w.StopPreview):r.resolve_remark('save_remark',altered,PHONE,r.RemarkContext(r.values(altered)))
 def test_new_live_adapter_lease_loss_prevents_any_save(self):
  import wecom_remark_preview as r
  from test_wecom_remark_preview import remark
  page=self.translated(remark());p=Poco(page);d=r.PocoRemarkDriver(p,lambda:w.PACKAGE,lambda:False)
  with self.assertRaises(w.StopPreview):d.apply('save_remark',page,PHONE,context=r.RemarkContext(r.values(page)))
  self.assertFalse(p.effects)

if __name__=='__main__':unittest.main()
