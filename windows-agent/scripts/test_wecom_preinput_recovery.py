import copy
import types
import unittest
from wecom_preinput_recovery import execute,quiescent_processes,PeerSocket
from wecom_physical_verify import HostRef,VerifyStop

MACHINE='a'*64
OLD={'pid':100,'creationToken':float(1700000000).hex(),'machineId':MACHINE}
class Process:
    def __init__(self,pid,name,args):self.pid,self._name,self.args=pid,name,args
    def name(self):return self._name
    def cmdline(self):return self.args
class Guard:
    current_pid=300;agent_pid=200
    agent=types.SimpleNamespace(host=HostRef(200,1700000100))
    adb=types.SimpleNamespace(host=HostRef(500,1700000000),exe='d:/phonecloud/tools/android-sdk/platform-tools/adb.exe',owner=r'NT AUTHORITY\SYSTEM')
    def __init__(self,**kwargs):pass
    def check(self):return True
class Fixture:
    def __init__(self):
        self.now=0;self.calls=[];self.alive=None;self.workers=[];self.leftovers=();self.target_forwards=();self.denied=False
        self.value={'taskId':'verify','deviceId':'adb:synthetic155','serial':'synthetic155','agentId':'fixture-agent','serverBaseUrl':'http://127.0.0.1:10000','agentToken':'synthetic-token',
            'physicalCleanup':dict(version=1,obligationId='obligation',originalTaskId='original',executionId='execution',deviceId='adb:synthetic155',serial='synthetic155',agentId='fixture-agent',appSlot='main',androidUser=0,nonce='nonce'),
            'preinputRecovery':'wecom-preinput-recovery-v1','verificationId':'v','verificationNonce':'nonce-v','verificationTaskId':'verify','issuedAt':'2026-11-03T09:00:00.000Z',
            'retiredProducer':OLD,'causalLease':dict(protocol='wecom-causal-v1',epoch='epoch',leaseId='lease',purpose='verification'),
            'challenge':dict(protocol='wecom-causal-v1',epoch='epoch',verificationLeaseId='lease',challengeId='challenge')}
    def sleep(self,ms):self.now+=ms
    def processes(self):return [Process(200,'node.exe',['node',r'D:\PhoneCloud\agent\src\index.mjs']),Process(300,'python.exe',['python','self']),*self.workers]
    def adb(self,serial,guard,budget,**options):
        self.assert_serial=serial;f=self
        class Adb:
            def pids(self,p):f.calls.append(('pid',p));guard();return f.leftovers
            def forwards(self):f.calls.append(('forwards',serial));return f.target_forwards
        return Adb()
    def request(self,url,token):
        self.calls.append(('lease',url))
        if '/recovery-lease?'not in url:raise AssertionError('wrong authority')
        return {'valid':not self.denied,'remainingMs':100000,'causalLease':self.value['causalLease']}
    def run(self,**overrides):
        kwargs=dict(runtime=object(),processes=self.processes,process_created_at=lambda p:self.alive,machine=lambda:MACHINE,
            runtime_factory=Guard,adb_factory=self.adb,request=self.request,clock=lambda:self.now,wall=lambda:1700000000,sleep=self.sleep)
        kwargs.update(overrides);return execute(copy.deepcopy(self.value),**kwargs)

