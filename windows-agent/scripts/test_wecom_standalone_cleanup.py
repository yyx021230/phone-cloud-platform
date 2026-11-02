import unittest
from unittest.mock import patch
import wecom_standalone_cleanup as c
from test_wecom_screen_lease import fixture
from test_wecom_platform_preview import HostGuardTests

R=dict(readerStarted=True,pid='123',startToken='456',forwards=[[23456,10080]],cleanupConfirmed=False)
H=[dict(pid=101,createdAt=1.5),dict(pid=102,createdAt=2.5)]

class CleanupGenerationTests(unittest.TestCase):
    def test_no_cleanup_while_either_original_host_alive(self):
        for alive in (101,102):
            with self.assertRaises(ValueError):c.validate_scope(R,H,lambda pid:next(h['createdAt']for h in H if h['pid']==pid)if pid==alive else None)
    def test_gone_or_replaced_original_hosts_are_not_killed(self):
        c.validate_scope(R,H,lambda pid:None)
        c.validate_scope(R,H,lambda pid:99)
    def test_inspection_error_is_not_process_absence(self):
        with self.assertRaises(PermissionError):c.validate_scope(R,H,lambda pid:(_ for _ in ()).throw(PermissionError()))
    def test_cleanup_has_no_preview_runner_or_send_path(self):
        task=HostGuardTests().config('23');binding=fixture()[0]
        envelope=dict(task=task,reservation=dict(binding,purpose='preview'),resources=R,originalHosts=H)
        with patch.object(c.host,'run_host',side_effect=AssertionError('no preview')),patch.object(c,'cleanup_reader',side_effect=AssertionError('no cleanup before scope')):
            with self.assertRaises(ValueError):c.execute(envelope,process=lambda pid:None)
    def test_scope_binds_resources_and_both_process_incarnations(self):
        h=c.scope_fingerprint(R,H)
        self.assertNotEqual(h,c.scope_fingerprint(dict(R,pid='124'),H))
        self.assertNotEqual(h,c.scope_fingerprint(R,[H[0],dict(H[1],createdAt=3)]))
    def test_failed_input_generation_stays_revoked_and_cleanup_requires_new_purpose(self):
        from wecom_screen_lease import ScreenAuthority
        binding=fixture()[0];a=ScreenAuthority(binding)
        self.assertFalse(a.check(dict(mode='send')));self.assertTrue(a.revoked)
        self.assertFalse(a.check_cleanup({}))
        b=ScreenAuthority(dict(binding,purpose='cleanup',authorityGeneration='b'*32))
        self.assertFalse(b.check(dict(mode='preview')));self.assertTrue(b.revoked)
    def test_arbitrary_packages_ports_and_pid_text_cannot_enter_cleanup(self):
        for change in ({'pid':'1;input tap 1 1'},{'forwards':[[5037,10080]]},{'forwards':[[30001,22]]},{'extra':'arbitrary'}):
            with self.assertRaises(ValueError):c.validate_scope(dict(R,**change),H,lambda pid:None)

if __name__=='__main__':unittest.main()
