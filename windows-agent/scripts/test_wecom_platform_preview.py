import copy
import io
import os
import subprocess
import sys
from pathlib import Path
import json
import unittest
from unittest.mock import patch
import wecom_platform_preview as host

class HostGuardTests(unittest.TestCase):
    def config(self, number="25"):
        row=host.DEVICES[number]
        return dict(taskId="fixture-task",deviceId="adb:"+row["serial"],serial=row["serial"],deviceNumber=number,
                    androidUser=row["androidUser"],phoneNumber="13800138000",previewOnly=True,
                    agentId="fixture-agent",serverBaseUrl="http://127.0.0.1:8787",agentToken="fixture-only-token")

    def test_all_eight_exact_devices_and_users(self):
        self.assertEqual(len(host.DEVICES),8)
        for number in host.DEVICES:self.assertEqual(host.validate_config(self.config(number))["androidUser"],999 if number=="155" else 0)

    def test_invalid_binding_or_send_flag_stops_before_network(self):
        changes=[dict(deviceNumber="67"),dict(serial="OTHER"),dict(deviceId="adb:OTHER"),dict(androidUser=999),dict(previewOnly=False),dict(send=True),dict(agentId="a/other"),dict(serverBaseUrl="http://user:pass@example.invalid")]
        for change in changes:
            with self.subTest(change=change),patch.object(host,"adb_identity",side_effect=AssertionError("no network")):
                with self.assertRaises((host.SafeStop,host.w.StopPreview)):host.run_host(dict(self.config(),**change))

    def test_lost_lease_stops_before_any_phone_command(self):
        with patch.object(host,"adb_identity",return_value=1),patch.object(host,"lease_valid",return_value=False),patch.object(host,"shell",side_effect=AssertionError("no shell")):
            with self.assertRaisesRegex(host.SafeStop,"device_lease_lost"):host.run_host(self.config())

    def test_no_redirected_credentials(self):
        self.assertIsNone(host.NoRedirect().redirect_request(None,None,None,None,None,None))

    def test_dependency_exception_never_leaks_credentials_or_target(self):
        value=self.config(); stdout=io.StringIO()
        with patch("sys.stdin",io.StringIO(json.dumps(value)+"\n")),patch("sys.stdout",stdout),patch.object(host,"start_control_monitor"),patch.object(host,"run_host",side_effect=RuntimeError(value["phoneNumber"]+value["agentToken"])):
            host.main()
        result=json.loads(stdout.getvalue());self.assertFalse(result["invitationSent"])
        self.assertNotIn(value["phoneNumber"],stdout.getvalue());self.assertNotIn(value["agentToken"],stdout.getvalue())

    def test_parent_pipe_eof_cancels_orphan_before_further_actions(self):
        read,write=os.pipe();os.close(write);host.CANCELLED.clear()
        try:
            host.watch_control_fd(read);self.assertTrue(host.CANCELLED.is_set())
        finally:os.close(read);host.CANCELLED.clear()

    def test_cancel_command_uses_os_pipe_without_buffered_stdin_lock(self):
        read,write=os.pipe();host.CANCELLED.clear()
        try:
            os.write(write,b"cancel\n");host.watch_control_fd(read)
            self.assertTrue(host.CANCELLED.is_set())
        finally:os.close(read);os.close(write);host.CANCELLED.clear()

    def test_native_child_exits_with_control_pipe_open_without_buffered_reader_abort(self):
        process=subprocess.Popen([sys.executable,str(Path(host.__file__))],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            process.stdin.write(b"{}\n");process.stdin.flush()
            self.assertEqual(process.wait(timeout=6),0)
            self.assertEqual(json.loads(process.stdout.read())["previewCode"],"invalid_preview_config")
            self.assertEqual(process.stderr.read(),b"")
        finally:
            if process.poll() is None:process.kill();process.wait()
            process.stdin.close();process.stdout.close();process.stderr.close()

if __name__=="__main__":unittest.main()
