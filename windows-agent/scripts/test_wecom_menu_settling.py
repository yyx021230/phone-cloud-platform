import unittest
from dataclasses import replace
import wecom_invite_preview as w
from test_wecom_invite_preview import Device,HOME,ACTIONS,frame,text,run

class SettlingHome(Device):
    def __init__(self):super().__init__();self.home_reads=0;self.attempts=0;self.diffs=[]
    def snapshot(self):
        if self.index:return super().snapshot()
        self.home_reads+=1
        return replace(HOME,nodes=HOME.nodes+(text('loading'),))if self.home_reads==1 else HOME
    def observe_action_change(self,action,before,after):self.diffs.append(action)
    def apply(self,action,expected,phone,check_budget):
        if action=='open_menu':
            self.attempts+=1
            if expected!=HOME:raise w.StopPreview('page_changed_before_action')
        super().apply(action,expected,phone,check_budget)

class MenuSettlingTests(unittest.TestCase):
    def test_initial_menu_click_waits_for_stable_home_once(self):
        d=SettlingHome();r=run(d)
        self.assertEqual(r['status'],'ready_before_send');self.assertEqual(d.calls,ACTIONS)
        self.assertEqual(d.attempts,1);self.assertEqual(d.diffs,['open_menu'])
    def test_third_frame_change_never_retries_menu_click(self):
        class Late(SettlingHome):
            def apply(self,action,*args):
                if action=='open_menu':self.attempts+=1;raise w.StopPreview('page_changed_before_action')
                return super().apply(action,*args)
        d=Late();self.assertEqual(run(d)['code'],'page_changed_before_action');self.assertEqual(d.attempts,1);self.assertFalse(d.calls)
    def test_unknown_or_human_page_after_home_observation_never_clicks(self):
        for page,code in ((frame('unrecognized'),'unsupported_start_page'),(frame('安全验证'),'human_required')):
            class Changed(SettlingHome):
                def snapshot(self):
                    self.home_reads+=1
                    return HOME if self.home_reads==1 else page
            d=Changed();self.assertEqual(run(d)['code'],code);self.assertEqual(d.attempts,0)
    def test_cancel_at_stability_check_prevents_first_click(self):
        d=SettlingHome()
        def guard():raise w.StopPreview('cancelled')
        d.guard_input_observation=guard
        self.assertEqual(run(d)['code'],'cancelled');self.assertEqual(d.attempts,0)

if __name__=='__main__':unittest.main()
