"""142 recorded OPlus crash dialog through the shared mismatch checkpoint."""
import unittest,xml.etree.ElementTree as ET
from unittest import mock
import alipay_name_lookup as lookup
from test_lookup_overlay_guard import home,parents,clock,HOME,node
from test_lookup_visual_result import row
from lookup_page_actions import action_box
class PocoCrashOverlay(unittest.TestCase):
 def fixture(self,wrong=False,sticky=False):
  r=lookup.Runner({'serial':'SYNTHETIC','taskId':'crash'});st={'closed':False,'taps':[]}
  root=ET.Element('hierarchy')
  for text,rid,bounds in [(lookup.POCO_CRASH_TITLE,'com.oplus.battery:id/alertTitle','[132,1019][948,1085]'),(lookup.POCO_CRASH_MESSAGE,'android:id/message','[60,1130][1020,1253]'),('知道了','android:id/button1','[60,1262][1020,1430]')]:
   ET.SubElement(root,'node',{'text':text.replace('PocoService','OtherService') if wrong else text,'resource-id':rid,'bounds':bounds,'package':'com.oplus.battery','clickable':'true','enabled':'true'})
  def focus(**kw):return [HOME if st['closed'] else 'mCurrentFocus=Window{x u0 com.oplus.battery}', 'mFocusedApp=ActivityRecord{x '+lookup.ALIPAY_PACKAGE+'/.AlipayLogin}']
  r.focus=focus;r.focus_state=lambda:(focus(),focus()[0],focus()[1]);r.dump=lambda *a,**kw:(home(),parents(home())) if st['closed'] else (root,parents(root));r.emit=mock.Mock()
  def adb(args,**kw):
   self.assertEqual(args,['shell','input','tap','540','1346']);st['taps'].append(args);st['closed']=not sticky;return ''
  r.adb=mock.Mock(side_effect=adb);return r,st,root
 def test_xml_mismatch_closes_exact_notice_then_continues_home_step(self):
  r,s,root=self.fixture()
  with clock():self.assertTrue(r.recover_page_mismatch('account-home',root=root,parent=parents(root)))
  self.assertTrue(s['closed']);self.assertEqual(len(s['taps']),1)
  self.assertTrue(any(c.args[0]=='page_mismatch_overlay_cleared' for c in r.emit.call_args_list))
 def test_other_app_crash_cannot_authorize_click(self):
  r,s,root=self.fixture(wrong=True)
  import alipay_visual_result as v
  with clock(),mock.patch.object(v,'recognize',return_value=([],(1080,2400))):
   r.adb=mock.Mock(return_value=b'picture')
   with self.assertRaisesRegex(RuntimeError,'known_overlay_close_unverified'):r.recover_page_mismatch('account-home',root=root,parent=parents(root))
  self.assertFalse(any(c.args[0][:3]==['shell','input','tap'] for c in r.adb.call_args_list))
 def test_sticky_crash_is_not_success_and_not_clicked_twice(self):
  r,s,root=self.fixture(sticky=True)
  with clock(),self.assertRaisesRegex(RuntimeError,'known_overlay_close_unverified'):r.recover_page_mismatch('account-home',root=root,parent=parents(root))
  self.assertEqual(len(s['taps']),1)
 def test_changed_focus_blocks_acknowledgement(self):
  r,s,root=self.fixture();r.focus=lambda **kw:['mCurrentFocus=Window{x u0 other.app/.Page}','mFocusedApp=ActivityRecord{x other.app/.Page}']
  with clock():self.assertFalse(r.dismiss_system_text_overlay('poco_service_crash',root=root))
  r.adb.assert_not_called()
 def test_ocr_requires_exact_app_message_and_unique_button(self):
  rows=[row('“PocoService”异常',540,1052),row(lookup.POCO_CRASH_MESSAGE,540,1190),row('知道了',540,1346)]
  self.assertIsNotNone(action_box(rows,(1080,2400),'poco_service_crash'))
  self.assertIsNone(action_box(rows+rows[-1:],(1080,2400),'poco_service_crash'))
  self.assertIsNone(action_box(rows[1:],(1080,2400),'poco_service_crash'))
  self.assertIsNone(action_box([(b,t.replace('PocoService','OtherService'),c) for b,t,c in rows],(1080,2400),'poco_service_crash'))

 def test_slow_ack_gets_fresh_home_before_old_deadline_failure(self):
  r,s,root=self.fixture();stage={'my':False,'settings':False}
  home_tree=home()
  settings=ET.Element('hierarchy');ET.SubElement(settings,'node',{'content-desc':'设置','resource-id':lookup.SETTINGS_ENTRY_ID,'package':lookup.ALIPAY_PACKAGE})
  r.dump=lambda *a,**kw:(settings,parents(settings)) if stage['my'] else (home_tree,parents(home_tree)) if s['closed'] else (root,parents(root))
  r.dismiss_vivo_usb_mode_dialog=lambda:False;r.dismiss_known_overlay=lambda *a:False
  def tap(_r,_p,event,**kw):
   if event=='open_my_tab':stage['my']=True
   elif event=='open_settings':stage['settings']=True
   else:raise AssertionError(event)
  r.tap_unique=tap
  with clock() as now:
   old=r.recover_page_mismatch
   def slow(*a,**kw):
    result=old(*a,**kw)
    if result:now[0]+=14
    return result
   r.recover_page_mismatch=slow;r.enter_my_settings('whole-prepare')
  self.assertTrue(stage['settings']);self.assertEqual(len(s['taps']),1)

 def test_missing_xml_uses_two_exact_ocr_frames(self):
  import alipay_visual_result as visual
  r,st,root=self.fixture();rows=[row(lookup.POCO_CRASH_TITLE,540,1052),row(lookup.POCO_CRASH_MESSAGE,540,1190),row('知道了',540,1346)]
  r.dump=mock.Mock(side_effect=RuntimeError('uiautomator_hierarchy_missing'));original=r.adb
  r.adb=lambda args,**kw:b'image' if args==['exec-out','screencap','-p'] else original(args,**kw)
  with clock(),mock.patch.object(visual,'recognize',return_value=(rows,(1080,2400))) as ocr:
   self.assertTrue(r.dismiss_system_text_overlay('poco_service_crash'))
  self.assertEqual(ocr.call_count,2);self.assertEqual(len(st['taps']),1)
if __name__=='__main__':unittest.main()
