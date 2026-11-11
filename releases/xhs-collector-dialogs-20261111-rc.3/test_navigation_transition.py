import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

RELEASE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("navigation_candidate", (Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
INDEX = "mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}"
CENTER = "mCurrentFocus=Window{y u0 com.xingin.xhs/com.xingin.reactnative.ui.XhsReactActivity}"
ERROR = "native elements foreground changed before staging"


class NavigationTransitionTests(unittest.TestCase):
    def events(self):
        return ["native_window_elements_enabled", "collection_slot_requested:app1"]

    def test_transition_waits_without_replaying_input_then_reads_new_tree(self):
        root = ET.Element("hierarchy")
        events = self.events()
        with patch.object(sync, "focus", side_effect=[INDEX, "", CENTER]), \
             patch.object(sync, "native_window_capture", side_effect=[RuntimeError(ERROR), root]) as reader, \
             patch.object(sync, "adb") as adb, patch.object(sync.time, "sleep"):
            self.assertIs(sync.navigation_capture("adb", "fixture", Mock(), events), root)
        self.assertEqual(reader.call_args_list[-1].args[2], CENTER)
        self.assertEqual(events.count("navigation_native_transition_read_retry"), 1)
        adb.assert_not_called()

    def test_wrong_slot_and_foreign_app_during_transition_stop(self):
        for current in [CENTER.replace("u0", "u999"), CENTER.replace("com.xingin.xhs/", "com.other/")]:
            with patch.object(sync, "focus", side_effect=[INDEX, current]), \
                 patch.object(sync, "native_window_capture", side_effect=RuntimeError(ERROR)) as reader, \
                 patch.object(sync.time, "sleep"):
                with self.assertRaises(RuntimeError):
                    sync.navigation_capture("adb", "fixture", Mock(), self.events())
                self.assertEqual(reader.call_count, 1)

    def test_scanning_and_other_errors_never_use_transition_retry(self):
        for error, events in [
            (ERROR, self.events() + ["collection_scan_as_of:2026-11-11"]),
            ("native elements command failed: native_disconnect_failed", self.events()),
            ("native elements complete hierarchy is unproven", self.events()),
        ]:
            with patch.object(sync, "focus", return_value=INDEX), \
                 patch.object(sync, "native_window_capture", side_effect=RuntimeError(error)) as reader:
                with self.assertRaisesRegex(RuntimeError, error):
                    sync.navigation_capture("adb", "fixture", Mock(), events)
                self.assertEqual(reader.call_count, 1)

    def test_focus_still_missing_fails_after_bounded_readback(self):
        with patch.object(sync, "focus", side_effect=[INDEX] + [""] * 6) as focus, \
             patch.object(sync, "native_window_capture", side_effect=RuntimeError(ERROR)), patch.object(sync.time, "sleep"):
            with self.assertRaisesRegex(sync.ElementListReadError, "did not settle"):
                sync.navigation_capture("adb", "fixture", Mock(), self.events())
        self.assertEqual(focus.call_count, 7)

    def test_repeated_transition_has_three_read_attempts_total(self):
        with patch.object(sync, "focus", return_value=INDEX), \
             patch.object(sync, "native_window_capture", side_effect=RuntimeError(ERROR)) as reader, \
             patch.object(sync.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, ERROR):
                sync.navigation_capture("adb", "fixture", Mock(), self.events())
        self.assertEqual(reader.call_count, 3)


if __name__ == "__main__":
    unittest.main()
