import subprocess
import sys
import unittest
from wecom_staging_process import capture_process

class StagingPipeTests(unittest.TestCase):
    def test_simultaneous_large_stdout_stderr_cannot_deadlock_parent_waiting_exit(self):
        p=subprocess.Popen([sys.executable,'-c',"import sys;sys.stdout.write('x'*200000);sys.stdout.flush();sys.stderr.write('y'*200000);sys.stderr.flush()"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        self.addCleanup(p.stdout.close);self.addCleanup(p.stderr.close)
        r=capture_process(p,timeout=5)
        self.assertFalse(r['pending']);self.assertEqual(r['hostExitCode'],0)
        self.assertEqual(r['stdoutBytes'],200000);self.assertEqual(r['stderrBytes'],200000)
        self.assertFalse(r['pipeDrainComplete']);self.assertEqual(r['stdout'],'')
    def test_valid_bounded_stdout_is_separate_from_nonzero_exit(self):
        p=subprocess.Popen([sys.executable,'-c',"print('{}');raise SystemExit(1)"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        self.addCleanup(p.stdout.close);self.addCleanup(p.stderr.close)
        r=capture_process(p,timeout=3)
        self.assertFalse(r['pending']);self.assertTrue(r['pipeDrainComplete']);self.assertEqual(r['stdout'],'{}\n');self.assertEqual(r['hostExitCode'],1)
    def test_live_child_timeout_remains_pending_and_is_not_implicitly_killed(self):
        p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        self.addCleanup(p.stdout.close);self.addCleanup(p.stderr.close)
        try:
            r=capture_process(p,timeout=.1);self.assertTrue(r['pending']);self.assertIsNone(p.poll())
        finally:p.kill();p.wait()

if __name__=='__main__':unittest.main()
