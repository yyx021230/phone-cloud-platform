"""Public-profile ID accuracy: exact header evidence, two fresh reads, no login inference."""
import copy, importlib.util, unittest, xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call, patch
S=Path(__file__).parent
spec=importlib.util.spec_from_file_location('profile_sync',S/'小红书数据同步.py');sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
INDEX='mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}'
def tree(two=False):return ET.parse(S/'fixtures'/('xhs-profile-header-'+('two-tabs' if two else 'three-tabs')+'.xml')).getroot()
def events():return ['collection_slot_requested:app1']
def args():return SimpleNamespace(adb='adb',serial='serial',app_slot='app1',device_cache='cache',device_name='test',task_id='task',cancel_file='')
def login_tree():
 r=ET.Element('hierarchy')
 for i,text in enumerate(['登录后展示自己','微信登录','手机号登录']):
  ET.SubElement(r,'node',{'package':sync.XHS_PACKAGE,'class':'android.widget.TextView','text':text,'enabled':'true','bounds':f'[0,{100+i*60}][300,{150+i*60}]'})
 ET.SubElement(r,'node',{'package':sync.XHS_PACKAGE,'class':'android.view.ViewGroup','content-desc':'我','selected':'true','enabled':'true','bounds':'[0,1500][720,1600]'})
 return r
