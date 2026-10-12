"""Failure-injection tests; no devices, network or real subprocesses."""
import importlib.util
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

RUNNER = Path(os.environ.get("LOOKUP_RUNNER_UNDER_TEST", str(Path(__file__).parents[1] / "windows-agent/scripts/alipay_name_lookup.py")))
spec = importlib.util.spec_from_file_location("lookup_transport_candidate", RUNNER)
lookup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lookup)

class Clock:
    def __init__(self): self.now = 0.0
    def monotonic(self): return self.now
    def sleep(self, seconds): self.now += seconds

class RecoveryTests(unittest.TestCase):
    def exercise(self, failure="adb.exe: device 'LOCAL' not found", states=None, second_failure=False, timeout_probe=False):
        clock, commands = Clock(), []
        states = iter(states or ["offline", "device", "device"])
        mkdir_calls = 0
        def run(argv, **kwargs):
            nonlocal mkdir_calls
            self.assertEqual(argv[:3], ["adb", "-s", "LOCAL"])
            args = argv[3:]
            commands.append(args)
            stdout, stderr, code = "", "", 0
            if args == ["get-state"]:
                self.assertLessEqual(kwargs["timeout"], 2.0)
                if timeout_probe:
                    clock.now += kwargs["timeout"]
                    raise subprocess.TimeoutExpired(argv, kwargs["timeout"])
                stdout = next(states, "offline")
                if stdout.startswith("error: "):
                    code, stderr, stdout = 1, stdout, ""
            elif args[:3] == ["shell", "mkdir", "-p"]:
                mkdir_calls += 1
                if failure and (mkdir_calls == 1 or second_failure):
                    code, stderr = 1, failure
            elif args[:3] == ["shell", "uiautomator", "dump"]:
                pass
            elif args[:2] == ["exec-out", "cat"]:
                stdout = b'<hierarchy><node text="fixture" /></hierarchy>'
            else:
                self.fail("Unexpected side effect: " + repr(args))
            return subprocess.CompletedProcess(argv, code, stdout=stdout, stderr=stderr)
        runner = lookup.Runner({"serial": "LOCAL", "taskId": "transport-fixture"})
        with patch.object(lookup.subprocess, "run", side_effect=run), patch.object(lookup.time, "monotonic", clock.monotonic), patch.object(lookup.time, "sleep", clock.sleep):
            try:
                root, _ = runner.dump("fixture", command_timeout=3, read_timeout=2, allow_tty_fallback=False)
                outcome = root.tag
            except RuntimeError as exc:
                outcome = str(exc)
        return outcome, commands, clock.now, runner.log

    def test_short_disconnect_returns_same_snapshot_without_business_replay(self):
        outcome, commands, _, log = self.exercise()
        self.assertEqual(outcome, "hierarchy")
        self.assertEqual(commands.count(["shell", "mkdir", "-p", "/sdcard/PhoneCloud"]), 2)
        self.assertEqual(commands.count(["get-state"]), 3)
        self.assertTrue(all(not e.get("queryReplayed", False) for e in log))

    def test_offline_transport_recovers(self):
        self.assertEqual(self.exercise(failure="error: device offline")[0], "hierarchy")

    def test_healthy_dump_has_no_additional_probes(self):
        outcome, commands, _, _ = self.exercise(failure="")
        self.assertEqual(outcome, "hierarchy")
        self.assertNotIn(["get-state"], commands)

    def test_permanent_absence_has_finite_budget(self):
        outcome, commands, elapsed, _ = self.exercise(states=["offline"] * 100)
        self.assertEqual(outcome, "alipay_ui_transport_unavailable")
        self.assertLessEqual(elapsed, 8.0)
        self.assertEqual(commands.count(["shell", "mkdir", "-p", "/sdcard/PhoneCloud"]), 1)

    def test_probe_timeout_has_finite_budget(self):
        outcome, _, elapsed, _ = self.exercise(timeout_probe=True)
        self.assertEqual(outcome, "alipay_ui_transport_unavailable")
        self.assertLessEqual(elapsed, 8.0)

    def test_other_device_error_is_not_retried(self):
        outcome, commands, _, _ = self.exercise(failure="adb.exe: device 'OTHER' not found")
        self.assertIn("OTHER", outcome)
        self.assertNotIn(["get-state"], commands)

    def test_unrelated_failure_is_not_retried(self):
        outcome, commands, _, _ = self.exercise(failure="permission denied")
        self.assertEqual(outcome, "permission denied")
        self.assertNotIn(["get-state"], commands)

    def test_second_disconnect_is_not_replayed_again(self):
        outcome, commands, _, _ = self.exercise(second_failure=True)
        self.assertIn("not found", outcome)
        self.assertEqual(commands.count(["shell", "mkdir", "-p", "/sdcard/PhoneCloud"]), 2)

    def test_unauthorized_stops_without_retrying_snapshot(self):
        outcome, commands, _, _ = self.exercise(states=["error: device unauthorized"])
        self.assertEqual(outcome, "alipay_ui_transport_unauthorized")
        self.assertEqual(commands.count(["get-state"]), 1)

    def test_probe_permission_failure_stops_immediately(self):
        outcome, commands, elapsed, _ = self.exercise(states=["error: permission denied"])
        self.assertEqual(outcome, "error: permission denied")
        self.assertEqual(commands.count(["get-state"]), 1)
        self.assertEqual(elapsed, 0)

if __name__ == "__main__": unittest.main(verbosity=2)
