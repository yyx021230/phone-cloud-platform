import unittest
from types import SimpleNamespace as O
from wecom_system_runtime import SYSTEM,SystemRuntimeGuard,VerifyStop

class Runtime:
    def __init__(self):
        self.rows={1:dict(exe='D:\\PhoneCloud\\tools\\node\\node.exe',owner=SYSTEM,created=10,parent=99),2:dict(exe='D:\\PhoneCloud\\tools\\python39\\python.exe',owner=SYSTEM,created=20,parent=1),3:dict(exe='D:\\PhoneCloud\\tools\\android-sdk\\platform-tools\\adb.exe',owner=SYSTEM,created=30,parent=99)}
        self.listeners=[3]
    def Process(self,pid):
        row=self.rows[pid]
        return O(create_time=lambda:row['created'],username=lambda:row['owner'],exe=lambda:row['exe'],ppid=lambda:row['parent'],cmdline=lambda:[row['exe'],row.get('entry','D:/PhoneCloud/agent/src/index.mjs')])
    def net_connections(self,kind):return[O(pid=pid,status='LISTEN',laddr=O(port=5037))for pid in self.listeners]

class RuntimeGuardTests(unittest.TestCase):
    def guard(self,runtime):return SystemRuntimeGuard(runtime=runtime,current_pid=2,parent_pid=1,agent_pid=1,platform='nt')
    def test_same_original_system_agent_adb_and_child_are_read_only(self):
        r=Runtime();g=self.guard(r);self.assertTrue(g.check());self.assertEqual(g.adb.host.pid,3)
    def test_other_platform_or_non_parent_agent_is_rejected(self):
        with self.assertRaisesRegex(VerifyStop,'wecom_windows_system_required'):SystemRuntimeGuard(runtime=Runtime(),platform='posix')
        with self.assertRaisesRegex(VerifyStop,'wecom_agent_parent_unconfirmed'):SystemRuntimeGuard(runtime=Runtime(),current_pid=2,parent_pid=1,agent_pid=9,platform='nt')
    def test_admin_worker_agent_or_adb_cannot_be_accepted(self):
        for pid in (1,2,3):
            r=Runtime();r.rows[pid]['owner']='Administrator'
            with self.assertRaisesRegex(VerifyStop,'wecom_system_identity_unconfirmed'):self.guard(r)
    def test_missing_duplicate_or_wrong_binary_adb_never_gets_a_client(self):
        for listeners in ([],[3,None],[3,4]):
            r=Runtime();r.listeners=listeners
            with self.assertRaisesRegex(VerifyStop,'wecom_adb_listener_unconfirmed'):self.guard(r)
        r=Runtime();r.rows[3]['exe']='D:\\other\\adb.exe'
        with self.assertRaisesRegex(VerifyStop,'wecom_system_identity_unconfirmed'):self.guard(r)
    def test_original_pid_reuse_or_disappearance_revokes(self):
        for pid in (1,2,3):
            r=Runtime();g=self.guard(r);r.rows[pid]['created']+=1
            with self.assertRaisesRegex(VerifyStop,'wecom_system_runtime_changed'):g.check()
            r=Runtime();g=self.guard(r);del r.rows[pid]
            with self.assertRaisesRegex(VerifyStop,'wecom_system_identity_unconfirmed'):g.check()
    def test_runtime_parent_or_listener_change_is_rejected(self):
        r=Runtime();g=self.guard(r);r.rows[2]['parent']=99
        with self.assertRaisesRegex(VerifyStop,'wecom_agent_parent_unconfirmed'):g.check()
        r=Runtime();g=self.guard(r);r.listeners=[]
        with self.assertRaisesRegex(VerifyStop,'wecom_adb_listener_unconfirmed'):g.check()
    def test_system_node_with_other_entry_is_not_the_agent(self):
        r=Runtime();r.rows[1]['entry']='D:/PhoneCloud/staging/oneshot.mjs'
        with self.assertRaisesRegex(VerifyStop,'wecom_agent_entry_unconfirmed'):self.guard(r)

if __name__=='__main__':unittest.main()
