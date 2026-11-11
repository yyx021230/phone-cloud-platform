import importlib.util
from pathlib import Path
import subprocess
import time
import unittest
from unittest.mock import Mock, patch

RELEASE = Path(__file__).resolve().parent
ROOT = RELEASE.parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result
sync = load("reset_candidate", (Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
fixtures = load("reset_fixtures", ROOT / "releases/xhs-collector-recovery-20261110-rc.2/test_works_tab_timeout.py")

class ResetTimeoutTests(unittest.TestCase):
    def events(self):
        return ["collection_slot_requested:app1", "data_center_works_tab_tap_timeout",
                "data_center_works_tab_ready_after_timeout", "creator_overview_reopened"]

    def open(self, events):
        return sync.open_works_tab("adb", "fixture", fixtures.overview(), Mock(), events,
                                   expected_foreground=fixtures.FOCUS, deadline=time.monotonic() + 45)

    def test_distinct_reset_tap_can_be_proven_complete_without_another_tap(self):
        events = self.events()
        with patch.object(sync, "focus", return_value=fixtures.FOCUS), \
             patch.object(sync, "adb", side_effect=fixtures.timed_out()) as adb, \
             patch.object(sync, "native_window_capture", return_value=fixtures.works_list()) as reads:
            self.assertTrue(self.open(events))
        self.assertEqual(adb.call_count, 1)
        self.assertEqual(reads.call_count, 1)
        self.assertIn("data_center_works_tab_post_reset_timeout_readback", events)

    def test_uncompleted_reset_never_retries_tap(self):
        events = self.events()
        with patch.object(sync, "focus", return_value=fixtures.FOCUS), \
             patch.object(sync, "adb", side_effect=fixtures.timed_out()) as adb, \
             patch.object(sync, "native_window_capture", return_value=fixtures.overview()) as reads:
            with self.assertRaises(subprocess.TimeoutExpired):
                self.open(events)
        self.assertEqual(adb.call_count, 1)
        self.assertEqual(reads.call_count, 2)

    def test_missing_success_or_reset_and_repeated_readback_never_enter_recovery(self):
        for marker in ("data_center_works_tab_ready_after_timeout", "creator_overview_reopened", None):
            events = self.events()
            if marker:
                events.remove(marker)
            else:
                events.append("data_center_works_tab_post_reset_timeout_readback")
            with patch.object(sync, "focus", return_value=fixtures.FOCUS), \
                 patch.object(sync, "adb", side_effect=fixtures.timed_out()) as adb, \
                 patch.object(sync, "native_window_capture") as reads:
                with self.assertRaises(subprocess.TimeoutExpired):
                    self.open(events)
            self.assertEqual(adb.call_count, 1)
            reads.assert_not_called()

if __name__ == "__main__":
    unittest.main()
