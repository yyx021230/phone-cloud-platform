"""Observed November failures and false-logout rejection, native elements only."""
import importlib.util
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch, Mock

BASE=Path(__file__).parent
spec=importlib.util.spec_from_file_location('xhs_november',BASE/'小红书数据同步.py')
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
def fixture(name):return ET.parse(BASE/'fixtures/xhs'/name).getroot()
def focus(user,activity):return 'mCurrentFocus=Window{x u'+user+' com.xingin.xhs/'+activity+'}'
INDEX='com.xingin.xhs.index.v2.IndexActivityV2'
NOTICE='com.xingin.authorization.NotificationAuthorizationTranslucentActivity'
OFFLINE='com.xingin.login.device.offline.DeviceOfflineRemindActivity'

class NovemberRecoveryTests(unittest.TestCase):
 def test_notification_native_close_only_never_confirmation(self):
  root=fixture('notification-card-140.xml');events=['collection_slot_requested:app2','clone_user_requested:999']
  with patch.object(sync,'focus',side_effect=[focus('999',NOTICE),focus('999',INDEX)]),patch.object(sync,'navigation_capture',return_value=ET.Element('hierarchy')),patch.object(sync.time,'sleep'),patch.object(sync,'adb')as adb:
   self.assertTrue(sync.close_notification_card('adb','serial',root,focus('999',NOTICE),lambda:None,events,lambda:None))
  self.assertEqual(adb.call_args.args[2:],('shell','input','tap','850','817'))
 def test_notification_duplicate_close_or_wrong_slot_never_taps(self):
  for duplicate in [False,True]:
   root=fixture('notification-card-140.xml');events=['collection_slot_requested:app2','clone_user_requested:999']
   if duplicate:
    close=next(n for n in root.iter('node')if n.get('class')=='android.widget.ImageView'and n.get('clickable')=='true');parent=next(n for n in root.iter()if close in list(n));parent.append(ET.fromstring(ET.tostring(close)))
   with patch.object(sync,'adb')as adb:
    with self.assertRaises(RuntimeError):sync.close_notification_card('adb','serial',root,focus('999'if duplicate else'0',NOTICE),lambda:None,events,lambda:None)
   adb.assert_not_called()
 def test_smart_upgrade_cancel_uses_decline_parent(self):
  root=fixture('smart-upgrade-121.xml');events=[]
  current='mCurrentFocus=Window{com.bbk.updater:x u0 com.bbk.updater type=2003}'
  with patch.object(sync,'focus',return_value=current),patch.object(sync,'navigation_capture',return_value=ET.Element('hierarchy')),patch.object(sync.time,'sleep'),patch.object(sync,'adb')as adb:
   self.assertTrue(sync.recover_known_overlay('adb','serial',root,lambda:None,events))
  self.assertEqual(adb.call_args.args[2:],('shell','input','tap','360','1478'))
  self.assertIn('vivo_smart_upgrade_cancelled',events)
 def test_smart_upgrade_changed_button_or_lost_ownership_never_taps(self):
  for lost in [False,True]:
   root=fixture('smart-upgrade-121.xml')
   if not lost:
    for n in root.iter('node'):
     if n.get('text')=='取消':n.set('text','开启')
   with patch.object(sync,'focus',return_value='mCurrentFocus=Window{x u0 com.bbk.updater type=2003}'),patch.object(sync,'adb')as adb:
    with self.assertRaises(RuntimeError):sync.recover_known_overlay('adb','serial',root,Mock(side_effect=RuntimeError('occupied'))if lost else lambda:None,[])
   adb.assert_not_called()
 def test_delayed_notification_focus_is_read_again_without_second_back(self):
  current=focus('0',NOTICE);home=focus('0',INDEX)
  with patch.object(sync,'focus',side_effect=[current,current,current,home]),patch.object(sync.time,'sleep'),patch.object(sync,'adb')as adb:
   self.assertTrue(sync.recover_known_overlay('adb','serial',ET.Element('hierarchy'),lambda:None,['collection_slot_requested:app1']))
  self.assertEqual(adb.call_count,1)

