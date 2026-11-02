import copy
import json
from pathlib import Path
import unittest
from types import SimpleNamespace
from wecom_cleanup import MAIN,TEST
from wecom_cleanup_verify import execute,validate_config,timestamp
from wecom_physical_verify import VerifyStop

FIXTURE=json.loads((Path(__file__).resolve().parents[2]/'verification/wecom-cleanup-v1/fixtures.json').read_text())

class VerifyWireTests(unittest.TestCase):
    def context(self):
        p=copy.deepcopy(FIXTURE['verificationPayload']);b=p.pop('physicalCleanup');p['pickedAt']=FIXTURE['verificationPickedAt']
        value=dict(p,physicalCleanup=b,taskId=p['verificationTaskId'],deviceId=b['deviceId'],serial=b['serial'],agentId=b['agentId'],serverBaseUrl='http://127.0.0.1:1',agentToken='fixture-only')
        now=[0.];base=timestamp(FIXTURE['serverNow']);calls=[]
        class Adb:
            def __init__(self,serial,guard,budget,operation_guard):self.authority=operation_guard
            def pids(self,package):self.authority();calls.append(package);now[0]+=.05;return[]
            def forwards(self):self.authority();calls.append('forwards');now[0]+=.05;return[]
        kwargs=dict(clock=lambda:now[0],wall=lambda:base+now[0],runtime_factory=lambda:SimpleNamespace(check=lambda:True),
            process_created_at=lambda _:None,closed_hosts=lambda _:True,adb_factory=Adb,
            sleep=lambda seconds:now.__setitem__(0,now[0]+seconds),lease_request=lambda url,token:{'valid':True})
        return value,kwargs,calls,now

    def test_fixed_wire_scope_and_two_earliest_fact_frames_without_writes(self):
        value,kwargs,calls,now=self.context();proof=execute(value,**kwargs)
        self.assertEqual(proof['binding'],FIXTURE['binding']);self.assertEqual(proof['verificationTaskId'],value['taskId'])
        self.assertEqual(calls,[MAIN,TEST,'forwards']*2)
        self.assertTrue(all(frame['packagesAbsent']is True and frame['serialForwardCount']==0 for frame in proof['snapshots']))
        first=timestamp(proof['snapshots'][0]['observedAt'])
        self.assertLess(first,timestamp(FIXTURE['serverNow']));self.assertGreater(first,timestamp(FIXTURE['verificationPickedAt']))
        old=proof['snapshots'][0]['observedAt'];now[0]+=10;self.assertEqual(proof['snapshots'][0]['observedAt'],old)

    def test_phone_or_business_payload_cannot_enter_verify_config(self):
        value,_,_,_=self.context()
        for key in ('phoneNumber','remarkName','mode','claimDirectory'):
            bad=dict(value,**{key:'private'})
            with self.assertRaisesRegex(VerifyStop,'wecom_cleanup_config_invalid'):validate_config(bad)

    def test_current_verification_identity_must_match(self):
        value,_,_,_=self.context()
        for key in ('taskId','deviceId','serial','agentId'):
            bad=dict(value,**{key:'other'})
            with self.assertRaises(VerifyStop):validate_config(bad)

    def test_historical_id_case_does_not_rewrite_actual_selector(self):
        value,_,_,_=self.context();value['deviceId']=value['physicalCleanup']['deviceId']='adb:FIXTURE'
        self.assertEqual(validate_config(value)['serial'],'fixture')
        bad=copy.deepcopy(value);bad['serial']='FIXTURE'
        with self.assertRaisesRegex(VerifyStop,'wecom_cleanup_binding_mismatch'):validate_config(bad)
        value['deviceId']=value['physicalCleanup']['deviceId']='adb:other'
        with self.assertRaisesRegex(VerifyStop,'wecom_cleanup_binding_mismatch'):validate_config(value)

    def test_lost_lease_or_missing_host_exit_never_reads_phone(self):
        for lease,closed in ((False,True),(True,False),(1,True)):
            value,kwargs,calls,_=self.context();kwargs['lease_request']=lambda *a:{'valid':lease};kwargs['closed_hosts']=lambda _:closed
            with self.assertRaises(VerifyStop):execute(value,**kwargs)
            self.assertFalse(calls)

    def test_system_guard_rejection_happens_before_any_lease_or_phone(self):
        value,kwargs,calls,_=self.context()
        def refused():raise VerifyStop('wecom_agent_entry_unconfirmed')
        kwargs['runtime_factory']=refused;kwargs['lease_request']=lambda *a:self.fail('no lease')
        with self.assertRaisesRegex(VerifyStop,'wecom_agent_entry_unconfirmed'):execute(value,**kwargs)
        self.assertFalse(calls)

    def test_slow_first_frame_is_rejected_not_restamped_at_serialize(self):
        value,kwargs,calls,now=self.context()
        class Slow:
            def __init__(self,*a,**k):pass
            def pids(self,p):calls.append(p);now[0]+=1.9 if len(calls)<=3 else 0;return[]
            def forwards(self):calls.append('forwards');now[0]+=1.9 if len(calls)<=3 else 0;return[]
        kwargs['adb_factory']=Slow
        with self.assertRaisesRegex(VerifyStop,'wecom_tool_proof_stale'):execute(value,**kwargs)

    def test_residual_reader_or_legal_scrcpy_forward_cannot_generate_proof(self):
        for target in ('reader','media'):
            value,kwargs,_,_=self.context()
            class Residual:
                def __init__(self,*a,**k):pass
                def pids(self,p):return['111']if target=='reader'and p==TEST else[]
                def forwards(self):return[('fixture','tcp:40000','localabstract:scrcpy')]if target=='media'else[]
            kwargs['adb_factory']=Residual
            with self.assertRaisesRegex(VerifyStop,'wecom_(reader|forward)_still_present'):execute(value,**kwargs)

    def test_cancel_or_expired_verification_has_no_fallback_reads(self):
        value,kwargs,calls,_=self.context();kwargs['cancelled']=lambda:True
        with self.assertRaisesRegex(VerifyStop,'wecom_cleanup_cancelled'):execute(value,**kwargs)
        self.assertFalse(calls)
        value,kwargs,calls,_=self.context();kwargs['wall']=lambda:timestamp(value['expiresAt'])+1
        with self.assertRaisesRegex(VerifyStop,'wecom_cleanup_verify_timeout'):execute(value,**kwargs)
        self.assertFalse(calls)

if __name__=='__main__':unittest.main()
