"""Saved-account picker transition regressions; synthetic accounts, no ADB."""
import unittest
import xml.etree.ElementTree as ET
from unittest import mock
import alipay_name_lookup as lookup


def tree(rows=True, y=300, current="A", action=True):
    root = ET.Element("hierarchy")
    page = ET.SubElement(root, "node", {"bounds": "[0,0][720,1612]"})
    ET.SubElement(page, "node", text="切换账号")
    if rows:
        for i, account in enumerate(["A", "B"]):
            box = ET.SubElement(page, "node", {"bounds": f"[40,{y+i*200}][680,{y+i*200+120}]"})
            ET.SubElement(box, "node", {"resource-id": lookup.ACCOUNT_ID, "text": account,
                "bounds": f"[100,{y+i*200+20}][300,{y+i*200+70}]"})
            if account == current:
                ET.SubElement(box, "node", {"resource-id": lookup.ACCOUNT_CURRENT_ID, "text": "当前"})
    if action:
        box = ET.SubElement(page, "node", {"resource-id": "com.alipay.mobile.securitybiz:id/ll_switch_layout"})
        ET.SubElement(box, "node", {"resource-id": lookup.ACCOUNT_ID, "text": "登录其他账号",
            "clickable": "true", "bounds": "[40,1300][680,1400]"})
    return root


def sheet():
    root = ET.Element("hierarchy")
    for i, text in enumerate(["登录其他账号", "退出登录", "取消"]):
        ET.SubElement(root, "node", {"text": text, "clickable": "true", "bounds": f"[0,{1000+i*100}][720,{1100+i*100}]"})
    return root


