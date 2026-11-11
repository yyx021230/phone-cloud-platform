import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, call, patch
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("control_candidate", (Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
SHADE = "mCurrentFocus=Window{x u0 NotificationShade type=2040}"
PICKER = "mCurrentFocus=Window{y u0 com.android.intentresolver/.DoubleAppResolverActivity}"
DUMP = SHADE + "\nmFocusedApp=ActivityRecord{z u0 com.android.intentresolver/.DoubleAppResolverActivity t1}"


def tree():
    root = ET.Element("hierarchy")
    for rid in ("qs_focus_content_container", "vivo_volume_tile_slider", "vivo_brightness_slider_summary"):
        ET.SubElement(root, "node", {"package": "com.vivo.systemuiplugin",
            "resource-id": "com.vivo.systemuiplugin:id/" + rid, "enabled": "true",
            "class": "android.view.View", "bounds": "[0,0][1,1]"})
    return root


class ControlCenterTests(unittest.TestCase):
    def run_close(self, slot="app1", nodes=None, dumps=None, readings=None, events=None):
        events = events if events is not None else ["collection_slot_requested:" + slot, "xhs_cold_started"]
        if slot == "app2" and "clone_user_requested:999" not in events:
            events.append("clone_user_requested:999")
        with patch.object(sync, "capture", return_value=nodes if nodes is not None else tree()), \
             patch.object(sync, "adb", side_effect=dumps or [DUMP, DUMP, ""]) as adb, \
             patch.object(sync, "focus", side_effect=readings or [PICKER]), patch.object(sync.time, "sleep"):
            answer = sync.close_startup_control_center("adb", "fixture", tree(), SHADE, slot, Mock(), events)
        return answer, adb.call_args_list

    def test_owner_and_clone_only_send_one_back(self):
        for slot in ("app1", "app2"):
            answer, calls = self.run_close(slot)
            self.assertTrue(answer)
            self.assertEqual(calls, [call("adb", "fixture", "shell", "dumpsys", "window", timeout=8)] * 2
                             + [call("adb", "fixture", "shell", "input", "keyevent", "4", timeout=7)])

    def test_wrong_background_owner_is_not_dismissed(self):
        answer, calls = self.run_close(dumps=[DUMP.replace("com.android.intentresolver", "com.other")])
        self.assertFalse(answer)
        self.assertEqual(len(calls), 1)

    def test_incomplete_or_unrelated_controls_are_not_dismissed(self):
        for changed in ("missing", "foreign"):
            root = tree()
            if changed == "missing":
                root.remove(root[0])
            else:
                root[0].set("package", "com.other")
            answer, calls = self.run_close(nodes=root, dumps=[DUMP])
            self.assertFalse(answer)
            self.assertEqual(len(calls), 1)

    def test_foreground_change_before_back_stops(self):
        with self.assertRaisesRegex(sync.ElementListReadError, "changed before Back"):
            self.run_close(dumps=[DUMP, PICKER])

    def test_wrong_slot_after_back_stops(self):
        wrong = "mCurrentFocus=Window{x u999 com.xingin.xhs/.index.v2.IndexActivityV2}"
        with self.assertRaisesRegex(sync.ElementListReadError, "unexpected foreground"):
            self.run_close(readings=[wrong])

    def test_persistent_shade_and_repeated_shade_fail_without_repeated_back(self):
        with self.assertRaisesRegex(sync.ElementListReadError, "stayed open"):
            self.run_close(readings=[SHADE] * 6)
        with self.assertRaisesRegex(sync.ElementListReadError, "recurred"):
            self.run_close(events=["collection_slot_requested:app1", "xhs_cold_started", "startup_control_center_back"])

    def test_missing_clone_user_does_not_issue_commands(self):
        with patch.object(sync, "adb") as adb:
            self.assertFalse(sync.close_startup_control_center("adb", "fixture", tree(), SHADE, "app2", Mock(),
                ["collection_slot_requested:app2", "xhs_cold_started"]))
            adb.assert_not_called()


if __name__ == "__main__":
    unittest.main()