def milestone():return ET.parse(S/'fixtures/xhs/profile-milestone-500-likes-86.xml').getroot()
def notification():return ET.parse(S/'fixtures/xhs/profile-index-notification-71.xml').getroot()
class ProfileIdentityTests(unittest.TestCase):
 def test_oppo_system_prompt_uses_only_back_and_then_reads_own_profile_twice(self):
  ota='mCurrentFocus=Window{x u0 com.oplus.ota}'
  dump=ota+'\nmFocusedApp=ActivityRecord{y u0 com.xingin.xhs/.index.v2.IndexActivityV2} t202}'
  read_state=call('adb','serial','shell','dumpsys','window',timeout=8)
  back=call('adb','serial','shell','input','keyevent','4',timeout=7)
  dialog=ET.Element('hierarchy')
  for rid, title, kind in [('com.oplus.ota:id/alertTitle','发现系统新版本','TextView'),
                            ('com.oplus.ota:id/select_dialog_listview','','ListView'),
                            ('android:id/text1','下载并安装','TextView'), ('android:id/text1','稍后安装','TextView')]:
   ET.SubElement(dialog,'node',{'package':'com.oplus.ota','resource-id':rid,'text':title,
                                'class':'android.widget.'+kind,'enabled':'true','bounds':'[1,1][2,2]'})
  a=args(); ev=events()
  with patch.object(sync,'focus',side_effect=[ota,INDEX,INDEX,INDEX,INDEX,INDEX]),patch.object(sync,'navigation_capture',return_value=dialog),patch.object(sync,'native_window_capture',side_effect=[tree(),tree(),tree()]) as read,patch.object(sync.time,'sleep'),patch.object(sync,'adb',side_effect=[dump,dump,'']) as adb:
   sync.prove_profile_identity(a,tree(),Mock(),ev,'SYNTH_123')
   self.assertEqual(adb.call_args_list,[read_state,read_state,back])
   self.assertEqual(read.call_count,3)
   self.assertEqual(a.verified_account_identity['sample_count'],2)
  a.app_slot='app2'
  with patch.object(sync,'navigation_capture') as capture,patch.object(sync,'adb') as adb:
   self.assertIsNone(sync.recover_profile_system_prompt(a,ota,Mock(),[]))
   capture.assert_not_called();adb.assert_not_called()
  a.app_slot='app1'
  with patch.object(sync,'navigation_capture',return_value=dialog),patch.object(sync,'adb',side_effect=[dump,INDEX]) as adb:
   with self.assertRaisesRegex(sync.ElementListReadError,'foreground changed before Back'):
    sync.recover_profile_system_prompt(a,ota,Mock(),[])
   self.assertEqual(adb.call_args_list,[read_state,read_state])
  for invalid in (ota,dump.replace('com.xingin.xhs/','com.other/'),dump+'\n'+dump):
   with patch.object(sync,'navigation_capture') as capture,patch.object(sync,'adb',return_value=invalid) as adb:
    self.assertIsNone(sync.recover_profile_system_prompt(a,ota,Mock(),[]))
    self.assertEqual(adb.call_args_list,[read_state])
    capture.assert_not_called()
  for readings, error in ((['', ota, INDEX], None), ([ota]*4, 'did not return'),
                          ([INDEX.replace('u0','u999')], 'unexpected foreground')):
   with self.subTest(readings=readings),patch.object(sync,'focus',side_effect=readings),patch.object(sync,'navigation_capture',return_value=dialog),patch.object(sync,'native_window_capture',return_value=dialog) as capture,patch.object(sync.time,'sleep'),patch.object(sync,'adb',side_effect=[dump,dump,'']) as adb:
    if error is None:
     self.assertIs(sync.recover_profile_system_prompt(a,ota,Mock(),events()),dialog)
     capture.assert_called_once()
    else:
     with self.assertRaisesRegex(sync.ElementListReadError,error):
      sync.recover_profile_system_prompt(a,ota,Mock(),[])
     capture.assert_not_called()
    self.assertEqual(adb.call_args_list,[read_state,read_state,back])

 def test_clone_notification_back_only_for_exact_app_and_user(self):
  p='com.android.permissioncontroller'
  activity='.permission.ui.GrantPermissionsActivity'
  prompt=f'mCurrentFocus=Window{{a u999 {p}/{p}{activity} type=1}}'
  dump=prompt+f'\nmFocusedApp=ActivityRecord{{b u999 {p}/{activity} t1}}'
  dialog=ET.Element('hierarchy')
  for rid,title,kind in [('permission_message','“Ⅱ·小红书”请求向您发送通知','TextView'),
                          ('permission_allow_button','允许','Button'),
                          ('permission_deny_and_dont_ask_again_button','禁止且不再询问','Button')]:
   ET.SubElement(dialog,'node',{'package':p,'resource-id':p+':id/'+rid,'text':title,
                                'class':'android.widget.'+kind,'enabled':'true','bounds':'[1,1][2,2]'})
  a=args(); a.app_slot='app2'; ev=['collection_slot_requested:app2','clone_user_requested:999']; native=tree()
  with patch.object(sync,'focus',return_value=INDEX.replace('u0','u999')),patch.object(sync,'navigation_capture',return_value=dialog),patch.object(sync,'native_window_capture',return_value=native),patch.object(sync.time,'sleep'),patch.object(sync,'adb',side_effect=[dump,dump,'']) as adb:
   self.assertIs(sync.recover_profile_system_prompt(a,prompt,Mock(),ev),native)
   self.assertEqual(adb.call_args_list,[call('adb','serial','shell','dumpsys','window',timeout=8)]*2+
                    [call('adb','serial','shell','input','keyevent','4',timeout=7)])
  dialog[0].set('text','“Ⅱ·小红书”请求定位权限')
  with patch.object(sync,'navigation_capture',return_value=dialog) as capture,patch.object(sync,'adb',return_value=dump) as adb:
   self.assertIsNone(sync.recover_profile_system_prompt(a,prompt,Mock(),ev[:1]))
   capture.assert_not_called()
   adb.assert_not_called()
   self.assertIsNone(sync.recover_profile_system_prompt(a,prompt,Mock(),ev[:2]))
   capture.assert_called_once()
   adb.assert_called_once_with('adb','serial','shell','dumpsys','window',timeout=8)

 def test_known_notification_fresh_tree_closes_icon_not_confirmation_then_proves_profile(self):
  home=tree();home[-1].set('selected','false');ev=events();a=args();focus=INDEX.replace('.index.v2.IndexActivityV2','com.xingin.xhs.index.v2.IndexActivityV2')
  with patch.object(sync,'focus',return_value=focus),patch.object(sync,'native_window_capture',side_effect=[notification(),home,tree(),tree()]),patch.object(sync,'navigation_capture',return_value=home),patch.object(sync,'native_index_navigation') as nav,patch.object(sync.time,'sleep'),patch.object(sync,'adb') as adb:
   sync.prove_profile_identity(a,tree(),Mock(),ev,'SYNTH_123')
   adb.assert_called_once_with('adb','serial','shell','input','tap','595','610',timeout=7);nav.assert_called_once();self.assertEqual(a.verified_account_identity['sample_count'],2);self.assertIn('index_notification_close_selected',ev)
 def test_known_milestone_after_profile_action_closes_only_icon_then_reads_id_twice(self):
  home=tree();home[-1].set('selected','false');a=args();ev=events()
  with patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'native_window_capture',side_effect=[home,milestone(),tree(),tree()]) as read,patch.object(sync,'navigation_capture',return_value=tree()),patch.object(sync,'native_index_navigation') as nav,patch.object(sync.time,'sleep'),patch.object(sync,'adb') as adb:
   sync.prove_profile_identity(a,tree(),Mock(),ev,'SYNTH_123')
   nav.assert_called_once();self.assertEqual(read.call_count,4);adb.assert_called_once_with('adb','serial','shell','input','tap','686','821',timeout=7)
   self.assertEqual(a.verified_account_identity['sample_count'],2);self.assertIn('identity_fresh_overlay_recovered',ev)
 def test_changed_milestone_close_roles_never_publish_or_dismiss(self):
  r=milestone();next(n for n in r.iter('node')if n.get('bounds')=='[652,787][720,855]').set('clickable','false')
  with patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'native_window_capture',return_value=r),patch.object(sync,'adb') as adb,patch.object(sync,'native_index_navigation') as nav:
   with self.assertRaisesRegex(RuntimeError,'close element is not proven'):sync.prove_profile_identity(args(),tree(),Mock(),events(),'SYNTH_123')
   adb.assert_not_called();nav.assert_not_called()
 def test_overlay_foreground_change_blocks_its_close(self):
  with patch.object(sync,'focus',side_effect=[INDEX,INDEX,INDEX,INDEX.replace('u0','u999')]),patch.object(sync,'native_window_capture',return_value=milestone()),patch.object(sync,'adb') as adb,patch.object(sync,'native_index_navigation') as nav:
   with self.assertRaisesRegex(sync.ElementListReadError,'foreground changed before overlay dismissal'):sync.prove_profile_identity(args(),tree(),Mock(),events(),'SYNTH_123')
   adb.assert_not_called();nav.assert_not_called()
 def test_still_open_milestone_is_not_reclicked_or_reported_as_identity(self):
  with patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'native_window_capture',return_value=milestone()),patch.object(sync,'navigation_capture',return_value=milestone()),patch.object(sync,'native_index_navigation') as nav,patch.object(sync.time,'sleep'),patch.object(sync,'adb') as adb:
   with self.assertRaisesRegex(RuntimeError,'milestone stayed open'):sync.prove_profile_identity(args(),tree(),Mock(),events(),'SYNTH_123')
   self.assertEqual(adb.call_count,1);nav.assert_not_called()
 def test_login_appearing_only_in_fresh_profile_read_still_needs_second_matching_tree(self):
  for slot,user in [('app1','0'),('app2','999')]:
   ev=['collection_slot_requested:'+slot]+(['clone_user_requested:'+user] if slot=='app2' else [])
   a=args();a.app_slot=slot
   with self.subTest(slot=slot),patch.object(sync,'focus',return_value=INDEX.replace('u0','u'+user)),patch.object(sync,'native_window_capture',return_value=login_tree()),patch.object(sync,'capture',return_value=login_tree()) as second,patch.object(sync.time,'sleep'),patch.object(sync,'adb') as adb:
    with self.assertRaisesRegex(RuntimeError,'account is logged out'):sync.prove_profile_identity(a,tree(),Mock(),ev,'SYNTH_123')
    second.assert_called_once();adb.assert_not_called();self.assertIn('login_state_confirmed:login_controls',ev)
 def test_transient_login_after_stale_profile_cannot_be_reported_as_logout(self):
  with patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'native_window_capture',return_value=login_tree()),patch.object(sync,'capture',return_value=tree()),patch.object(sync.time,'sleep'),patch.object(sync,'adb') as adb:
   with self.assertRaisesRegex(sync.ElementListReadError,'changed during native confirmation') as error:sync.prove_profile_identity(args(),tree(),Mock(),events(),'SYNTH_123')
   self.assertNotIn('logged out',str(error.exception));adb.assert_not_called()
 def test_second_login_tree_from_wrong_slot_is_never_logout(self):
  with patch.object(sync,'focus',side_effect=[INDEX,INDEX,INDEX,INDEX.replace('u0','u999')]),patch.object(sync,'native_window_capture',return_value=login_tree()),patch.object(sync,'capture',return_value=login_tree()),patch.object(sync.time,'sleep'),patch.object(sync,'adb') as adb:
   with self.assertRaisesRegex(RuntimeError,'requested slot') as error:sync.prove_profile_identity(args(),tree(),Mock(),events(),'SYNTH_123')
   self.assertNotIn('logged out',str(error.exception));adb.assert_not_called()
 def test_fresh_empty_profile_never_requests_logout_confirmation(self):
  with patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'native_window_capture',return_value=ET.Element('hierarchy')),patch.object(sync,'confirm_logged_out') as logout,patch.object(sync,'native_index_navigation'),patch.object(sync.time,'sleep'):
   with self.assertRaisesRegex(sync.ElementListReadError,'selection did not settle'):sync.prove_profile_identity(args(),tree(),Mock(),events(),'SYNTH_123')
   logout.assert_not_called()
 def test_two_actual_header_variants_accept_only_public_id(self):
  for two in (False,True):self.assertEqual(sync.profile_header_identity(tree(two),INDEX,events()),'SYNTH_123')
 def test_captured_id_copy_and_ip_arrow_row_keeps_only_the_id_identity(self):
  r=ET.parse(S/'fixtures/xhs-profile-header-id-ip-row.xml').getroot()
  self.assertEqual(sync.profile_header_identity(r,INDEX,events()),'SYNTH_123')
 def test_ip_companion_row_unknown_duplicate_or_changed_roles_never_bypass_identity(self):
  for kind in ['copy_disabled','arrow_clickable','separator','ip_label','foreign','outside','overlap','extra']:
   r=ET.parse(S/'fixtures/xhs-profile-header-id-ip-row.xml').getroot();row=r[0]
   if kind=='copy_disabled':row[1].set('enabled','false')
   elif kind=='arrow_clickable':row[4].set('clickable','true')
   elif kind=='separator':row[2].set('text','/')
   elif kind=='ip_label':row[3].set('text','小红书号：OTHER')
   elif kind=='foreign':row[4].set('package','other')
   elif kind=='outside':row[4].set('bounds','[635,339][700,359]')
   elif kind=='overlap':row[4].set('bounds','[450,339][460,359]')
   elif kind=='extra':row.append(copy.deepcopy(row[1]))
   with self.subTest(kind=kind),self.assertRaises(sync.ElementListReadError):sync.profile_header_identity(r,INDEX,events())
 def test_note_body_id_cannot_replace_header(self):
  r=tree();r[0][0].set('bounds','[228,1300][491,1329]')
  with self.assertRaisesRegex(sync.ElementListReadError,'header ID'):sync.profile_header_identity(r,INDEX,events())
 def test_duplicate_header_wrong_roles_geometry_or_tabs_are_not_identity(self):
  variants=[]
  r=tree();r.insert(1,copy.deepcopy(r[0]));variants.append(r)
  r=tree();r[0].set('class','android.view.ViewGroup');variants.append(r)
  r=tree();r[0][1].set('enabled','false');variants.append(r)
  r=tree();r[0][0].set('clickable','false');variants.append(r)
  r=tree();r[0][1].set('bounds','[0,0][20,20]');variants.append(r)
  r=tree();r[-1].set('selected','false');variants.append(r)
  r=tree();r[1].set('text','别人的笔记');variants.append(r)
  r=tree();r[2].set('bounds','[340,1300][404,1337]');variants.append(r)
  r=tree();r[0][0].set('package','com.other');variants.append(r)
  r=tree();r[0][0].set('visible-to-user','false');variants.append(r)
  r=tree();r[1].set('visible-to-user','false');variants.append(r)
  for r in variants:
   with self.subTest(xml=ET.tostring(r)),self.assertRaises(sync.ElementListReadError):sync.profile_header_identity(r,INDEX,events())
 def test_wrong_user_activity_or_slot_never_proves_own_account(self):
  for focus in [INDEX.replace('u0','u999'),INDEX.replace('IndexActivityV2','OtherActivity')]:
   with self.subTest(focus=focus),self.assertRaises(RuntimeError):sync.profile_header_identity(tree(),focus,events())
 def prove(self,roots,expected='SYNTH_123',guard=None,focus=None):
  a=args();ev=events()
  with patch.object(sync,'focus',side_effect=focus) if focus else patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'native_window_capture',side_effect=roots),patch.object(sync.time,'sleep'),patch.object(sync,'native_index_navigation') as nav,patch.object(sync,'adb') as adb:
   root=sync.prove_profile_identity(a,tree(),guard or Mock(),ev,expected)
   nav.assert_not_called();adb.assert_not_called()
  return a,ev,root
 def test_two_fresh_native_reads_record_header_proof(self):
  a,ev,r=self.prove([tree(),tree()]);self.assertEqual(a.verified_account_identity['sample_count'],2);self.assertIn('account_identity:verified_public_id_two_reads',ev);self.assertEqual(len(a.verified_account_identity['sample_xml_sha256']),2)
 def test_profile_reads_do_not_switch_stock_list_policy_or_remove_prior_fallback(self):
  for native in (False,True):
   ev=events()+(['native_window_elements_enabled'] if native else [])
   def read(adb,serial,current,guard,local):
    if 'native_window_elements_enabled' not in local:local.append('native_window_elements_enabled')
    return tree()
   with patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'native_window_capture',side_effect=read),patch.object(sync.time,'sleep'):
    sync.prove_profile_identity(args(),tree(),Mock(),ev,'SYNTH_123')
   self.assertEqual('native_window_elements_enabled' in ev,native)
 def test_configured_mismatch_retains_both_ids_without_blocking_current_account(self):
  a,ev,_=self.prove([tree(),tree()],'OTHER_ID')
  proof=a.verified_account_identity
  self.assertEqual((proof['configured_id'],proof['visible_public_id']),('OTHER_ID','SYNTH_123'))
  self.assertFalse(proof['matches_exactly'])
  self.assertIn('account_identity:verified_public_id_two_reads',ev)
 def test_changed_id_or_foreground_cannot_become_zero_posts_or_logout(self):
  r=tree();r[0][0].set('text','小红书号：CHANGED_ID')
  with self.assertRaisesRegex(sync.ElementListReadError,'changed between'):self.prove([tree(),r])
  with self.assertRaisesRegex(sync.ElementListReadError,'foreground changed'):self.prove([tree()],focus=[INDEX,INDEX.replace('u0','u999')])
 def test_occupancy_stop_prevents_native_read(self):
  with patch.object(sync,'native_window_capture') as read,self.assertRaisesRegex(RuntimeError,'occupied'):
   sync.prove_profile_identity(args(),tree(),Mock(side_effect=RuntimeError('occupied')),events(),'SYNTH_123')
  read.assert_not_called()
 def test_unknown_route_stops_without_back_or_logout_inference(self):
  with patch.object(sync,'focus',return_value=INDEX.replace('.index.v2.IndexActivityV2','.UnknownActivity')),patch.object(sync,'recover_known_overlay',return_value=False),patch.object(sync,'adb') as adb,patch.object(sync,'confirm_logged_out') as logout:
   with self.assertRaisesRegex(sync.ElementListReadError,'no supported route'):sync.prove_profile_identity(args(),tree(),Mock(),events(),'SYNTH_123')
   adb.assert_not_called();logout.assert_not_called()
 def test_foreign_activity_cannot_use_spoofed_profile_or_trigger_slot_reentry(self):
  with patch.object(sync,'focus',return_value='mCurrentFocus=Window{x u0 com.tencent.wework/.MainActivity}'),patch.object(sync,'adb') as adb,patch.object(sync,'native_window_capture') as read,patch.object(sync,'start_xhs') as start:
   with self.assertRaisesRegex(sync.ElementListReadError,'unsupported foreground'):sync.enter_creator_with_slot_retry(args(),tree(),Mock(),events(),'SYNTH_123')
   adb.assert_not_called();read.assert_not_called();start.assert_not_called()
 def test_known_store_redirect_must_return_to_requested_profile_and_still_read_twice(self):
  foreign='mCurrentFocus=Window{x u0 com.bbk.appstore/.OtherActivity}'
  with patch.object(sync,'focus',side_effect=[foreign,INDEX,INDEX,INDEX,INDEX]),patch.object(sync,'recover_vivo_store_detail',return_value=True) as restore,patch.object(sync,'navigation_capture',return_value=tree()),patch.object(sync,'native_window_capture',side_effect=[tree(),tree()]) as read,patch.object(sync.time,'sleep'):
   a=args();sync.prove_profile_identity(a,tree(),Mock(),events(),'SYNTH_123')
   self.assertEqual(read.call_count,2);restore.assert_called_once();self.assertTrue(a.verified_account_identity['matches_exactly'])
 def test_unsent_chat_is_preserved_before_profile_navigation(self):
  root=tree();ET.SubElement(root,'node',{'package':sync.XHS_PACKAGE,'class':'android.widget.EditText','text':'尚未发送的内容','bounds':'[0,600][400,700]'})
  with patch.object(sync,'focus',return_value=INDEX.replace('.index.v2.IndexActivityV2','.ChatActivity')),patch.object(sync,'xhs_chat_activity',return_value=True),patch.object(sync,'adb') as adb,patch.object(sync,'native_index_navigation') as nav:
   with self.assertRaisesRegex(RuntimeError,'unsent text'):sync.prove_profile_identity(args(),root,Mock(),events(),'SYNTH_123')
   adb.assert_not_called();nav.assert_not_called()
 def test_missing_disabled_duplicate_or_invalid_binding_does_not_collect(self):
  row={'appSlot':'app1','enabled':True,'xhsId':'SYNTH_123'}
  self.assertEqual(sync.requested_account_id({'xhsAccounts':[row]},'app1'),'SYNTH_123')
  for entries in [[],[row,row],[dict(row,enabled=False)],[dict(row,xhsId='')],[dict(row,appSlot='app2')]]:
   with self.assertRaisesRegex(RuntimeError,'configured ID'):sync.requested_account_id({'xhsAccounts':entries},'app1')
 def test_binding_change_does_not_gate_settings_cleanup_but_rejects_data(self):
  with patch.object(sync,'assert_idle',return_value={'xhsAccounts':[{'appSlot':'app1','enabled':True,'xhsId':'CHANGED_ID'}]}):
   with self.assertRaisesRegex(RuntimeError,'binding changed'):sync.require_current_account_binding(args(),'SYNTH_123')
 def test_mismatch_stops_before_any_creator_list_entry_and_no_retry(self):
  with patch.object(sync,'prove_profile_identity',side_effect=RuntimeError('account identity mismatch')),patch.object(sync,'ensure_creator_list') as enter,patch.object(sync,'start_xhs') as start:
   with self.assertRaisesRegex(RuntimeError,'identity mismatch'):sync.enter_creator_with_slot_retry(args(),tree(),Mock(),events(),'SYNTH_123')
   enter.assert_not_called();start.assert_not_called()