class PickerTransitionTests(unittest.TestCase):
    def runner(self, frames):
        r = lookup.Runner({"serial": "SYNTHETIC", "taskId": "picker-transition"})
        index = [0]
        def dump(token, **options):
            frame = frames[min(index[0], len(frames)-1)]
            index[0] += 1
            return frame, {c: p for p in frame.iter() for c in p}
        r.dump = mock.Mock(side_effect=dump)
        r.adb = mock.Mock(return_value="")
        r.emit = mock.Mock()
        return r

    def wait(self, r, **kw):
        with mock.patch.object(lookup.time, "sleep"), mock.patch.object(lookup.time, "monotonic", side_effect=[i*.01 for i in range(10000)]):
            return r.wait_account_picker("test", timeout=2, **kw)

    def test_delayed_sheet_is_tapped_once_then_target_rows_are_read(self):
        r = self.runner([sheet(), sheet(), sheet(), tree(), tree()])
        rows = self.wait(r, allow_intermediate_sheet=True)
        self.assertEqual([x[0] for x in rows], ["A", "B"])
        self.assertEqual(r.adb.call_args_list, [mock.call(["shell", "input", "tap", "360", "1050"], timeout=8)])
        self.assertEqual(r.dump.call_count, 5)

    def test_open_picker_does_not_tap_same_slow_sheet_twice(self):
        import cv2
        import numpy as np
        image = np.full((1612, 720, 3), 230, dtype=np.uint8)
        image[1180:1300, 18:702] = 255
        image[1350:1470, 18:702] = 255
        _, raw = cv2.imencode(".png", image)
        r = self.runner([sheet(), sheet(), sheet(), tree(), tree()])
        r.adb.side_effect = lambda args, **kw: raw.tobytes() if args == ["exec-out", "screencap", "-p"] else ""
        r.enter_my_settings = mock.Mock()
        with mock.patch.object(lookup.time, "sleep"):
            r.open_account_picker("slow")
        entry_taps = [c for c in r.adb.call_args_list if c.args[0] == ["shell", "input", "tap", "360", "1050"]]
        self.assertEqual(len(entry_taps), 1)

    def test_unstable_picker_reuse_never_reopens_navigation(self):
        r = self.runner([tree(rows=False)])
        r.resume_alipay_home = mock.Mock(side_effect=AssertionError("navigation replay"))
        r.open_account_picker = mock.Mock(side_effect=AssertionError("entry replay"))
        with mock.patch.object(lookup.time, "sleep"), mock.patch.object(lookup.time, "monotonic", side_effect=[i*.01 for i in range(10000)]):
            with self.assertRaisesRegex(RuntimeError, "alipay_account_picker_not_stable"):
                r.switch_account(target_account="B", reuse_open_picker=True)
        r.adb.assert_not_called()
        r.resume_alipay_home.assert_not_called()
        r.open_account_picker.assert_not_called()

    def test_title_without_rows_waits_without_clicking_underlying_entry(self):
        partial = tree(rows=False)
        for text in ["退出登录", "取消"]: ET.SubElement(partial, "node", text=text)
        r = self.runner([partial, partial, tree(), tree()])
        self.assertEqual(len(self.wait(r, allow_intermediate_sheet=True)), 2)
        r.adb.assert_not_called()
        self.assertEqual(r.dump.call_count, 4)

    def test_moving_rows_require_two_consecutive_equal_positions(self):
        r = self.runner([tree(y=600), tree(y=500), tree(y=300), tree(y=300)])
        rows = self.wait(r)
        self.assertEqual(rows[1][2].get("bounds"), "[100,520][300,570]")
        self.assertEqual(r.dump.call_count, 4)
        r.adb.assert_not_called()

    def test_partial_frame_resets_previous_stability(self):
        r = self.runner([tree(), tree(rows=False), tree(), tree()])
        self.wait(r)
        self.assertEqual(r.dump.call_count, 4)

    def test_each_dump_uses_a_different_path_token(self):
        r = self.runner([tree(), tree()]); self.wait(r); self.wait(r)
        tokens = [c.args[0] for c in r.dump.call_args_list]
        self.assertEqual(len(set(tokens)), len(tokens))

    def test_failed_transition_never_replays_entry(self):
        r = self.runner([sheet()])
        with self.assertRaisesRegex(RuntimeError, "alipay_account_picker_not_stable"):
            self.wait(r, allow_intermediate_sheet=True)
        self.assertEqual(r.adb.call_count, 1)

    def test_reuse_is_read_only_even_on_intermediate_sheet(self):
        r = self.runner([sheet()])
        with self.assertRaisesRegex(RuntimeError, "alipay_account_picker_not_stable"):
            self.wait(r)
        r.adb.assert_not_called()

    def test_invalid_or_covered_saved_rows_never_become_a_target(self):
        for kind in ["zero", "outside", "disabled", "hidden", "duplicate", "no_current", "two_current", "avatar_sheet"]:
            frame = tree()
            nodes = [n for n in frame.iter("node") if n.get("resource-id") == lookup.ACCOUNT_ID and n.get("text") == "B"]
            node = nodes[0]
            if kind == "zero": node.set("bounds", "[0,0][0,0]")
            if kind == "outside": node.set("bounds", "[100,1600][300,1700]")
            if kind == "disabled": node.set("enabled", "false")
            if kind == "hidden": node.set("visible-to-user", "false")
            if kind == "duplicate": node.set("text", "A")
            if kind == "no_current":
                for x in frame.iter("node"):
                    if x.get("resource-id") == lookup.ACCOUNT_CURRENT_ID: x.set("text", "")
            if kind == "two_current":
                parent = next(p for p in frame.iter() if node in p)
                ET.SubElement(parent, "node", {"resource-id": lookup.ACCOUNT_CURRENT_ID, "text": "当前"})
            if kind == "avatar_sheet":
                ET.SubElement(frame, "node", text="轻触头像以切换账号")
                ET.SubElement(frame, "node", text="添加其他账号")
            r = self.runner([frame])
            with self.subTest(kind=kind), self.assertRaisesRegex(RuntimeError, "alipay_account_picker_not_stable"):
                self.wait(r, allow_intermediate_sheet=True)
            r.adb.assert_not_called()

    def test_normal_picker_hint_is_not_mistaken_for_login_avatar_sheet(self):
        frame = tree()
        ET.SubElement(frame, "node", text="轻触头像以切换账号")
        r = self.runner([frame])
        self.assertEqual(len(self.wait(r)), 2)

    def test_current_identity_change_restarts_stability(self):
        r = self.runner([tree(current="A"), tree(current="B"), tree(current="B")])
        rows = self.wait(r)
        self.assertEqual(next(x[0] for x in rows if x[1]), "B")
        self.assertEqual(r.dump.call_count, 3)

    def test_switch_uses_stable_target_once_and_never_entry(self):
        r = self.runner([tree(y=600), tree(), tree()])
        r.wait_unique = mock.Mock()
        with mock.patch.object(lookup.time, "sleep"), mock.patch.object(lookup.time, "monotonic", side_effect=[i*.01 for i in range(10000)]):
            result = r.switch_account(target_account="B", reuse_open_picker=True, verify_current_marker=False)
        self.assertEqual(result, "B")
        self.assertEqual(r.adb.call_args_list, [mock.call(["shell", "input", "tap", "200", "545"], timeout=8)])
        self.assertEqual(len(r.account_switch_history), 1)

if __name__ == "__main__": unittest.main()
