import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch

RELEASE = Path(__file__).resolve().parent
ROOT = RELEASE.parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result
sync = load("wake_candidate", (Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
fixtures = load("wake_fixtures", ROOT / "releases/xhs-collector-recovery-20261110-rc.3/test_keyguard_timeout.py")

class StartupWakeTests(unittest.TestCase):
    def run_wake(self, window, slot="app1", guard=None):
        calls = []
        def command(_adb, _serial, *args, **kwargs):
            calls.append(args)
            if args == ("shell", "input", "keyevent", "224"):
                raise subprocess.TimeoutExpired("wake", 7)
            self.assertEqual(args, ("shell", "dumpsys", "window"))
            return window
        events = ["collection_slot_requested:" + slot]
        with patch.object(sync, "adb", side_effect=command):
            sync.wake_for_startup("adb", "fixture", slot, guard or Mock(), events)
        return calls, events

    def test_already_lit_unlocked_owner_is_proven_without_wake_replay(self):
        calls, events = self.run_wake(fixtures.UNLOCKED)
        self.assertEqual(calls, [("shell", "input", "keyevent", "224"), ("shell", "dumpsys", "window")])
        self.assertIn("startup_wake_completed_after_timeout", events)

    def test_ambiguous_display_lock_foreign_and_wrong_user_never_pass(self):
        for before, after in [("showing=false", "showing=true"), ("secure=false", "secure=true"),
                              ("occluded=false", "occluded=true"), ("inputRestricted=false", "inputRestricted=true"),
                              ("mDisplayId=0", "mDisplayId=90000"), ("mScreenOnFully=true", "mScreenOnFully=false"),
                              ("secure=false", "secure=false\n secure=true"),
                              (" u0 ", " u999 "), ("com.xingin.xhs/", "com.other/")]:
            with self.subTest(after=after), self.assertRaises(RuntimeError if before in (" u0 ", "com.xingin.xhs/") else subprocess.TimeoutExpired):
                self.run_wake(fixtures.UNLOCKED.replace(before, after))

    def test_clone_and_lost_occupancy_do_not_read_or_repeat_wake(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_wake(fixtures.UNLOCKED, slot="app2")
        with self.assertRaisesRegex(RuntimeError, "occupied"):
            self.run_wake(fixtures.UNLOCKED, guard=Mock(side_effect=RuntimeError("occupied")))

if __name__ == "__main__":
    unittest.main()
