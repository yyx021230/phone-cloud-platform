"""First write waits for stable frames; an unknown/failed write is never replayed."""
import unittest
from dataclasses import replace
from unittest.mock import patch
import wecom_invite_preview as w
from test_wecom_invite_preview import PHONE,OTHER,EMPTY,HOME,frame,text,Device,run,ACTIONS

class SettlingDevice(Device):
    def __init__(self,second=EMPTY):
        super().__init__();self.empty_reads=0;self.input_attempts=0;self.guards=0;self.differences=[];self.second=second
        self.transient=replace(EMPTY,nodes=EMPTY.nodes+(text('transition'),))
    def snapshot(self):
        self.reads+=1
        if self.index==3:
            self.empty_reads+=1
            return self.transient if self.empty_reads==1 else self.second
        return self.frames[self.index]
    def guard_input_observation(self):self.guards+=1
    def observe_input_change(self,before,after):self.differences.append((before,after))
    def apply(self,action,expected,phone,check_budget):
        if action=='enter_phone':
            self.input_attempts+=1
            if expected!=EMPTY:raise w.StopPreview('page_changed_before_action')
        return super().apply(action,expected,phone,check_budget)

class InputSettlingTests(unittest.TestCase):
    def test_transition_settles_before_one_first_input_with_original_path(self):
        device=SettlingDevice();result=run(device)
        self.assertEqual(result['status'],'ready_before_send');self.assertEqual(device.calls,ACTIONS)
        self.assertEqual(device.input_attempts,1);self.assertGreaterEqual(device.guards,3);self.assertEqual(len(device.differences),1)
        self.assertFalse(result['invitationSent']);self.assertFalse(result['remarkSaved'])
    def test_human_or_different_nonempty_input_stops_without_enter_or_save(self):
        for page,code in ((frame('安全验证'),'human_required'),(frame(w.Node('android.widget.EditText',text=OTHER,desc='手机号')),'search_input_not_empty')):
            d=SettlingDevice(page);r=run(d);self.assertEqual(r['code'],code);self.assertEqual(d.input_attempts,0);self.assertNotIn('enter_phone',d.calls)
    def test_third_frame_change_stops_and_does_not_retry_first_input(self):
        class Late(SettlingDevice):
            def apply(self,action,expected,phone,check_budget):
                if action=='enter_phone':self.input_attempts+=1;raise w.StopPreview('page_changed_before_action')
                return super().apply(action,expected,phone,check_budget)
        d=Late();self.assertEqual(run(d)['code'],'page_changed_before_action');self.assertEqual(d.input_attempts,1);self.assertNotIn('enter_phone',d.calls)
    def test_cancel_or_elapsed_budget_during_stability_check_never_writes(self):
        d=SettlingDevice()
        def cancel():raise w.StopPreview('cancelled')
        d.guard_input_observation=cancel;self.assertEqual(run(d)['code'],'cancelled');self.assertEqual(d.input_attempts,0)
        now=[0];d=SettlingDevice();d.guard_input_observation=lambda:now.__setitem__(0,11)
        self.assertEqual(run(d,timeout=10,clock=lambda:now[0])['code'],'timeout');self.assertEqual(d.input_attempts,0)

    def test_diagnostic_write_error_cannot_replace_original_prewrite_stop(self):
        effects=[]
        class Poco:
            def __call__(self,**kwargs):effects.append('query');raise AssertionError('must not reach input')
        driver=w.PocoPreviewDriver(Poco(),lambda:w.PACKAGE,lambda:True)
        driver.before_action_difference=lambda *args:(_ for _ in ()).throw(OSError('private path'))
        with patch.object(driver,'snapshot',return_value=frame(*EMPTY.nodes,text('changed'))):
            with self.assertRaisesRegex(w.StopPreview,'page_changed_before_action'):driver.apply('enter_phone',EMPTY,PHONE)
        self.assertFalse(effects)

    def test_stable_empty_frames_must_be_consecutive(self):
        class Gap(SettlingDevice):
            def snapshot(self):
                if self.index!=3:return super().snapshot()
                self.empty_reads+=1
                return frame('loading')if self.empty_reads==2 else EMPTY
        d=Gap();self.assertEqual(run(d)['status'],'ready_before_send');self.assertGreaterEqual(d.empty_reads,4);self.assertEqual(d.input_attempts,1)

if __name__=='__main__':unittest.main()