class LoginEvidenceTests(unittest.TestCase):
 def test_real_login_and_offline_notice_need_second_tree(self):
  for name,user,activity,marker in [('login-controls-90.xml','999',INDEX,'login_controls'),('offline-notice-158.xml','0',OFFLINE,'account_offline_notice')]:
   root=fixture(name);events=['collection_slot_requested:'+('app1'if user=='0'else'app2')]+(['clone_user_requested:999']if user=='999'else[])
   with patch.object(sync,'focus',return_value=focus(user,activity)),patch.object(sync,'capture',return_value=root)as capture,patch.object(sync.time,'sleep'),patch.object(sync,'adb')as adb:
    with self.assertRaisesRegex(RuntimeError,'manual login is required'):sync.confirm_logged_out('adb','serial',root,lambda:None,events)
   capture.assert_called_once();adb.assert_not_called();self.assertIn('login_state_confirmed:'+marker,events)
 def test_empty_elements_or_activity_only_never_proves_logout(self):
  with patch.object(sync,'focus',return_value=focus('0',OFFLINE)),patch.object(sync,'capture')as capture:
   with self.assertRaisesRegex(sync.ElementListReadError,'lacks native element'):sync.confirm_logged_out('adb','serial',ET.Element('hierarchy'),lambda:None,['collection_slot_requested:app1'])
  capture.assert_not_called()
 def test_transient_login_tree_is_not_reported_as_logged_out(self):
  with patch.object(sync,'focus',return_value=focus('999',INDEX)),patch.object(sync,'capture',return_value=ET.Element('hierarchy')),patch.object(sync.time,'sleep'):
   with self.assertRaisesRegex(sync.ElementListReadError,'changed during'):sync.confirm_logged_out('adb','serial',fixture('login-controls-90.xml'),lambda:None,['collection_slot_requested:app2','clone_user_requested:999'])
 def test_wrong_slot_login_does_not_report_target_logout(self):
  with self.assertRaisesRegex(RuntimeError,'requested slot'):sync.login_element_evidence(fixture('login-controls-90.xml'),focus('0',INDEX),['collection_slot_requested:app2','clone_user_requested:999'])
 def test_other_package_words_cannot_be_login_evidence(self):
  root=fixture('login-controls-90.xml')
  for n in root.iter('node'):n.set('package','example.fake')
  self.assertIsNone(sync.login_element_evidence(root,focus('999',INDEX),['collection_slot_requested:app2','clone_user_requested:999']))