EDIT=INDEX.replace('.index.v2.IndexActivityV2','com.xingin.reactnative.ui.XhsReactActivity')
def enterprise():return ET.parse(S/'fixtures/xhs-enterprise-profile-no-id.xml').getroot()
def editor():return ET.parse(S/'fixtures/xhs-profile-editor-id.xml').getroot()
class EnterpriseProfileIdentity(unittest.TestCase):
 def test_actual_editor_row_and_missing_header_are_separate_proofs(self):
  self.assertEqual(sync.profile_edit_entry(enterprise(),INDEX,events())[0],(418,95,522,136))
  self.assertEqual(sync.profile_editor_identity(editor(),EDIT,events()),'SYNTH_123')
 def test_other_user_activity_duplicate_row_wrong_parent_hidden_and_outside_value_fail(self):
  for mode in ['user','activity','duplicate','parent','hidden','geometry','focused']:
   r=editor();current=EDIT
   if mode=='user':current=current.replace('u0','u999')
   if mode=='activity':current=INDEX
   if mode=='duplicate':r.append(copy.deepcopy(r[1]))
   if mode=='parent':r[1].set('class','android.widget.LinearLayout')
   if mode=='hidden':r[1][1].set('visible-to-user','false')
   if mode=='geometry':r[1][1].set('bounds','[100,1500][600,1550]')
   if mode=='focused':ET.SubElement(r,'node',{'package':sync.XHS_PACKAGE,'class':'android.widget.EditText','focused':'true','enabled':'true','bounds':'[0,600][300,650]'})
   with self.subTest(mode=mode),self.assertRaises(RuntimeError):sync.profile_editor_identity(r,current,events())
 def test_existing_or_ambiguous_visible_id_never_opens_editor(self):
  ambiguous=enterprise();ambiguous.append(copy.deepcopy(tree()[0]))
  for r in [tree(),ambiguous]:
   with self.assertRaises(sync.ElementListReadError):sync.profile_edit_entry(r,INDEX,events())
 def run_editor(self,expected='SYNTH_123',changed=False,unknown=False):
  a=args();ev=events();state={'focus':INDEX};calls=[];reads=[editor(),editor()]
  if changed:reads[1][1][1].set('text','CHANGED_ID')
  if unknown:reads[1][0].set('text','未知协议')
  def adb(*a,**kw):
   calls.append(a[2:]);state['focus']=EDIT if a[2:5]==('shell','input','tap') else INDEX
  def read(*a,**kw):return reads.pop(0) if state['focus']==EDIT else enterprise()
  with patch.object(sync,'focus',side_effect=lambda *a:state['focus']),patch.object(sync,'native_window_capture',side_effect=read),patch.object(sync,'adb',side_effect=adb),patch.object(sync.time,'sleep'):
   try:r=sync.read_profile_editor_identity(a,enterprise(),INDEX,Mock(),ev,expected)
   except RuntimeError as error:return a,ev,calls,error
  return a,ev,calls,r
 def test_two_editor_reads_then_back_never_types_or_saves(self):
  a,ev,calls,r=self.run_editor();self.assertNotIsInstance(r,Exception);self.assertEqual(calls,[('shell','input','tap','470','115'),('shell','input','keyevent','4')]);self.assertEqual(a.verified_account_identity['method'],'own_profile_editor_public_id_two_fresh_native_reads');self.assertEqual(a.verified_account_identity['sample_count'],2)
 def test_stable_editor_id_can_differ_from_table_but_changed_id_fails(self):
  a,ev,calls,root=self.run_editor('OTHER_ID')
  self.assertIsInstance(root,ET.Element)
  self.assertFalse(a.verified_account_identity['matches_exactly'])
  self.assertEqual(a.verified_account_identity['visible_public_id'],'SYNTH_123')
  self.assertEqual(calls[-1],('shell','input','keyevent','4'))
  a,ev,calls,error=self.run_editor(changed=True)
  self.assertIsInstance(error,RuntimeError)
  self.assertNotIn('logged out',str(error))
  self.assertEqual(calls[-1],('shell','input','keyevent','4'))
  self.assertFalse(hasattr(a,'verified_account_identity'))
 def test_unknown_second_surface_does_not_accept_or_navigate_it(self):
  a,ev,calls,error=self.run_editor(unknown=True);self.assertIsInstance(error,RuntimeError);self.assertEqual(len(calls),1);self.assertNotIn('logged out',str(error))
 def test_changed_entry_or_occupancy_stops_before_tap(self):
  r=enterprise();next(n for n in r.iter('node') if n.get('text')=='编辑主页').set('bounds','[418,195][522,236]')
  with patch.object(sync,'native_window_capture',return_value=r),patch.object(sync,'adb') as adb:
   with self.assertRaises(RuntimeError):sync.read_profile_editor_identity(args(),enterprise(),INDEX,Mock(),events(),'SYNTH_123')
   adb.assert_not_called()
  with patch.object(sync,'native_window_capture') as read,self.assertRaisesRegex(RuntimeError,'occupied'):
   sync.read_profile_editor_identity(args(),enterprise(),INDEX,Mock(side_effect=RuntimeError('occupied')),events(),'SYNTH_123')
  read.assert_not_called()


