import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("dialog_candidate", (Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
INDEX = "mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}"


def dialog(package):
    # Roles transcribed from the failed tasks' saved native element exports.
    observed = {
        "com.android.systemui": [
            ("com.android.systemui:id/usb_select_title_tv", "USB 用于", "TextView"),
            ("com.android.systemui:id/usb_select_list_view", "", "ListView"),
            ("com.android.systemui:id/title", "仅充电", "TextView"),
            ("com.android.systemui:id/title", "传输文件\u00a0/ Android Auto", "TextView"),
            ("com.android.systemui:id/title", "传输照片", "TextView")],
        "com.android.settings": [
            ("android:id/alertTitle", "USB 连接方式", "TextView"),
            ("android:id/select_dialog_listview", "", "ListView"),
            ("com.android.settings:id/text1", "传输照片", "CheckedTextView"),
            ("com.android.settings:id/text1", "传输文件", "CheckedTextView"),
            ("com.android.settings:id/text1", "仅充电", "CheckedTextView"),
            ("android:id/button2", "取消", "Button")],
        "com.vivo.pushservice": [
            ("com.vivo.pushservice:id/alertTitle", "确定允许“小红书”发送通知吗？", "TextView"),
            ("com.vivo.pushservice:id/description_title", "通知可能包括：桌面角标、悬浮通知、锁屏通知等，可前往“设置”中进行更改。", "TextView"),
            ("android:id/button1", "", "Button"), ("android:id/button2", "", "Button"),
            ("com.vivo.pushservice:id/vbutton_title", "允许", "TextView"),
            ("com.vivo.pushservice:id/vbutton_title", "取消", "TextView")],
    }
    root = ET.Element("hierarchy")
    for rid, text, kind in observed[package]:
        ET.SubElement(root, "node", {"package": package, "resource-id": rid, "text": text,
            "class": "android.widget." + kind, "enabled": "true", "bounds": "[1,1][2,2]"})
    return root


class DialogTests(unittest.TestCase):
    packages = ("com.android.systemui", "com.android.settings", "com.vivo.pushservice")

    def args(self, slot="app1"):
        return SimpleNamespace(adb="adb", serial="test", app_slot=slot)

    def window(self, package):
        return "mCurrentFocus=Window{x u0 " + package + "}"

    def dump(self, package):
        owner = ("mFocusedApp=AppWindowToken{x token=Token{y ActivityRecord{z u0 "
                 "com.xingin.xhs/.index.v2.IndexActivityV2 t1}}}" if package == "com.android.settings"
                 else "mFocusedApp=ActivityRecord{x u0 com.xingin.xhs/.index.v2.IndexActivityV2 t1}")
        return self.window(package) + "\n" + owner

    def test_each_observed_dialog_uses_one_back(self):
        for package in self.packages:
            with self.subTest(package=package):
                ev = ["collection_slot_requested:app1"]
                root = ET.Element("hierarchy")
                with patch.object(sync, "capture", return_value=dialog(package)), \
                     patch.object(sync, "adb", side_effect=[self.dump(package), self.dump(package), ""]) as adb, \
                     patch.object(sync, "focus", side_effect=["", INDEX]), \
                     patch.object(sync, "navigation_capture", return_value=root), patch.object(sync.time, "sleep"):
                    self.assertIs(sync.recover_profile_system_dialog(self.args(), self.window(package), Mock(), ev), root)
                self.assertEqual(adb.call_args_list[-1], call("adb", "test", "shell", "input", "keyevent", "4", timeout=7))
                self.assertEqual(len(adb.call_args_list), 3)

    def test_wrong_slot_missing_request_and_unknown_package_do_nothing(self):
        for args, events, current in [
            (self.args("app2"), ["collection_slot_requested:app2"], self.window(self.packages[0])),
            (self.args(), [], self.window(self.packages[0])),
            (self.args(), ["collection_slot_requested:app1"], self.window("com.other"))]:
            with patch.object(sync, "adb") as adb:
                self.assertIsNone(sync.recover_profile_system_dialog(args, current, Mock(), events))
                adb.assert_not_called()

    def test_wrong_background_owner_stops_before_reading_or_input(self):
        for replacement in ["com.other/.IndexActivityV2", "com.xingin.xhs/.OtherActivity"]:
            dump = self.dump(self.packages[0]).replace("com.xingin.xhs/.index.v2.IndexActivityV2", replacement)
            with patch.object(sync, "adb", return_value=dump) as adb, patch.object(sync, "capture") as capture:
                self.assertIsNone(sync.recover_profile_system_dialog(self.args(), self.window(self.packages[0]), Mock(), ["collection_slot_requested:app1"]))
                capture.assert_not_called()
                self.assertEqual(adb.call_count, 1)

    def test_unrelated_title_missing_role_and_mixed_packages_never_send_back(self):
        package = self.packages[2]
        for change in ("other_app", "missing", "mixed"):
            root = dialog(package)
            if change == "other_app":
                root[0].set("text", "确定允许“其他应用”发送通知吗？")
            elif change == "missing":
                root.remove(root[-1])
            else:
                root[0].set("package", "com.other")
            with patch.object(sync, "capture", return_value=root), patch.object(sync, "adb", return_value=self.dump(package)) as adb:
                self.assertIsNone(sync.recover_profile_system_dialog(self.args(), self.window(package), Mock(), ["collection_slot_requested:app1"]))
                self.assertEqual(adb.call_count, 1)

    def test_foreground_change_before_back_stops(self):
        package = self.packages[0]
        with patch.object(sync, "capture", return_value=dialog(package)), \
             patch.object(sync, "adb", side_effect=[self.dump(package), INDEX]) as adb:
            with self.assertRaisesRegex(sync.ElementListReadError, "changed before Back"):
                sync.recover_profile_system_dialog(self.args(), self.window(package), Mock(), ["collection_slot_requested:app1"])
            self.assertEqual(adb.call_count, 2)

    def test_reappearing_dialog_does_not_repeat_back(self):
        package = self.packages[0]
        with patch.object(sync, "adb", return_value=self.dump(package)) as adb:
            with self.assertRaisesRegex(sync.ElementListReadError, "recurred"):
                sync.recover_profile_system_dialog(self.args(), self.window(package), Mock(),
                    ["collection_slot_requested:app1", "profile_usb_systemui_back"])
            self.assertEqual(adb.call_count, 1)

    def test_still_open_or_wrong_slot_after_back_fails(self):
        package = self.packages[0]
        for readings in [[self.window(package)] * 4, [INDEX.replace("u0", "u999")]]:
            with patch.object(sync, "capture", return_value=dialog(package)), \
                 patch.object(sync, "adb", side_effect=[self.dump(package), self.dump(package), ""]) as adb, \
                 patch.object(sync, "focus", side_effect=readings), patch.object(sync.time, "sleep"):
                with self.assertRaises(sync.ElementListReadError):
                    sync.recover_profile_system_dialog(self.args(), self.window(package), Mock(), ["collection_slot_requested:app1"])
                self.assertEqual(adb.call_count, 3)

    def test_profile_gate_restarts_and_requires_two_fresh_reads_after_back(self):
        package = self.packages[2]
        profile = ET.parse(ROOT.parents[1] / "windows-agent/scripts/fixtures/xhs-profile-header-three-tabs.xml").getroot()
        args = self.args()
        ev = ["collection_slot_requested:app1"]
        with patch.object(sync, "focus", side_effect=[self.window(package), INDEX, INDEX, INDEX, INDEX, INDEX]), \
             patch.object(sync, "resume_vivo_update_entry", return_value=None), \
             patch.object(sync, "capture", return_value=dialog(package)), \
             patch.object(sync, "adb", side_effect=[self.dump(package), self.dump(package), ""]), \
             patch.object(sync, "navigation_capture", return_value=profile), \
             patch.object(sync, "native_window_capture", return_value=profile) as native, patch.object(sync.time, "sleep"):
            sync.prove_profile_identity(args, profile, Mock(), ev, "SYNTH_123")
        self.assertEqual(args.verified_account_identity["sample_count"], 2)
        self.assertEqual(native.call_count, 2)

    def test_settings_dialog_uses_proven_cancel_if_back_does_not_close_it(self):
        package = "com.android.settings"
        root = dialog(package)
        root[-1].set("clickable", "true")
        with patch.object(sync, "capture", return_value=root), \
             patch.object(sync, "adb", side_effect=[self.dump(package), self.dump(package), "",
                                                  self.dump(package), self.dump(package), ""]) as adb, \
             patch.object(sync, "focus", side_effect=[self.window(package)] * 4 + [INDEX]), \
             patch.object(sync, "navigation_capture", return_value=ET.Element("hierarchy")), patch.object(sync.time, "sleep"):
            sync.recover_profile_system_dialog(self.args(), self.window(package), Mock(), ["collection_slot_requested:app1"])
        self.assertEqual(adb.call_args_list[2], call("adb", "test", "shell", "input", "keyevent", "4", timeout=7))
        self.assertEqual(adb.call_args_list[-1], call("adb", "test", "shell", "input", "tap", "1", "1", timeout=7))

    def test_settings_cancel_does_not_run_if_dialog_changes_after_back(self):
        package = "com.android.settings"
        with patch.object(sync, "capture", return_value=dialog(package)), \
             patch.object(sync, "adb", side_effect=[self.dump(package), self.dump(package), "", INDEX]) as adb, \
             patch.object(sync, "focus", side_effect=[self.window(package)] * 4), patch.object(sync.time, "sleep"):
            with self.assertRaises(sync.ElementListReadError):
                sync.recover_profile_system_dialog(self.args(), self.window(package), Mock(), ["collection_slot_requested:app1"])
        self.assertEqual(adb.call_count, 4)


if __name__ == "__main__":
    unittest.main()