class IntegrityRecoveryTests(unittest.TestCase):
 def result(self, names):
  return dict(complete=True,stop_reason='older_than_window_visible',app_slot='app1',window_start_date='2026-10-04',window_end_date='2026-11-02',list_scope_raw='仅统计近一年发布的笔记',scrolls=3,recovery_events=[],warnings=[],notes=[dict(title=n,published_date='2026-10-20',published_at_raw='10-20')for n in names])
 def run_audit(self, *passes):
  from argparse import Namespace
  with patch.object(sync,'collect_once',side_effect=list(passes))as run:
   answer=sync.collect(Namespace(app_slot='app1',integrity_retries=1))
  return answer,run
 def test_fresh_complete_pair_can_recover_a_partial_native_snapshot(self):
  for a,b in [('ABC','AC'),('AC','ABC')]:
   out,run=self.run_audit(self.result(a),self.result(b),self.result('ABC'),self.result('ABC'))
   self.assertTrue(out['complete']);self.assertEqual([n['title']for n in out['notes']],list('ABC'))
   self.assertEqual(run.call_count,4);self.assertIn('collection_integrity_recovery:verified_after_mismatch',out['recovery_events'])
 def test_equal_smaller_recovery_pair_cannot_discard_any_previously_read_post(self):
  out,run=self.run_audit(self.result('ABC'),self.result('AC'),self.result('AC'),self.result('AC'))
  self.assertFalse(out['complete']);self.assertEqual(run.call_count,4)
 def test_two_different_recovery_passes_never_trigger_a_fifth_pass(self):
  out,run=self.run_audit(self.result('ABC'),self.result('AC'),self.result('ABC'),self.result('AB'))
  self.assertFalse(out['complete']);self.assertEqual(run.call_count,4)
 def test_recovery_cannot_reorder_prior_posts_even_with_equal_counts(self):
  out,_=self.run_audit(self.result('ABC'),self.result('AC'),self.result('BAC'),self.result('BAC'))
  self.assertFalse(out['complete'])
 def test_scope_change_is_not_an_automatic_reload(self):
  a,b=self.result('ABC'),self.result('AC');b['app_slot']='app2'
  out,run=self.run_audit(a,b);self.assertFalse(out['complete']);self.assertEqual(run.call_count,2)
 def test_element_failure_or_cancellation_during_recovery_remains_failure(self):
  out,_=self.run_audit(self.result('ABC'),self.result('AC'),sync.ElementListReadError('unproven native row'))
  self.assertFalse(out['complete'])
  with self.assertRaisesRegex(RuntimeError,'occupied'):
   self.run_audit(self.result('ABC'),self.result('AC'),RuntimeError('occupied'))
 def test_recovery_does_not_reset_the_loading_reopen_budget(self):
  a,b=self.result('ABC'),self.result('AC');b['recovery_events']=['data_center_loading_reopen:1','data_center_loading_reopen:2']
  out,run=self.run_audit(a,b,self.result('ABC'),self.result('ABC'))
  self.assertEqual(run.call_args_list[2].args[0].prior_loading_reopens,2)
 def test_known_verification_seam_failure_can_retry_without_discarding_its_prefix(self):
  b=self.result('AC');b['complete']=False;b['stop_reason']='elements_unproven';b['recovery_events']=['works_elements_scan_stopped:ordered element overlap has a gap, reorder or backward jump']
  out,run=self.run_audit(self.result('ABC'),b,self.result('ABC'),self.result('ABC'))
  self.assertTrue(out['complete']);self.assertEqual(run.call_count,4)
 def test_unclassified_incomplete_verification_is_not_blindly_retried(self):
  b=self.result('AC');b['complete']=False;b['stop_reason']='elements_unproven';b['recovery_events']=[]
  out,run=self.run_audit(self.result('ABC'),b)
  self.assertFalse(out['complete']);self.assertEqual(run.call_count,2)
 def test_normal_matching_pair_has_no_extra_pass(self):
  out,run=self.run_audit(self.result('ABC'),self.result('ABC'))
  self.assertTrue(out['complete']);self.assertEqual(run.call_count,2)

class SeamRefreshTests(unittest.TestCase):
 def page(self,names):
  import copy
  root=fixture('works-elements-141.xml');parents={c:n for n in root.iter()for c in n}
  for i,(row,v)in enumerate(sync.note_cards(root)):
   if i>=len(names):parents[row].remove(row)
   else:next(n for n in row.iter('node')if n.get('text')==v['title']).set('text',names[i])
  return root
 def read(self, refreshed, changed=False):
  current=focus('0','com.xingin.xywebview.activity.WebViewActivityV2');before=self.page('ABCDE');mixed=self.page('CEFGH');events=['collection_slot_requested:app1','collection_verification_pass'];guard=Mock()
  states=[current,current,current,current]if not changed else[current,current.replace('u0 ','u999 ')]
  with patch.object(sync,'focus',side_effect=states),patch.object(sync,'navigation_capture',side_effect=[mixed,refreshed]),patch.object(sync,'wait_creator_content',side_effect=lambda a,b,r,*rest:r),patch.object(sync,'adb')as adb:
   try:return sync.read_scrolled_content('adb','serial',before,guard,events,False),events
   finally:adb.assert_not_called()
 def test_transient_seam_is_refreshed_in_place_without_any_swipe(self):
  root=self.page('CDEFG');out,events=self.read(root);self.assertIs(out[0],root);self.assertIn('verification_overlap_stability_retry',events)
 def test_persistent_gap_is_not_accepted_by_the_reread(self):
  with self.assertRaises(sync.ElementListReadError):self.read(self.page('CEFGH'))
 def test_wrong_slot_during_seam_refresh_is_not_accepted(self):
  with self.assertRaisesRegex(sync.ElementListReadError,'foreground changed'):self.read(self.page('CDEFG'),changed=True)