class RecoveryTests(unittest.TestCase):
    def test_two_fresh_readonly_frames_allow_other_lookup_workers(self):
        f=Fixture();f.workers=[Process(700,'python.exe',['python',r'D:\PhoneCloud\agent\scripts\alipay_name_lookup.py']),Process(701,'python.exe',['python',r'D:\PhoneCloud\agent\scripts\lookup_ocr_worker.py'])]
        proof=f.run();self.assertEqual(len(proof['snapshots']),2);self.assertGreater(proof['snapshots'][1]['elapsedMs'],proof['snapshots'][0]['elapsedMs'])
        self.assertEqual(proof['retiredProducer'],OLD);self.assertEqual(proof['observer']['pid'],200)
        self.assertEqual(f.assert_serial,'synthetic155');self.assertEqual([c[0]for c in f.calls].count('pid'),4)
        self.assertNotIn('hosts',proof);self.assertTrue(all(s['producerRetired']and s['wecomWorkersAbsent']for s in proof['snapshots']))
    def test_old_producer_alive_blocks_before_adb(self):
        f=Fixture();f.alive=float.fromhex(OLD['creationToken'])
        with self.assertRaisesRegex(VerifyStop,'still_alive'):f.run()
        self.assertEqual(f.calls,[])
    def test_reused_old_pid_is_not_old_generation(self):
        f=Fixture();f.alive=1700000001;self.assertEqual(len(f.run()['snapshots']),2)
    def test_machine_mismatch_blocks(self):
        f=Fixture()
        with self.assertRaisesRegex(VerifyStop,'machine_mismatch'):f.run(machine=lambda:'b'*64)
        self.assertEqual(f.calls,[])
    def test_unretired_parent_blocks(self):
        f=Fixture();f.value['retiredProducer']={**OLD,'pid':200,'creationToken':float(1700000100).hex()}
        with self.assertRaisesRegex(VerifyStop,'not_retired'):f.run()
    def test_unknown_process_cannot_be_treated_as_absent(self):
        for args in (['python','-c','unknown'],['python',r'D:\PhoneCloud\agent\scripts\wecom_invite_host.py']):
            f=Fixture();f.workers=[Process(800,'python.exe',args)]
            with self.assertRaisesRegex(VerifyStop,'worker_present'):f.run()
            self.assertEqual(f.calls,[])
    def test_second_agent_blocks(self):
        f=Fixture();f.workers=[Process(201,'node.exe',['node',r'D:\PhoneCloud\agent\src\index.mjs'])]
        with self.assertRaisesRegex(VerifyStop,'producer_unconfirmed'):f.run()
    def test_existing_package_or_target_forward_blocks_without_cleanup(self):
        for kind in ('package','forward'):
            f=Fixture()
            if kind=='package':f.leftovers=('123',)
            else:f.target_forwards=(('synthetic155','tcp:10080','tcp:10080'),)
            with self.assertRaisesRegex(VerifyStop,'still_present'):f.run()
            self.assertTrue(all(c[0]in('pid','forwards','lease')for c in f.calls))
    def test_lease_lost_cancel_and_timeout_block(self):
        f=Fixture();f.denied=True
        with self.assertRaisesRegex(VerifyStop,'lease_lost|causal_context_unconfirmed'):f.run()
        self.assertEqual([c for c in f.calls if c[0]=='pid'],[])
        with self.assertRaisesRegex(VerifyStop,'cancelled'):Fixture().run(cancelled=lambda:True)
        f=Fixture()
        with self.assertRaisesRegex(VerifyStop,'timeout'):f.run(sleep=lambda s:setattr(f,'now',4))
    def test_second_frame_rechecks_workers(self):
        f=Fixture()
        def change(s):f.sleep(s);f.workers.append(Process(900,'python.exe',['python','unknown']))
        with self.assertRaisesRegex(VerifyStop,'worker_present'):f.run(sleep=change)
        self.assertEqual(len([c for c in f.calls if c[0]=='pid']),2)


class OwnedProcess(Process):
    def __init__(self,pid,args,parent=200,owner=r'NT AUTHORITY\SYSTEM',exe=r'D:\PhoneCloud\tools\python39\python.exe'):
        super().__init__(pid,'python.exe',args);self.parent,self.owner,self.path=parent,owner,exe
    def ppid(self):return self.parent
    def username(self):return self.owner
    def exe(self):return self.path
    def create_time(self):return float(self.pid)