class IdentityStartupDialog(unittest.TestCase):
 def test_missing_native_child_is_retried_only_after_proven_update_preaction_failure(self):
  update=INDEX.replace('.index.v2.IndexActivityV2','com.xingin.update.UpdateDialogActivity');error=RuntimeError('native navigation command failed: native_navigation_unproven:IllegalStateException:missing native child')
  with patch.object(sync,'focus',side_effect=[INDEX,update,INDEX]),patch.object(sync,'assert_no_poco'),patch('xhs_native_navigation.perform',side_effect=[error,None]) as action,patch.object(sync,'navigation_capture',return_value=tree()),patch.object(sync,'recover_known_overlay',return_value=True) as close:
   sync.native_index_navigation('profile','adb','serial',Mock(),events());self.assertEqual(action.call_count,2);close.assert_called_once()
 def test_missing_child_without_update_does_not_retry(self):
  error=RuntimeError('native navigation command failed: native_navigation_unproven:IllegalStateException:missing native child')
  with patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'assert_no_poco'),patch('xhs_native_navigation.perform',side_effect=error) as action,patch.object(sync,'recover_known_overlay') as close:
   with self.assertRaisesRegex(RuntimeError,'missing native child'):sync.native_index_navigation('profile','adb','serial',Mock(),events())
   action.assert_called_once();close.assert_not_called()
 def test_missing_child_does_not_expand_menu_retry_scope(self):
  error=RuntimeError('native navigation command failed: native_navigation_unproven:IllegalStateException:missing native child')
  with patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'assert_no_poco'),patch('xhs_native_navigation.perform',side_effect=error) as action,patch.object(sync,'recover_known_overlay') as close:
   with self.assertRaisesRegex(RuntimeError,'missing native child'):sync.native_index_navigation('menu','adb','serial',Mock(),events())
   action.assert_called_once();close.assert_not_called()
 def test_missing_child_repeated_after_one_update_stops_without_third_action(self):
  update=INDEX.replace('.index.v2.IndexActivityV2','com.xingin.update.UpdateDialogActivity');error=RuntimeError('native navigation command failed: native_navigation_unproven:IllegalStateException:missing native child')
  with patch.object(sync,'focus',side_effect=[INDEX,update,INDEX]),patch.object(sync,'assert_no_poco'),patch('xhs_native_navigation.perform',side_effect=error) as action,patch.object(sync,'navigation_capture',return_value=tree()),patch.object(sync,'recover_known_overlay',return_value=True) as close:
   with self.assertRaisesRegex(RuntimeError,'missing native child'):sync.native_index_navigation('profile','adb','serial',Mock(),events())
   self.assertEqual(action.call_count,2);close.assert_called_once()
 def test_cleanup_failure_suffix_is_not_a_retryable_missing_child(self):
  error=RuntimeError('native navigation command failed: native_navigation_unproven:IllegalStateException:missing native child\nnative_disconnect_failed')
  with patch.object(sync,'focus',return_value=INDEX),patch.object(sync,'assert_no_poco'),patch('xhs_native_navigation.perform',side_effect=error) as action,patch.object(sync,'recover_known_overlay') as close:
   with self.assertRaisesRegex(RuntimeError,'native_disconnect_failed'):sync.native_index_navigation('profile','adb','serial',Mock(),events())
   action.assert_called_once();close.assert_not_called()
 def test_late_known_update_uses_fresh_dialog_tree_before_existing_safe_defer(self):
  update=INDEX.replace('.index.v2.IndexActivityV2','com.xingin.update.UpdateDialogActivity');state={'focus':update};fresh=ET.Element('hierarchy');ev=events()
  def close(adb,serial,root,*args):
   self.assertIs(root,fresh);state['focus']=INDEX;return True
  with patch.object(sync,'focus',side_effect=lambda *a:state['focus']),patch.object(sync,'navigation_capture',side_effect=[fresh,tree()]) as read,patch.object(sync,'recover_known_overlay',side_effect=close),patch.object(sync,'native_window_capture',side_effect=[tree(),tree()]),patch.object(sync.time,'sleep'),patch.object(sync,'adb') as adb:
   a=args();sync.prove_profile_identity(a,tree(),Mock(),ev,'SYNTH_123')
   self.assertTrue(a.verified_account_identity['matches_exactly']);self.assertIn('identity_known_dialog_fresh_read',ev);self.assertEqual(read.call_count,2);adb.assert_not_called()
 def test_unproven_dialog_is_only_reread_twice_without_install_or_guessing_logout(self):
  update=INDEX.replace('.index.v2.IndexActivityV2','com.xingin.update.UpdateDialogActivity')
  with patch.object(sync,'focus',return_value=update),patch.object(sync,'navigation_capture',return_value=ET.Element('hierarchy')) as read,patch.object(sync,'recover_known_overlay',return_value=False),patch.object(sync.time,'sleep'),patch.object(sync,'adb') as adb,patch.object(sync,'start_xhs') as start:
   with self.assertRaisesRegex(sync.ElementListReadError,'dialog roles did not settle'):sync.enter_creator_with_slot_retry(args(),tree(),Mock(),events(),'SYNTH_123')
   self.assertEqual(read.call_count,2);adb.assert_not_called();start.assert_not_called()

if __name__=='__main__':unittest.main()
