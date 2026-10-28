import copy
from types import SimpleNamespace
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

    def test_instrumentation_failure_cleans_own_process_created_before_health_check(self):
        calls=[]; counts={"pid":0}; clock=[0]
        def now(): clock[0]+=.5;return clock[0]
        stat="123 (poco service) "+" ".join(["S"]+["0"]*18+["789"])
        def shell(cmd,keep=False):
            calls.append(cmd)
            if cmd.startswith("pm "):return "package:fixture"
            if cmd.startswith("pidof "):
                counts["pid"]+=1;return "" if counts["pid"]<=2 else "123"
            if cmd.startswith("cat /proc/"):return stat
            if keep:return SimpleNamespace(close=lambda:calls.append("instrument_closed"))
            return ""
        sock=SimpleNamespace(close=lambda:None)
        with patch.object(host,"adb_identity",return_value=1),patch.object(host,"lease_valid",return_value=True),patch.object(host,"shell",side_effect=shell),patch.object(host,"host",return_value="12345"),patch.object(host,"health",return_value=False),patch.object(host,"connection",return_value=sock),patch.object(host,"command"),patch.object(host.time,"monotonic",side_effect=now),patch.object(host.time,"sleep"):
            with self.assertRaisesRegex(host.SafeStop,"poco_not_ready"):host.run_host(self.config())
        self.assertIn("am force-stop com.netease.open.pocoservice",calls)
        self.assertIn("instrument_closed",calls)
        self.assertNotIn("input keyevent 224",calls)

    def test_instrumentation_replacement_is_cleaned_when_health_never_becomes_ready(self):
        calls=[]; count=[0]; clock=[0]
        def now():clock[0]+=.5;return clock[0]
        def shell(cmd,keep=False):
            calls.append(cmd)
            if cmd.startswith("pm "):return "package:fixture"
            if cmd.startswith("pidof "):
                count[0]+=1;return "" if count[0]==1 else "123" if count[0]==2 else "456"
            if cmd.startswith("cat /proc/"):
                return "123 (poco) "+" ".join(["S"]+["0"]*18+["789" if "123" in cmd else "790"])
            if keep:return SimpleNamespace(close=lambda:None)
            return ""
        with patch.object(host,"adb_identity",return_value=1),patch.object(host,"lease_valid",return_value=True),patch.object(host,"shell",side_effect=shell),patch.object(host,"host",return_value="12345"),patch.object(host,"health",return_value=False),patch.object(host,"connection",return_value=SimpleNamespace(close=lambda:None)),patch.object(host,"command"),patch.object(host.time,"monotonic",side_effect=now),patch.object(host.time,"sleep"):
            with self.assertRaisesRegex(host.SafeStop,"poco_not_ready"):host.run_host(self.config())
        self.assertIn("am force-stop com.netease.open.pocoservice",calls)
        self.assertNotIn("input keyevent 224",calls)

    def test_process_ownership_token_rejects_missing_or_malformed_stat(self):
        self.assertEqual(host.process_start_token("bad"),"")
        self.assertEqual(host.process_start_token("123 (poco) S 0"),"")

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
