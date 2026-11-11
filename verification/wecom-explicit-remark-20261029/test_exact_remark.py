import unittest,tempfile,types
from pathlib import Path
from dataclasses import replace
import wecom_invite_preview as w
import wecom_remark_preview as r
from test_wecom_invite_preview import PHONE,OTHER,PROFILE,frame
from test_wecom_remark_preview import remark
import exact_remark

class Driver:
    def __init__(self,name='已有备注',mode='normal'):
        self.current=PROFILE;self.saved_page=remark(name,'原有描述');self.calls=[];self.mode=mode;self.writes=0
        self.poco=self
    def snapshot(self):return self.current
    def __call__(self,**kw):
        d=self
        node=w.unique([n for n in r.editors(self.current) if n.name==kw['name']])
        class Item:
            def attr(self,k):return {'visible':True,'enabled':True,'text':node.text,'name':node.name,'contentDescription':node.desc}[k]
            def get_position(self):return node.position
            def get_size(self):return node.size
            def set_text(self,value):
                d.writes+=1
                if d.mode=='unknown_write':raise RuntimeError('unknown_write')
                d.current=w.Screen(d.current.package,tuple(replace(n,text=value) if n==node else n for n in d.current.nodes))
                if d.mode=='other_field_changes':d.current=w.Screen(d.current.package,tuple(replace(n,text='changed') if n.name==r.DESCRIPTION_ID else n for n in d.current.nodes))
        return [Item()]
    def _guard_host(self):
        if self.mode=='lease_lost':raise w.StopPreview('device_lease_lost')
    def apply(self,action,expected,phone,check_budget,context=None):
        assert self.current==expected
        r.resolve_remark(action,expected,phone,context);self.calls.append(action)
        if action=='open_remark':self.current=self.saved_page
        elif action=='save_remark':
            if self.mode=='unknown_save':raise RuntimeError('unknown_save')
            if self.mode!='lost_persistence':self.saved_page=self.current
            self.current=PROFILE
        elif action=='close_remark':self.current=PROFILE

class Tests(unittest.TestCase):
    def setUp(self):
        self.old=r._RemarkingDriver.prepare;self.addCleanup(setattr,r._RemarkingDriver,'prepare',self.old)
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.report={}
        exact_remark.install(types.SimpleNamespace(remarks=r,w=w),self.report,Path(self.tmp.name),'yyx（坦克）')
    def run_case(self,d,phone=PHONE):
        self.wrapper=r._RemarkingDriver(d,lambda _:None,('yyx（坦克）',r.DEFAULT_DESCRIPTION))
        return self.wrapper.prepare(PROFILE,phone,lambda:None)
    def test_explicit_nonempty_override_saves_once_preserves_others_and_reopens(self):
        d=Driver();self.run_case(d)
        self.assertEqual(d.writes,1);self.assertEqual(d.calls.count('save_remark'),1)
        self.assertEqual(d.calls.count('open_remark'),2)
        self.assertEqual(next(n.text for n in r.editors(d.saved_page) if n.name==r.NAME_ID),'yyx（坦克）')
        self.assertEqual(next(n.text for n in r.editors(d.saved_page) if n.name==r.DESCRIPTION_ID),'原有描述')
        self.assertTrue(self.wrapper.saved);self.assertEqual(self.report['remarkNameVerified'],'yyx（坦克）')
    def test_already_exact_name_does_not_write_or_save(self):
        d=Driver('yyx（坦克）');self.run_case(d);self.assertEqual(d.writes,0);self.assertNotIn('save_remark',d.calls)
    def test_wrong_target_blocks_before_remark_open(self):
        d=Driver()
        with self.assertRaises(w.StopPreview):self.run_case(d,OTHER)
        self.assertFalse(d.calls)
    def test_lost_lease_blocks_before_any_write(self):
        d=Driver(mode='lease_lost')
        with self.assertRaises(w.StopPreview):self.run_case(d)
        self.assertEqual(d.writes,0);self.assertNotIn('save_remark',d.calls)
    def test_unknown_save_is_single_attempt_and_not_confirmed(self):
        d=Driver(mode='unknown_save')
        with self.assertRaises(RuntimeError):self.run_case(d)
        self.assertEqual(d.calls.count('save_remark'),1);self.assertEqual(self.wrapper.save_status,'unknown');self.assertNotIn('remarkNameVerified',self.report)
    def test_lost_persistence_blocks_confirmation(self):
        d=Driver(mode='lost_persistence')
        with self.assertRaisesRegex(w.StopPreview,'remark_persistence_unconfirmed'):self.run_case(d)
        self.assertNotIn('remarkNameVerified',self.report)
    def test_unrelated_field_change_blocks_save(self):
        d=Driver(mode='other_field_changes')
        with self.assertRaisesRegex(w.StopPreview,'remark_readback_mismatch'):self.run_case(d)
        self.assertNotIn('save_remark',d.calls)
    def test_unknown_write_is_not_replayed(self):
        d=Driver(mode='unknown_write')
        with self.assertRaises(RuntimeError):self.run_case(d)
        self.assertEqual(d.writes,1);self.assertNotIn('save_remark',d.calls)

if __name__=='__main__':unittest.main()
