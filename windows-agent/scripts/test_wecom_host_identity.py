import unittest
from types import SimpleNamespace as O
from test_wecom_system_runtime import Runtime
from wecom_host_identity import host_reference,reader_hosts,original_hosts_closed,creation_token
from wecom_physical_verify import VerifyStop

MACHINE='a'*64
class Missing(Exception):pass
class Hosts(Runtime):
    NoSuchProcess=Missing
    def __init__(self):
        super().__init__();self.rows[1]['parent']=9;self.rows[9]=dict(self.rows[1],parent=99)
    def Process(self,pid):
        if pid not in self.rows:raise Missing()
        value=super().Process(pid);value.cmdline=lambda:['D:\\PhoneCloud\\tools\\node\\node.exe','D:\\PhoneCloud\\agent\\src\\index.mjs'];return value

class HostIdentityTests(unittest.TestCase):
    def ready(self,r):return reader_hosts(runtime=r,current_pid=2,parent_pid=1,platform='nt',machine=lambda:MACHINE)
    def test_reader_reports_only_its_own_host_with_real_agent_parent_alive(self):
        r=Hosts();refs=self.ready(r)
        self.assertEqual([h['pid']for h in refs],[2]);self.assertEqual([h['role']for h in refs],['reader'])
        self.assertEqual(refs[0]['creationToken'],float(20).hex());self.assertEqual(refs[0]['machineId'],MACHINE)
    def test_live_host_is_not_closed_even_when_iso_rounds_to_same_millisecond(self):
        r=Hosts();r.rows[2]['created']=1760000000.1234567;refs=self.ready(r)
        self.assertFalse(original_hosts_closed(refs,runtime=r,machine=lambda:MACHINE))
        self.assertFalse(original_hosts_closed(refs,runtime=r,machine=lambda:MACHINE))
    def test_absent_or_different_exact_creation_token_confirms_only_old_hosts_gone(self):
        r=Hosts();refs=self.ready(r);r.rows[2]['created']+=1
        self.assertTrue(original_hosts_closed(refs,runtime=r,machine=lambda:MACHINE))
    def test_other_machine_and_legacy_missing_token_cannot_prove_close(self):
        r=Hosts();refs=self.ready(r)
        with self.assertRaisesRegex(VerifyStop,'wecom_original_machine_mismatch'):original_hosts_closed(refs,runtime=r,machine=lambda:'b'*64)
        del refs[0]['creationToken']
        with self.assertRaisesRegex(VerifyStop,'wecom_original_host_unconfirmed'):original_hosts_closed(refs,runtime=r,machine=lambda:MACHINE)
    def test_non_system_or_non_agent_parent_cannot_issue_ready(self):
        r=Hosts();r.rows[1]['owner']='Administrator'
        with self.assertRaises(VerifyStop):self.ready(r)
        r=Hosts();r.Process=lambda pid:O(create_time=lambda:10,username=lambda:'private',exe=lambda:'private')
        with self.assertRaises(VerifyStop):self.ready(r)
    def test_precision_token_and_audit_time_must_correspond(self):
        r=Hosts();refs=self.ready(r);refs[0]['createdAt']='1970-01-01T00:00:21.000Z'
        with self.assertRaisesRegex(VerifyStop,'wecom_original_host_unconfirmed'):original_hosts_closed(refs,runtime=r,machine=lambda:MACHINE)
        for value in (True,float('inf'),-1):
            with self.assertRaises(VerifyStop):creation_token(value)

    def test_zombie_or_other_no_such_subclass_is_not_a_close_proof(self):
        class Zombie(Missing):pass
        r=Hosts();refs=self.ready(r)
        def process(_):raise Zombie()
        r.Process=process
        with self.assertRaisesRegex(VerifyStop,'wecom_original_host_unconfirmed'):original_hosts_closed(refs,runtime=r,machine=lambda:MACHINE)

if __name__=='__main__':unittest.main()