class OtherPhoneTests(unittest.TestCase):
    def root(self,serial='other-phone'):
        return OwnedProcess(700,['python',r'D:\PhoneCloud\agent\scripts\xhs_airtest_poco.py','--serial',serial,'--mode','worker','--adb-path',r'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe'])
    def test_actual_other_phone_worker_and_nested_isolated_helpers_do_not_block(self):
        f=Fixture();f.workers=[self.root(),OwnedProcess(701,['python','-I','-u',r'D:\PhoneCloud\agent\scripts\lookup_ocr_worker.py'],parent=700,exe=r'D:\PhoneCloud\agent\runtime\lookup-ocr\Scripts\python.exe'),OwnedProcess(702,['python','-I','-u',r'D:\PhoneCloud\agent\scripts\lookup_ocr_worker.py'],parent=701)]
        self.assertTrue(f.run()['snapshots'][1]['wecomWorkersAbsent'])
    def test_worker_on_target_still_blocks_even_with_different_serial_case(self):
        f=Fixture();f.workers=[self.root('SYNTHETIC155')]
        with self.assertRaisesRegex(VerifyStop,'worker_present'):f.run()
    def test_same_wrapper_requires_an_explicit_target_context(self):
        f=Fixture();f.workers=[self.root()]
        with self.assertRaisesRegex(VerifyStop,'worker_present'):quiescent_processes(f.processes,self_pid=300,agent_pid=200,budget=lambda:None)
    def test_exited_process_is_absent_but_denied_or_unknown_process_is_not(self):
        import psutil
        class Exited(Process):
            def name(self):raise psutil.NoSuchProcess(self.pid)
        f=Fixture();f.workers=[Exited(901,'python.exe',[])];self.assertTrue(f.run()['snapshots'][1]['wecomWorkersAbsent'])
        class Denied(Process):
            def name(self):raise psutil.AccessDenied(self.pid)
        f=Fixture();f.workers=[Denied(901,'python.exe',[])]
        with self.assertRaisesRegex(VerifyStop,'processes_unconfirmed'):f.run()
    def test_reused_parent_pid_cannot_give_child_another_phone_scope(self):
        f=Fixture();root=self.root();child=OwnedProcess(701,['python','-I','-u',r'D:\PhoneCloud\agent\scripts\lookup_ocr_worker.py'],parent=700)
        child.create_time=lambda:600.0;f.workers=[root,child]
        with self.assertRaisesRegex(VerifyStop,'worker_present'):f.run()
    def test_bad_root_and_unknown_children_remain_fenced(self):
        for mutation in ['owner','exe','parent','mode','duplicate','missing_serial','wrong_adb','unknown_child','unknown_isolated_code','orphan','cycle']:
            with self.subTest(mutation=mutation):
                f=Fixture();root=self.root();f.workers=[root]
                if mutation=='owner':root.owner='Administrator'
                elif mutation=='exe':root.path=r'C:\other\python.exe'
                elif mutation=='parent':root.parent=999
                elif mutation=='mode':root.args[root.args.index('--mode')+1]='run'
                elif mutation=='duplicate':root.args+=['--serial','second']
                elif mutation=='missing_serial':del root.args[2:4]
                elif mutation=='wrong_adb':root.args[-1]=r'C:\other\adb.exe'
                elif mutation=='unknown_child':f.workers.append(OwnedProcess(701,['python','unknown.py'],parent=700))
                elif mutation=='unknown_isolated_code':f.workers.append(OwnedProcess(701,['python','-I','-c','unknown'],parent=700))
                elif mutation=='orphan':f.workers.append(OwnedProcess(701,['python','-I'],parent=999))
                elif mutation=='cycle':f.workers.extend([OwnedProcess(701,['python','-I'],parent=702),OwnedProcess(702,['python','-I'],parent=701)])
                with self.assertRaisesRegex(VerifyStop,'worker_present'):f.run()

class Wire:
    def __init__(self):self.sent=[];self.fd=10
    def getsockname(self):return('127.0.0.1',40000)
    def getpeername(self):return('127.0.0.1',5037)
    def fileno(self):return self.fd
    def sendall(self,b):self.sent.append(b)
class PeerTests(unittest.TestCase):
    def test_actual_reverse_owner_required_before_any_bytes(self):
        w=Wire();g=Guard();runtime=types.SimpleNamespace(net_connections=lambda **k:[])
        with self.assertRaisesRegex(VerifyStop,'peer_unconfirmed'):PeerSocket(w,g,runtime,lambda:None)
        self.assertEqual(w.sent,[])
    def test_endpoint_reuse_blocks_before_send(self):
        w=Wire();g=Guard();row=types.SimpleNamespace(status='ESTABLISHED',laddr=('127.0.0.1',5037),raddr=('127.0.0.1',40000),pid=500)
        class P:
            def create_time(self):return 1700000000
            def exe(self):return r'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe'
            def username(self):return r'NT AUTHORITY\SYSTEM'
        runtime=types.SimpleNamespace(net_connections=lambda **k:[row],Process=lambda pid:P())
        # Production compares full ProcessIdentity; use its actual immutable type.
        from wecom_system_runtime import ProcessIdentity
        g.adb=ProcessIdentity(HostRef(500,1700000000),'d:/phonecloud/tools/android-sdk/platform-tools/adb.exe',r'NT AUTHORITY\SYSTEM')
        peer=PeerSocket(w,g,runtime,lambda:None);w.fd=11
        with self.assertRaisesRegex(VerifyStop,'peer_unconfirmed'):peer.sendall(b'0000')
        self.assertEqual(w.sent,[])

if __name__=='__main__':unittest.main()
