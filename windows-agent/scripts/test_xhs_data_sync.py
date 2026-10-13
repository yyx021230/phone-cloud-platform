"""Focused safety checks for the standalone Creator Center list collector."""

import importlib.util
import datetime as dt
import unittest
import tempfile
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("小红书数据同步.py")
SPEC = importlib.util.spec_from_file_location("xhs_data_sync", SCRIPT)
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


def xml(*children):
    return ET.fromstring("<hierarchy>" + "".join(children) + "</hierarchy>")


class MiuiCloneTests(unittest.TestCase):
    def chooser(self):
        return xml('<node package="android" resource-id="miui:id/alertTitle" text="请选择要使用的应用" bounds="[315,1605][765,1673]"/>',
                   '<node package="android" class="android.widget.LinearLayout" resource-id="android.miui:id/app1" clickable="true" enabled="true" bounds="[51,1723][540,1938]">'
                   '<node package="android" class="android.widget.ImageView" content-desc="小红书" bounds="[229,1723][361,1855]"/>'
                   '<node package="android" text="小红书" bounds="[241,1855][349,1938]"/></node>',
                   '<node package="android" class="android.widget.LinearLayout" resource-id="android.miui:id/app2" clickable="true" enabled="true" bounds="[540,1723][1029,1938]">'
                   '<node package="android" class="android.widget.ImageView" content-desc="双开小红书" bounds="[718,1723][850,1855]"/>'
                   '<node package="android" text="小红书" bounds="[730,1855][838,1938]"/></node>')

    def test_identical_app_labels_select_the_requested_container_and_expected_user(self):
        for slot, x, user in (("app1", "295", "0"), ("app2", "784", "999")):
            events = []
            with self.subTest(slot=slot), patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
                self.assertTrue(sync.select_miui_clone("adb", "serial", self.chooser(), "mCurrentFocus=Window{x u999 android/com.android.internal.app.ResolverActivity}", slot, lambda: None, events))
            adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", x, "1830", timeout=7)
            self.assertIn("clone_user_requested:" + user, events)

    def test_duplicate_container_or_wrong_clone_icon_cannot_tap_the_first_main_label(self):
        roots = [self.chooser(), self.chooser()]
        roots[0].append(ET.fromstring(ET.tostring(roots[0][2], encoding="unicode")))
        roots[1][2][0].set("content-desc", "小红书")
        for root in roots:
            with self.subTest(root=root), patch.object(sync, "adb") as adb:
                with self.assertRaises(RuntimeError):
                    sync.select_miui_clone("adb", "serial", root, "android/com.android.internal.app.ResolverActivity}", "app2", lambda: None, [])
            adb.assert_not_called()

    def test_miui_choice_respects_occupancy_and_exact_system_activity(self):
        with patch.object(sync, "adb") as adb:
            self.assertFalse(sync.select_miui_clone("adb", "serial", self.chooser(), "com.other/com.android.internal.app.ResolverActivity}", "app2", lambda: None, []))
            with self.assertRaisesRegex(RuntimeError, "occupied"):
                sync.select_miui_clone("adb", "serial", self.chooser(), "android/com.android.internal.app.ResolverActivity}", "app2", unittest.mock.Mock(side_effect=RuntimeError("occupied")), [])
        adb.assert_not_called()

    def test_wrong_foreground_user_stops_before_creator_or_draft_navigation(self):
        root = xml('<node text="数据中心" bounds="[1,1][90,40]"/>', '<node text="作品分析" bounds="[1,45][90,80]"/>',
                   '<node text="全部笔记" bounds="[1,85][90,120]"/>')
        with patch.object(sync, "wake_if_asleep", return_value=False), patch.object(sync, "focus", return_value="mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}"), patch.object(sync, "adb") as adb:
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                sync.ensure_creator_list("adb", "serial", root, "app2", lambda: None, ["clone_user_requested:999"])
        adb.assert_not_called()


class FleetReadingTests(unittest.TestCase):
    def flat_list(self):
        return xml('<node text="作品分析" bounds="[324,291][486,342]"/>',
                   '<node text="全部笔记" bounds="[45,417][210,468]"/>',
                   '<node package="com.xingin.xhs" class="android.webkit.WebView" text="数据中心" bounds="[0,0][1080,2266]">'
                   '<node package="com.xingin.xhs" class="android.widget.TextView" text="09-17" bounds="[108,735][192,774]"/>'
                   '<node package="com.xingin.xhs" class="android.widget.TextView" text="测试作品" bounds="[285,537][1017,585]"/>'
                   '<node package="com.xingin.xhs" class="android.widget.TextView" text="笔记状态正常" bounds="[339,627][549,672]"/>'
                   '<node package="com.xingin.xhs" class="android.widget.TextView" text="133" bounds="[342,711][402,756]"/>'
                   '<node package="com.xingin.xhs" class="android.widget.TextView" text="0" bounds="[498,711][522,756]"/>'
                   '<node package="com.xingin.xhs" class="android.widget.TextView" text="1" bounds="[615,711][639,756]"/>'
                   '</node>')

    def test_flat_card_retains_title_date_status_and_metric_column_order(self):
        cards = sync.note_cards(self.flat_list())
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0][1], {"title": "测试作品", "published_at_raw": "09-17", "status_raw": "笔记状态正常",
                                      "list_view_count": 133, "list_like_count": 0, "list_comment_count": 1})

    def test_flat_card_requires_one_complete_visible_row_and_the_target_webview(self):
        roots = [self.flat_list() for _ in range(6)]
        roots[0][2].remove(roots[0][2][-1])
        roots[1][2][-1].set("bounds", "[0,0][0,0]")
        roots[2][2][-1].set("bounds", "[615,800][639,845]")
        roots[3][2].set("package", "com.other")
        roots[4][1].set("text", "another page")
        roots[5][2].append(ET.fromstring(ET.tostring(roots[5][2][-1], encoding="unicode")))
        for root in roots:
            with self.subTest(root=root):
                self.assertEqual(sync.note_cards(root), [])

    def test_flat_card_keeps_the_observed_hidden_note_status(self):
        root = self.flat_list()
        root[2][2].set("text", "该篇笔记已不可被他人查看")
        self.assertEqual(sync.note_cards(root)[0][1]["status_raw"], "该篇笔记已不可被他人查看")

    def scrolled_flat_list(self):
        root = self.flat_list()
        view = root[2]
        for node in list(root)[:2]:
            node.set("package", "com.xingin.xhs")
            node.set("class", "android.widget.TextView")
            node.set("bounds", "[0,0][0,0]")
            root.remove(node)
            view.insert(0, node)
        return root

    def test_scrolled_flat_page_retains_proven_list_identity_without_tapping_invisible_header(self):
        root = self.scrolled_flat_list()
        self.assertTrue(sync.creator_list(root))
        with patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}"), patch.object(sync, "adb") as adb:
            events = []
            self.assertIs(sync.refresh_scrolled_webview("adb", "serial", root, lambda: None, events), root)
            self.assertEqual(events, ["works_list_offscreen_header_verified"])
            adb.assert_not_called()

    def test_offscreen_labels_require_the_exact_webview_and_do_not_grant_another_page_list_identity(self):
        for field, value in (("package", "com.other"), ("text", "账号概览")):
            root = self.scrolled_flat_list()
            root[0].set(field, value)
            self.assertFalse(sync.creator_list(root))
        root = self.scrolled_flat_list()
        root[0].remove(root[0][0])
        self.assertFalse(sync.creator_list(root))

    def test_scrolled_flat_page_still_respects_occupancy_before_accepting_data(self):
        with patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}"), patch.object(sync, "adb") as adb:
            with self.assertRaisesRegex(RuntimeError, "occupied"):
                sync.refresh_scrolled_webview("adb", "serial", self.scrolled_flat_list(), unittest.mock.Mock(side_effect=RuntimeError("occupied")), [])
            adb.assert_not_called()

    def test_nested_offscreen_view_labels_keep_the_same_proven_works_page(self):
        root = self.scrolled_flat_list()
        view = root[0]
        wrapper = ET.Element("node", {"package": "com.xingin.xhs", "class": "android.view.View", "bounds": "[0,0][0,0]"})
        for node in list(view)[:2]:
            view.remove(node)
            node.set("class", "android.view.View")
            wrapper.append(node)
        view.insert(0, wrapper)
        self.assertTrue(sync.creator_list(root))
        with patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}"), patch.object(sync, "adb") as adb:
            self.assertIs(sync.refresh_scrolled_webview("adb", "serial", root, lambda: None, []), root)
            adb.assert_not_called()

    def test_empty_tty_capture_uses_a_fresh_file_and_deletes_only_that_file(self):
        def response(_adb, _serial, *args, **kwargs):
            return '<hierarchy><node text="fresh"/></hierarchy>' if args[:2] == ("exec-out", "cat") else ""
        with patch.object(sync, "adb", side_effect=response) as adb, patch.object(sync, "focus", return_value="com.xingin.xhs"), patch.object(sync.time, "sleep"):
            root = sync.capture("adb", "serial")
        self.assertEqual(root[0].get("text"), "fresh")
        calls = [c.args[2:] for c in adb.call_args_list]
        path = calls[2][-1]
        self.assertTrue(path.startswith("/sdcard/phonecloud-xhs-capture-"))
        self.assertEqual(calls[3], ("exec-out", "cat", path))
        self.assertEqual(calls[4], ("shell", "rm", "-f", path))

    def test_ai_chat_recovery_preserves_real_input_and_obeys_the_live_guard(self):
        current = "com.xingin.xhs/com.xingin.dot_agent_page.DotsAgentPageActivity}"
        for text, busy in (("用户未发送的内容", False), ("发消息或按住说话...", True)):
            root = xml(f'<node package="com.xingin.xhs" class="android.widget.EditText" text="{text}" focused="false" bounds="[0,0][200,60]"/>')
            with self.subTest(text=text), patch.object(sync, "wake_if_asleep", return_value=False), patch.object(sync, "focus", return_value=current), \
                    patch.object(sync, "recover_known_overlay", return_value=False), patch.object(sync, "adb") as adb:
                guard = unittest.mock.Mock(side_effect=RuntimeError("occupied") if busy else None)
                with self.assertRaisesRegex(RuntimeError, "occupied" if busy else "unsent text"):
                    sync.ensure_creator_list("adb", "serial", root, "app1", guard, [])
                adb.assert_not_called()

    def test_exact_ai_chat_hint_returns_without_sending_a_message(self):
        root = xml('<node package="com.xingin.xhs" class="android.widget.EditText" text="发消息或按住说话..." focused="false" bounds="[0,0][200,60]"/>')
        listing = xml('<node text="数据中心" bounds="[1,1][90,40]"/>', '<node text="作品分析" bounds="[1,45][90,80]"/>', '<node text="全部笔记" bounds="[1,85][90,120]"/>')
        with patch.object(sync, "wake_if_asleep", return_value=False), patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.dot_agent_page.DotsAgentPageActivity}"), \
                patch.object(sync, "recover_known_overlay", return_value=False), patch.object(sync, "capture", return_value=listing), patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            self.assertIs(sync.ensure_creator_list("adb", "serial", root, "app1", lambda: None, []), listing)
        adb.assert_called_once_with("adb", "serial", "shell", "input", "keyevent", "4", timeout=7)

    def notification_prompt(self, title="“Ⅱ·小红书”请求向您发送通知"):
        return xml(f'<node package="com.android.permissioncontroller" resource-id="com.android.permissioncontroller:id/permission_message" text="{title}" bounds="[104,1032][616,1075]"/>',
                   '<node package="com.android.permissioncontroller" resource-id="com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button" '
                   'class="android.widget.Button" text="禁止且不再询问" clickable="true" enabled="true" bounds="[104,1348][616,1440]"/>')

    def test_clone_notification_can_decline_only_the_observed_exact_request(self):
        root = self.notification_prompt()
        current = "mCurrentFocus=Window{x u999 com.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity}"
        with patch.object(sync, "focus", return_value=current), patch.object(sync, "capture", side_effect=[root, xml()]), patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            events = []
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, events))
        self.assertEqual([c.args[2:] for c in adb.call_args_list], [("shell", "input", "keyevent", "4"), ("shell", "input", "tap", "360", "1394")])
        self.assertEqual(events, ["vivo_clone_notification_denied"])

    def test_browser_location_and_another_user_permission_are_untouched(self):
        for title, user in (("“浏览器”请求访问您的位置信息", "999"), ("“Ⅱ·小红书”请求向您发送通知", "0")):
            with self.subTest(title=title), patch.object(sync, "focus", return_value=f"u{user} com.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity}}"), patch.object(sync, "adb") as adb:
                self.assertFalse(sync.recover_known_overlay("adb", "serial", self.notification_prompt(title), lambda: None, []))
                adb.assert_not_called()

    def test_more_notes_alias_opens_the_analysis_list_without_tapping_a_note(self):
        root = xml('<node text="创作中心" bounds="[1,1][90,40]"/>', '<node text="最新笔记" bounds="[1,45][90,80]"/>', '<node text="更多笔记" bounds="[1,85][90,120]"/>')
        listing = xml('<node text="数据中心" bounds="[1,1][90,40]"/>', '<node text="作品分析" bounds="[1,45][90,80]"/>', '<node text="全部笔记" bounds="[1,85][90,120]"/>')
        with patch.object(sync, "wake_if_asleep", return_value=False), patch.object(sync, "focus", return_value="com.xingin.xhs"), patch.object(sync, "recover_known_overlay", return_value=False), \
                patch.object(sync, "capture", return_value=listing), patch.object(sync.time, "sleep"), patch.object(sync, "tap_label") as tap:
            self.assertIs(sync.ensure_creator_list("adb", "serial", root, "app1", lambda: None, []), listing)
        tap.assert_called_once_with("adb", "serial", root, "更多笔记", unittest.mock.ANY)

    def growth_prompt(self):
        return xml('<node package="com.xingin.xhs" text="解锁成长中心" bounds="[1,1][90,40]"/>',
                   '<node package="com.xingin.xhs" text="超多创作者权益等你来看" bounds="[1,45][90,80]"/>',
                   '<node package="com.xingin.xhs" text="立即看看" bounds="[1,85][90,120]"/>',
                   '<node package="com.xingin.xhs" class="android.view.ViewGroup" clickable="true" enabled="true" bounds="[48,2016][546,2148]">'
                   '<node package="com.xingin.xhs" text="稍后再看" bounds="[213,2055][381,2109]"/></node>')

    def test_growth_prompt_defer_uses_the_unique_clickable_parent_and_confirms_it_closed(self):
        with patch.object(sync, "focus", return_value="com.xingin.xhs/XhsReactActivity"), patch.object(sync, "capture", return_value=xml()), patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            self.assertTrue(sync.recover_known_overlay("adb", "serial", self.growth_prompt(), lambda: None, []))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", "297", "2082", timeout=7)

    def test_growth_prompt_without_one_enabled_safe_parent_stops_before_tapping(self):
        root = self.growth_prompt()
        root[-1].set("enabled", "false")
        with patch.object(sync, "focus", return_value="com.xingin.xhs/XhsReactActivity"), patch.object(sync, "adb") as adb:
            with self.assertRaisesRegex(RuntimeError, "not proven"):
                sync.recover_known_overlay("adb", "serial", root, lambda: None, [])
            adb.assert_not_called()


class OppoCloneTests(unittest.TestCase):
    def chooser(self):
        return xml('<node package="com.android.intentresolver" class="android.widget.CheckBox" resource-id="com.android.intentresolver:id/button_always_multiapp" text="记住我的选择" checked="false" bounds="[32,1420][720,1468]"/>',
                   '<node package="com.android.intentresolver" class="android.widget.LinearLayout" resource-id="com.android.intentresolver:id/resolver_item_layout" clickable="true" enabled="true" bounds="[24,1220][192,1404]">'
                   '<node package="com.android.intentresolver" text="小红书" resource-id="android:id/text1" enabled="true" bounds="[78,1328][138,1356]"/></node>',
                   '<node package="com.android.intentresolver" class="android.widget.LinearLayout" resource-id="com.android.intentresolver:id/resolver_item_layout" clickable="true" enabled="true" bounds="[192,1220][360,1404]">'
                   '<node package="com.android.intentresolver" text="小红书(分身)" resource-id="android:id/text1" enabled="true" bounds="[218,1328][334,1356]"/></node>')

    def test_clone_selection_uses_the_exact_item_without_remembering_the_choice(self):
        events = []
        with patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            self.assertTrue(sync.select_oppo_clone("adb", "serial", self.chooser(), "com.android.intentresolver/com.android.intentresolver.ChooserActivityLauncher}", "app2", lambda: None, events))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", "276", "1312", timeout=7)
        self.assertIn("clone_user_requested:999", events)

    def test_remembered_choice_or_duplicate_target_is_left_untouched(self):
        roots = [self.chooser(), self.chooser()]
        roots[0][0].set("checked", "true")
        roots[1].append(ET.fromstring(ET.tostring(roots[1][2], encoding="unicode")))
        for root in roots:
            with self.subTest(root=root), patch.object(sync, "adb") as adb:
                with self.assertRaises(RuntimeError):
                    sync.select_oppo_clone("adb", "serial", root, "com.android.intentresolver/com.android.intentresolver.ChooserActivityLauncher}", "app2", lambda: None, [])
            adb.assert_not_called()

    def test_oppo_selector_respects_occupancy_and_exact_activity(self):
        with patch.object(sync, "adb") as adb:
            self.assertFalse(sync.select_oppo_clone("adb", "serial", self.chooser(), "com.other/com.android.intentresolver.ChooserActivityLauncher}", "app2", lambda: None, []))
            with self.assertRaisesRegex(RuntimeError, "occupied"):
                sync.select_oppo_clone("adb", "serial", self.chooser(), "com.android.intentresolver/com.android.intentresolver.ChooserActivityLauncher}", "app2", unittest.mock.Mock(side_effect=RuntimeError("occupied")), [])
        adb.assert_not_called()


class CloneProfileTests(unittest.TestCase):
    def test_xiaomi_and_oppo_require_the_observed_profile_name_and_installed_app(self):
        for brand, name in (("Xiaomi", "XSpace"), ("OPPO", "MultiApp")):
            with self.subTest(brand=brand), patch.object(sync, "adb", side_effect=[brand, f"UserInfo{{999:{name}:4001010}} running", "package:com.xingin.xhs\n"]):
                self.assertEqual(sync.explicit_clone_user("adb", "serial"), "999")
            with self.subTest(brand=brand, other=True), patch.object(sync, "adb", side_effect=[brand, "UserInfo{999:其他用户:4001010} running"]):
                with self.assertRaisesRegex(RuntimeError, "uniquely proven"):
                    sync.explicit_clone_user("adb", "serial")

    def test_only_the_installed_observed_honor_profile_is_accepted(self):
        with patch.object(sync, "adb", side_effect=["HONOR", "Users:\nUserInfo{0:机主:4c13} running\nUserInfo{128:分身应用:4000410} running", "package:com.xingin.xhs\n"]) as adb:
            self.assertEqual(sync.explicit_clone_user("adb", "serial"), "128")
        self.assertEqual(adb.call_args.args[2:], ("shell", "pm", "list", "packages", "--user", "128", "com.xingin.xhs"))

    def test_missing_or_ambiguous_honor_clone_cannot_fall_back_to_the_owner(self):
        for users in ("UserInfo{0:机主:4c13}", "UserInfo{128:分身应用:4000410}\nUserInfo{128:分身应用:4000410}"):
            with self.subTest(users=users), patch.object(sync, "adb", side_effect=["HONOR", users]):
                with self.assertRaisesRegex(RuntimeError, "uniquely proven"):
                    sync.explicit_clone_user("adb", "serial")
        with patch.object(sync, "adb", side_effect=["HONOR", "UserInfo{128:分身应用:4000410}", ""]):
            with self.assertRaisesRegex(RuntimeError, "not installed"):
                sync.explicit_clone_user("adb", "serial")

    def test_honor_start_scopes_stop_resolve_and_start_to_the_proven_user(self):
        def command(_adb, _serial, *args, **kwargs):
            if args[:4] == ("shell", "pm", "list", "packages"):
                return "package:com.xingin.xhs\n"
            if "resolve-activity" in args:
                return "com.xingin.xhs/.index.v2.IndexActivityV2"
            return ""
        events = []
        with patch.object(sync, "explicit_clone_user", return_value="128"), patch.object(sync, "adb", side_effect=command) as adb, \
                patch.object(sync, "capture", return_value=xml()), patch.object(sync.time, "sleep"), \
                patch.object(sync, "focus", return_value="mCurrentFocus=Window{x u128 com.xingin.xhs/.index.v2.IndexActivityV2}"):
            sync.start_xhs("adb", "serial", "app2", lambda: None, events)
            sync.verify_collection_slot("adb", "serial", "app2", events)
        targeted = [c.args[2:] for c in adb.call_args_list if "resolve-activity" in c.args or "force-stop" in c.args or "start" in c.args]
        self.assertEqual(len(targeted), 3)
        self.assertTrue(all("--user" in args and args[args.index("--user") + 1] == "128" for args in targeted))
        self.assertIn("clone_slot_selected:app2", events)

    def test_foreground_owner_and_unproven_slot_are_rejected(self):
        with patch.object(sync, "focus", return_value="mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}"):
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                sync.verify_collection_slot("adb", "serial", "app2", ["clone_user_requested:128"])
        with self.assertRaisesRegex(RuntimeError, "could not be proven"):
            sync.verify_collection_slot("adb", "serial", "app2", [])


class OverlayRecoveryTests(unittest.TestCase):
    def data_center_tabs(self, extra=""):
        return xml('<node package="com.xingin.xhs" class="android.webkit.WebView" text="数据中心" bounds="[0,0][1080,2400]">'
                   '<node package="com.xingin.xhs" class="android.view.View" bounds="[0,252][1080,381]">'
                   '<node package="com.xingin.xhs" text="账号概览" bounds="[0,252][270,381]"/>'
                   '<node package="com.xingin.xhs" class="android.widget.TextView" text="作品分析" enabled="true" clickable="false" bounds="[270,252][540,381]"/>'
                   '<node package="com.xingin.xhs" text="粉丝数据" bounds="[540,252][810,381]"/>'
                   '<node package="com.xingin.xhs" text="收入数据" bounds="[810,252][1080,381]"/>'
                   '</node>' + extra + '</node>')

    def test_non_clickable_web_tab_uses_only_the_proven_header_bounds(self):
        root = self.data_center_tabs()
        events = []
        with patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}"), \
                patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            sync.open_works_tab("adb", "serial", root, lambda: None, events)
        adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", "405", "316", timeout=7)
        self.assertEqual(events, ["data_center_works_tab_selected"])

    def test_duplicate_web_tab_or_a_busy_phone_is_not_tapped(self):
        extra = '<node package="com.xingin.xhs" class="android.widget.TextView" text="作品分析" enabled="true" bounds="[1,700][300,800]"/>'
        for root, guard in ((self.data_center_tabs(extra), lambda: None), (self.data_center_tabs(), unittest.mock.Mock(side_effect=RuntimeError("occupied")))):
            with self.subTest(extra=extra), patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}"), patch.object(sync, "adb") as adb:
                with self.assertRaises(RuntimeError):
                    sync.open_works_tab("adb", "serial", root, guard, [])
                adb.assert_not_called()

    def test_wrapped_clickable_web_tab_still_requires_the_small_header_row(self):
        root = self.data_center_tabs()
        row = root.find("node/node")
        tab = row[1]
        row.remove(tab)
        wrapper = ET.Element("node", {"package": "com.xingin.xhs", "class": "android.view.View", "clickable": "true", "bounds": "[270,252][540,381]"})
        wrapper.append(tab)
        row.append(wrapper)
        with patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}"), \
                patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            self.assertTrue(sync.open_works_tab("adb", "serial", root, lambda: None, []))
        adb.assert_called_once()
        row.set("bounds", "[0,0][1080,2400]")
        with patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}"), patch.object(sync, "adb") as adb:
            with self.assertRaisesRegex(RuntimeError, "outside the header"):
                sync.open_works_tab("adb", "serial", root, lambda: None, [])
        adb.assert_not_called()

    def test_clickable_view_variant_of_the_same_data_center_tab_is_supported(self):
        root = self.data_center_tabs()
        tab = root.find("node/node")[1]
        tab.set("class", "android.view.View")
        tab.set("clickable", "true")
        with patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}"), \
                patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            self.assertTrue(sync.open_works_tab("adb", "serial", root, lambda: None, []))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", "405", "316", timeout=7)

    def test_another_app_with_similar_data_labels_is_not_tapped(self):
        with patch.object(sync, "focus", return_value="com.other/com.xingin.xywebview.activity.WebViewActivityV2}"), patch.object(sync, "adb") as adb:
            self.assertFalse(sync.open_works_tab("adb", "serial", self.data_center_tabs(), lambda: None, []))
        adb.assert_not_called()

    def test_new_creator_overview_route_opens_the_list_without_opening_a_note(self):
        root = xml('<node text="创作中心" bounds="[1,1][90,40]"/>', '<node text="近 7 日数据" bounds="[1,45][90,80]"/>',
                   '<node package="com.xingin.xhs" class="android.widget.TextView" text="观看" bounds="[1,85][90,120]"/>')
        ready = xml('<node text="数据中心" bounds="[1,1][90,40]"/>', '<node text="作品分析" bounds="[1,45][90,80]"/>',
                    '<node text="全部笔记" bounds="[1,85][90,120]"/>')
        events = []
        with patch.object(sync, "wake_if_asleep", return_value=False), patch.object(sync, "recover_known_overlay", return_value=False), \
                patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.reactnative.ui.XhsReactActivity}"), \
                patch.object(sync, "capture", return_value=ready), patch.object(sync.time, "sleep"), patch.object(sync, "tap_label") as tap:
            self.assertIs(sync.ensure_creator_list("adb", "serial", root, "app2", lambda: None, events), ready)
        tap.assert_called_once_with("adb", "serial", root, "观看", unittest.mock.ANY)
        self.assertEqual(events, ["creator_overview_opened_without_latest_notes"])

    def test_xhs_downloaded_update_is_deferred_without_installing(self):
        root = xml('<node package="com.xingin.xhs" text="免流量升级" bounds="[1,1][90,40]"/>',
                   '<node package="com.xingin.xhs" text="立即安装" bounds="[1,45][90,80]"/>',
                   '<node package="com.xingin.xhs" text="稍后再说" class="android.widget.Button" clickable="true" enabled="true" bounds="[170,1060][550,1088]"/>')
        events = []
        with patch.object(sync, "focus", side_effect=["com.xingin.xhs/com.xingin.update.UpdateDialogActivity}", "com.xingin.xhs/.index.v2.IndexActivityV2}"]), \
                patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, events))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", "360", "1074", timeout=7)
        self.assertEqual(events, ["xhs_update_deferred"])

    def test_inaccessible_notification_returns_once_only_with_a_live_guard(self):
        ready = xml()
        events = []
        with patch.object(sync, "capture", side_effect=[RuntimeError("UIAutomator did not return an XML hierarchy"), ready]), \
                patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.authorization.NotificationAuthorizationTranslucentActivity}"), \
                patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            guard = unittest.mock.Mock()
            self.assertIs(sync.navigation_capture("adb", "serial", guard, events), ready)
        guard.assert_called_once()
        adb.assert_called_once_with("adb", "serial", "shell", "input", "keyevent", "4", timeout=7)
        self.assertEqual(events, ["inaccessible_notification_prompt_back"])

    def test_inaccessible_notification_does_not_touch_occupied_phone_or_other_activity(self):
        for current, busy in (
            ("com.xingin.xhs/com.xingin.reactnative.ui.XhsReactActivity}", False),
            ("com.other.app/com.xingin.authorization.NotificationAuthorizationTranslucentActivity}", False),
            ("com.xingin.xhs/com.xingin.authorization.NotificationAuthorizationTranslucentActivity}", True),
        ):
            with self.subTest(current=current, busy=busy), \
                    patch.object(sync, "capture", side_effect=RuntimeError("UIAutomator did not return an XML hierarchy")), \
                    patch.object(sync, "focus", return_value=current), patch.object(sync, "adb") as adb:
                guard = unittest.mock.Mock(side_effect=RuntimeError("occupied") if busy else None)
                with self.assertRaises(RuntimeError):
                    sync.navigation_capture("adb", "serial", guard, [])
                adb.assert_not_called()

    def test_inaccessible_notification_retry_cannot_loop(self):
        with patch.object(sync, "capture", side_effect=RuntimeError("UIAutomator did not return an XML hierarchy")) as capture, \
                patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.authorization.NotificationAuthorizationTranslucentActivity}"), \
                patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            with self.assertRaises(RuntimeError):
                sync.navigation_capture("adb", "serial", lambda: None, [])
        self.assertEqual(capture.call_count, 2)
        self.assertEqual(adb.call_count, 1)

    def test_oppo_notification_prompt_uses_back_without_granting_permission(self):
        root = xml('<node package="com.oplus.notificationmanager" text="允许“小红书”发送通知吗？" bounds="[1,1][200,40]"/>',
                   '<node package="com.oplus.notificationmanager" text="允许" clickable="true" bounds="[1,50][90,100]"/>')
        events = []
        with patch.object(sync, "focus", return_value="com.oplus.notificationmanager}"), patch.object(sync, "capture", return_value=xml()), \
                patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, events))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "keyevent", "4", timeout=7)
        self.assertEqual(events, ["oppo_notification_prompt_back"])

    def test_oppo_other_app_notification_is_untouched(self):
        root = xml('<node package="com.oplus.notificationmanager" text="允许“其他应用”发送通知吗？" bounds="[1,1][200,40]"/>')
        with patch.object(sync, "focus", return_value="com.oplus.notificationmanager}"), patch.object(sync, "adb") as adb:
            self.assertFalse(sync.recover_known_overlay("adb", "serial", root, lambda: None, []))
        adb.assert_not_called()

    def heytap_prompt(self, app="小红书"):
        return xml(f'<node package="com.heytap.mcs" text="允许“{app}”向你发送消息？" resource-id="com.heytap.mcs:id/notification_permission_txt_title" bounds="[60,1781][1020,1854]"/>',
                   '<node package="com.heytap.mcs" text="禁止" resource-id="com.heytap.mcs:id/notification_permission_btn_close" clickable="true" enabled="true" bounds="[60,2013][538,2145]"/>')

    def test_heytap_declines_only_the_exact_xhs_notification_request(self):
        root = self.heytap_prompt()
        events = []
        with patch.object(sync, "focus", return_value="com.heytap.mcs/com.heytap.mcs.addition.notifi.NotifiPermissionActivity}"), \
                patch.object(sync, "capture", side_effect=[root, xml()]), patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, events))
        self.assertEqual([c.args[2:] for c in adb.call_args_list], [("shell", "input", "keyevent", "4"), ("shell", "input", "tap", "299", "2079")])
        self.assertEqual(events, ["heytap_notification_prompt_denied"])

    def test_heytap_request_for_another_app_is_untouched(self):
        with patch.object(sync, "focus", return_value="com.heytap.mcs/com.heytap.mcs.addition.notifi.NotifiPermissionActivity}"), patch.object(sync, "adb") as adb:
            self.assertFalse(sync.recover_known_overlay("adb", "serial", self.heytap_prompt("其他应用"), lambda: None, []))
        adb.assert_not_called()

    def test_oppo_back_ignoring_dialog_declines_only_the_verified_xhs_button(self):
        root = xml('<node package="com.oplus.notificationmanager" text="允许“小红书”发送通知吗？" bounds="[1,1][200,40]"/>',
                   '<node package="com.oplus.notificationmanager" resource-id="android:id/button2" class="android.widget.Button" text="拒绝" '
                   'clickable="true" enabled="true" bounds="[1,50][101,100]"/>')
        events = []
        with patch.object(sync, "focus", return_value="com.oplus.notificationmanager}"), patch.object(sync, "capture", side_effect=[root, xml()]), \
                patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, events))
        self.assertEqual([call.args[2:] for call in adb.call_args_list], [("shell", "input", "keyevent", "4"), ("shell", "input", "tap", "51", "75")])
        self.assertEqual(events, ["oppo_notification_prompt_denied"])

    def test_oppo_still_open_without_a_safe_decline_stops_after_back(self):
        root = xml('<node package="com.oplus.notificationmanager" text="允许“小红书”发送通知吗？" bounds="[1,1][200,40]"/>',
                   '<node package="com.oplus.notificationmanager" text="允许" clickable="true" bounds="[1,50][101,100]"/>')
        with patch.object(sync, "focus", return_value="com.oplus.notificationmanager}"), patch.object(sync, "capture", return_value=root), \
                patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            with self.assertRaisesRegex(RuntimeError, "safe decline action not proven"):
                sync.recover_known_overlay("adb", "serial", root, lambda: None, [])
        adb.assert_called_once_with("adb", "serial", "shell", "input", "keyevent", "4", timeout=7)

    def test_new_creator_drawer_alias_uses_the_button_without_opening_a_note(self):
        root = xml('<node package="com.xingin.xhs" class="android.widget.Button" content-desc="创作中心" '
                   'clickable="true" enabled="true" bounds="[0,281][560,377]"/>',
                   '<node package="com.xingin.xhs" text="我的草稿" bounds="[0,380][560,400]"/>')
        ready = xml('<node text="数据中心" bounds="[1,1][90,40]"/>',
                    '<node text="作品分析" bounds="[1,45][90,80]"/>', '<node text="全部笔记" bounds="[1,85][90,120]"/>')
        events = []
        with patch.object(sync, "wake_if_asleep", return_value=False), patch.object(sync, "recover_known_overlay", return_value=False), \
                patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2}"), \
                patch.object(sync, "capture", return_value=ready), patch.object(sync, "tap_label") as tap:
            self.assertIs(sync.ensure_creator_list("adb", "serial", root, "app1", lambda: None, events), ready)
        tap.assert_called_once_with("adb", "serial", root, "创作中心", unittest.mock.ANY)
        self.assertEqual(events, ["creator_drawer_alias_selected"])

    def test_index_menu_fallback_requires_one_enabled_xhs_menu(self):
        root = xml('<node package="com.xingin.xhs" content-desc="菜单" clickable="true" enabled="true" bounds="[18,63][90,135]"/>')
        ready = xml('<node text="数据中心" bounds="[1,1][90,40]"/>',
                    '<node text="作品分析" bounds="[1,45][90,80]"/>', '<node text="全部笔记" bounds="[1,85][90,120]"/>')
        events = []
        with patch.object(sync, "wake_if_asleep", return_value=False), patch.object(sync, "recover_known_overlay", return_value=False), \
                patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2}"), \
                patch.object(sync, "capture", return_value=ready), patch.object(sync, "tap_label") as tap:
            self.assertIs(sync.ensure_creator_list("adb", "serial", root, "app1", lambda: None, events), ready)
        tap.assert_called_once_with("adb", "serial", root, "菜单", unittest.mock.ANY)
        self.assertEqual(events, ["index_menu_opened_without_bottom_tab"])

    def test_chat_with_unsent_text_is_left_untouched(self):
        root = xml('<node package="com.xingin.xhs" class="android.widget.EditText" text="未发送的测试草稿" bounds="[1,1][100,40]"/>')
        with patch.object(sync, "wake_if_asleep", return_value=False), patch.object(sync, "recover_known_overlay", return_value=False), \
                patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.im.ui.activity.ChatActivity}"), patch.object(sync, "adb") as adb:
            with self.assertRaisesRegex(RuntimeError, "unsent text"):
                sync.ensure_creator_list("adb", "serial", root, "app2", lambda: None, [])
        adb.assert_not_called()

    def test_observed_unfocused_message_hint_can_return_without_sending(self):
        root = xml('<node package="com.xingin.xhs" class="android.widget.EditText" text="发消息…" focused="false" bounds="[120,1512][524,1592]"/>')
        ready = xml('<node text="数据中心" bounds="[1,1][90,40]"/>', '<node text="作品分析" bounds="[1,45][90,80]"/>',
                    '<node text="全部笔记" bounds="[1,85][90,120]"/>')
        with patch.object(sync, "wake_if_asleep", return_value=False), patch.object(sync, "recover_known_overlay", return_value=False), \
                patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.im.ui.activity.ChatActivity}"), \
                patch.object(sync, "capture", return_value=ready), patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            sync.ensure_creator_list("adb", "serial", root, "app1", lambda: None, [])
        adb.assert_called_once_with("adb", "serial", "shell", "input", "keyevent", "4", timeout=7)

    def test_focused_message_hint_is_preserved_as_possible_unsent_text(self):
        root = xml('<node package="com.xingin.xhs" class="android.widget.EditText" text="发消息…" focused="true" bounds="[120,1512][524,1592]"/>')
        with patch.object(sync, "wake_if_asleep", return_value=False), patch.object(sync, "recover_known_overlay", return_value=False), \
                patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.im.ui.activity.ChatActivity}"), patch.object(sync, "adb") as adb:
            with self.assertRaisesRegex(RuntimeError, "unsent text"):
                sync.ensure_creator_list("adb", "serial", root, "app1", lambda: None, [])
        adb.assert_not_called()

    def test_empty_dump_on_logged_out_activity_reports_login_without_tapping(self):
        with patch.object(sync, "adb", return_value="ERROR: could not get idle state.") as adb, \
                patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.login.device.offline.DeviceOfflineRemindActivity}"), \
                patch.object(sync.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "manual login is required"):
                sync.capture("adb", "serial")
        self.assertEqual(adb.call_count, 2)
        self.assertTrue(all(call.args[2:4] == ("exec-out", "uiautomator") for call in adb.call_args_list))

    def test_empty_dump_in_other_activity_keeps_the_original_failure(self):
        with patch.object(sync, "adb", return_value="ERROR: could not get idle state."), \
                patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.reactnative.ui.XhsReactActivity}"), \
                patch.object(sync.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "did not return an XML hierarchy"):
                sync.capture("adb", "serial")

    def huawei_usb(self, button):
        return xml('<node package="com.android.settings" resource-id="android:id/alertTitle" text="USB 连接方式" bounds="[1,1][90,40]"/>',
                   '<node package="com.android.settings" text="传输照片" bounds="[1,45][90,80]"/>',
                   '<node package="com.android.settings" text="传输文件" bounds="[1,85][90,120]"/>',
                   '<node package="com.android.settings" text="仅充电" bounds="[1,125][90,160]"/>', button)

    def test_huawei_usb_cancels_only_the_proven_dialog(self):
        root = self.huawei_usb('<node package="com.android.settings" resource-id="android:id/button2" text="取消" clickable="true" '
                               'enabled="true" bounds="[84,2064][996,2184]"/>')
        events = []
        with patch.object(sync, "focus", return_value="mCurrentFocus=Window{abc u0 com.android.settings}"), \
                patch.object(sync, "capture", return_value=xml()), patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, events))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", "540", "2124", timeout=7)
        self.assertEqual(events, ["huawei_usb_mode_cancelled"])

    def test_huawei_usb_rejects_ambiguous_disabled_or_foreign_cancel(self):
        button = '<node package="com.android.settings" resource-id="android:id/button2" text="取消" clickable="true" enabled="true" bounds="[1,165][90,200]"/>'
        for buttons, focus in (
            ("", "com.android.settings}"), (button + button, "com.android.settings}"),
            (button.replace('enabled="true"', 'enabled="false"'), "com.android.settings}"),
            (button.replace('package="com.android.settings"', 'package="android"'), "com.android.settings}"),
            (button, "com.android.settings.fake}"), (button, "com.xingin.xhs/IndexActivityV2"),
        ):
            with self.subTest(buttons=buttons, focus=focus), patch.object(sync, "focus", return_value=focus), patch.object(sync, "adb") as adb:
                with self.assertRaisesRegex(RuntimeError, "safe cancel action not proven"):
                    sync.recover_known_overlay("adb", "serial", self.huawei_usb(buttons), lambda: None, [])
                adb.assert_not_called()

    def test_huawei_usb_debug_authorization_is_not_a_mode_dialog(self):
        root = xml('<node package="com.android.settings" text="允许 USB 调试吗？" bounds="[1,1][90,40]"/>',
                   '<node package="com.android.settings" resource-id="android:id/button2" text="取消" clickable="true" enabled="true" bounds="[1,85][90,120]"/>')
        with patch.object(sync, "focus", return_value="com.android.settings}"), patch.object(sync, "adb") as adb:
            self.assertFalse(sync.recover_known_overlay("adb", "serial", root, lambda: None, []))
        adb.assert_not_called()

    def test_logged_out_device_stops_without_login_actions(self):
        with patch.object(sync, "wake_if_asleep", return_value=False), \
                patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.login.device.offline.DeviceOfflineRemindActivity}"), \
                patch.object(sync, "adb") as adb, patch.object(sync, "tap_label") as tap:
            with self.assertRaisesRegex(RuntimeError, "manual login is required"):
                sync.ensure_creator_list("adb", "serial", xml(), "app1", lambda: None, [])
        adb.assert_not_called()
        tap.assert_not_called()

    def test_creator_permission_hint_stops_without_enrolling(self):
        root = xml('<node package="com.xingin.xhs" text="创作中心" bounds="[1,1][90,40]"/>',
                   '<node package="com.xingin.xhs" text="开通数据权限" bounds="[1,45][90,80]"/>')
        with patch.object(sync, "wake_if_asleep", return_value=False), patch.object(sync, "focus", return_value="com.xingin.xhs/CreatorActivity}"), \
                patch.object(sync, "adb") as adb, patch.object(sync, "tap_label") as tap:
            with self.assertRaisesRegex(RuntimeError, "data permission is not enabled"):
                sync.ensure_creator_list("adb", "serial", root, "app1", lambda: None, [])
        adb.assert_not_called()
        tap.assert_not_called()

    def honor_update(self, buttons):
        return xml('<node package="com.hihonor.ouc" text="软件更新" bounds="[1,1][90,40]"/>',
                   '<node package="com.hihonor.ouc" text="下载并安装" clickable="true" enabled="true" bounds="[1,45][90,80]"/>',
                   buttons)

    def test_honor_update_uses_only_the_proven_defer_button(self):
        root = self.honor_update('<node package="com.hihonor.ouc" text="稍后" clickable="true" '
                                 'enabled="true" bounds="[108,2184][972,2316]"/>')
        events = []
        with patch.object(sync, "focus", side_effect=["mCurrentFocus=Window{abc u0 com.hihonor.ouc}", "com.xingin.xhs/IndexActivityV2"]), \
                patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, events))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", "540", "2250", timeout=7)
        self.assertEqual(events, ["honor_update_deferred"])

    def test_honor_defer_requires_exact_focus_package_and_unique_enabled_button(self):
        button = '<node package="com.hihonor.ouc" text="稍后" clickable="true" enabled="true" bounds="[1,85][90,120]"/>'
        for buttons, focus in (
            ("", "com.hihonor.ouc}"),
            (button + button, "com.hihonor.ouc}"),
            (button.replace('enabled="true"', 'enabled="false"'), "com.hihonor.ouc}"),
            (button.replace('package="com.hihonor.ouc"', 'package="android"'), "com.hihonor.ouc}"),
            (button, "com.hihonor.ouc.fake}"),
            (button, "com.xingin.xhs/IndexActivityV2"),
        ):
            with self.subTest(buttons=buttons, focus=focus), patch.object(sync, "focus", return_value=focus), \
                    patch.object(sync, "adb") as adb:
                with self.assertRaisesRegex(RuntimeError, "safe defer action not proven"):
                    sync.recover_known_overlay("adb", "serial", self.honor_update(buttons), lambda: None, [])
                adb.assert_not_called()

    def test_honor_update_that_stays_open_stops_after_one_defer(self):
        root = self.honor_update('<node package="com.hihonor.ouc" text="稍后" clickable="true" '
                                 'enabled="true" bounds="[1,85][90,120]"/>')
        with patch.object(sync, "focus", return_value="com.hihonor.ouc}"), \
                patch.object(sync.time, "sleep"), patch.object(sync, "adb") as adb:
            with self.assertRaisesRegex(RuntimeError, "stayed open"):
                sync.recover_known_overlay("adb", "serial", root, lambda: None, [])
        self.assertEqual(adb.call_count, 1)

    def test_restored_clone_chat_returns_without_tapping_chat_text(self):
        chat = xml('<node package="com.xingin.xhs" text="我" clickable="true" '
                   'bounds="[20,1500][120,1600]"/>')
        ready = xml('<node text="数据中心" bounds="[1,1][90,40]"/>',
                    '<node text="作品分析" bounds="[1,45][90,80]"/>',
                    '<node text="全部笔记" bounds="[1,85][90,120]"/>')
        events = []
        with patch.object(sync, "wake_if_asleep", return_value=False), \
                patch.object(sync, "recover_known_overlay", return_value=False), \
                patch.object(sync, "focus", return_value="mCurrentFocus=Window{abc u0 com.xingin.xhs/com.xingin.im.ui.activity.ChatActivity}"), \
                patch.object(sync, "capture", return_value=ready), \
                patch.object(sync, "tap_label") as tap, patch.object(sync, "adb") as adb:
            self.assertIs(sync.ensure_creator_list("adb", "serial", chat, "app2", lambda: None, events), ready)
        adb.assert_called_once_with("adb", "serial", "shell", "input", "keyevent", "4", timeout=7)
        tap.assert_not_called()
        self.assertEqual(events, ["restored_chat_back"])

    def test_chat_return_requires_exact_xhs_package_and_activity(self):
        for value, expected in (
            ("com.xingin.xhs/.im.ui.activity.ChatActivity}", True),
            ("com.other.app/com.xingin.im.ui.activity.ChatActivity}", False),
            ("com.xingin.xhs/com.xingin.im.ui.activity.ChatActivityFake}", False),
            ("com.xingin.xhs/com.xingin.reactnative.ui.XhsReactActivity}", False),
        ):
            with self.subTest(value=value):
                self.assertEqual(sync.xhs_chat_activity(value), expected)

    def test_restored_chat_return_is_bounded_to_two_backs(self):
        root = xml('<node package="com.xingin.xhs" bounds="[1,1][100,200]"/>')
        with patch.object(sync, "wake_if_asleep", return_value=False), \
                patch.object(sync, "recover_known_overlay", return_value=False), \
                patch.object(sync, "focus", return_value="com.xingin.xhs/com.xingin.im.ui.activity.ChatActivity}"), \
                patch.object(sync, "capture", return_value=root), patch.object(sync, "adb") as adb:
            with self.assertRaisesRegex(RuntimeError, "chat page did not close"):
                sync.ensure_creator_list("adb", "serial", root, "app2", lambda: None, [])
        self.assertEqual(adb.call_count, 2)

    def test_agent_cancellation_marker_stops_before_reading_device_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / "cancelled"
            marker.write_text("cancelled")
            with self.assertRaisesRegex(RuntimeError, "automation_task_cancelled"):
                sync.assert_idle("missing-cache", "TEST_SERIAL", "102", "job-1", "app1", marker)

    def test_inventory_allows_only_the_matching_collection_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder) / "devices.json"
            row = {"deviceName": "102", "adb": {"serial": "TEST_SERIAL", "state": "device"}}
            for occupancy, allowed in (
                (None, True),
                ({"kind": "xhs_data_collect", "taskId": "job-1", "appSlot": "app1"}, True),
                ({"kind": "xhs_data_collect", "taskId": "job-other", "appSlot": "app1"}, False),
                ({"kind": "xhs_data_collect", "taskId": "job-1", "appSlot": "app2"}, False),
                ({"kind": "screen_control", "taskId": "job-1", "appSlot": "app1"}, False),
            ):
                cache.write_text(json.dumps([{**row, "occupancy": occupancy}]))
                with self.subTest(occupancy=occupancy):
                    if allowed:
                        self.assertEqual(sync.assert_idle(cache, "TEST_SERIAL", "102", "job-1", "app1")["deviceName"], "102")
                    else:
                        with self.assertRaisesRegex(RuntimeError, "occupied"):
                            sync.assert_idle(cache, "TEST_SERIAL", "102", "job-1", "app1")
            cache.write_text(json.dumps([{**row, "occupancy": {"kind": "xhs_data_collect", "taskId": "job-1", "appSlot": "app1"}}]))
            with self.assertRaisesRegex(RuntimeError, "occupied"):
                sync.assert_idle(cache, "TEST_SERIAL", "102")

    def draft_prompt(self, buttons):
        return xml('<node package="com.xingin.xhs" text="继续编辑图文笔记吗？" '
                   'bounds="[200,1022][520,1059]"/>', buttons)

    def test_draft_prompt_saves_existing_content_once(self):
        root = self.draft_prompt(
            '<node package="com.xingin.xhs" text="存草稿" clickable="true" enabled="true" '
            'bounds="[130,1099][348,1171]"/>'
            '<node package="com.xingin.xhs" text="去编辑" clickable="true" enabled="true" '
            'bounds="[372,1099][590,1171]"/>')
        events = []
        with patch.object(sync, "focus", return_value="mCurrentFocus=com.xingin.xhs/IndexActivityV2"), \
                patch.object(sync, "capture", return_value=xml()), \
                patch.object(sync, "adb") as adb, patch.object(sync.time, "sleep"):
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, events))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", "239", "1135", timeout=7)
        self.assertEqual(events, ["draft_saved_before_collection"])

    def test_draft_save_requires_unique_enabled_xhs_button(self):
        for buttons in (
            '<node package="com.xingin.xhs" text="去编辑" clickable="true" enabled="true" bounds="[1,1][90,40]"/>',
            '<node package="com.xingin.xhs" text="存草稿" clickable="true" enabled="false" bounds="[1,1][90,40]"/>',
            '<node package="android" text="存草稿" clickable="true" enabled="true" bounds="[1,1][90,40]"/>',
            '<node package="com.xingin.xhs" text="存草稿" clickable="true" enabled="true" bounds="[1,1][90,40]"/>'
            '<node package="com.xingin.xhs" text="存草稿" clickable="true" enabled="true" bounds="[1,45][90,80]"/>',
        ):
            with self.subTest(buttons=buttons), \
                    patch.object(sync, "focus", return_value="mCurrentFocus=com.xingin.xhs/IndexActivityV2"), \
                    patch.object(sync, "adb") as adb:
                with self.assertRaisesRegex(RuntimeError, "save action not proven"):
                    sync.recover_known_overlay("adb", "serial", self.draft_prompt(buttons), lambda: None, [])
                adb.assert_not_called()

    def test_draft_save_uses_proven_clickable_parent(self):
        root = self.draft_prompt('<node package="com.xingin.xhs" clickable="true" enabled="true" '
                                 'bounds="[130,1099][348,1171]">'
                                 '<node package="com.xingin.xhs" text="存草稿" clickable="false" '
                                 'bounds="[140,1110][338,1160]"/></node>')
        with patch.object(sync, "focus", return_value="mCurrentFocus=com.xingin.xhs/IndexActivityV2"), \
                patch.object(sync, "capture", return_value=xml()), \
                patch.object(sync, "adb") as adb, patch.object(sync.time, "sleep"):
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, []))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", "239", "1135", timeout=7)

    def test_draft_prompt_that_remains_open_fails_after_one_tap(self):
        root = self.draft_prompt('<node package="com.xingin.xhs" text="存草稿" clickable="true" '
                                 'enabled="true" bounds="[130,1099][348,1171]"/>')
        with patch.object(sync, "focus", return_value="mCurrentFocus=com.xingin.xhs/IndexActivityV2"), \
                patch.object(sync, "capture", return_value=root), \
                patch.object(sync, "adb") as adb, patch.object(sync.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "stayed open"):
                sync.recover_known_overlay("adb", "serial", root, lambda: None, [])
        self.assertEqual(adb.call_count, 1)

    def test_save_draft_without_resume_question_is_untouched(self):
        root = xml('<node package="com.xingin.xhs" text="存草稿" clickable="true" enabled="true" '
                   'bounds="[130,1099][348,1171]"/>')
        with patch.object(sync, "focus", return_value="mCurrentFocus=com.xingin.xhs/IndexActivityV2"), \
                patch.object(sync, "adb") as adb:
            self.assertFalse(sync.recover_known_overlay("adb", "serial", root, lambda: None, []))
        adb.assert_not_called()

    def test_leftover_poco_on_idle_target_is_released_before_xml(self):
        events = []
        with patch.object(sync, "adb", side_effect=[
            "u0_a1 com.netease.open.pocoservice", "", "u0_a2 com.xingin.xhs"
        ]) as adb, patch.object(sync.time, "sleep"):
            sync.release_idle_poco("adb", "serial", lambda: None, events)
        self.assertEqual(adb.call_args_list[1].args,
                         ("adb", "serial", "shell", "am", "force-stop", "com.netease.open.pocoservice"))
        self.assertEqual(events, ["idle_poco_released"])

    def test_dozing_phone_uses_power_key_only_after_wakeup_fails(self):
        events = []
        with patch.object(sync, "adb", side_effect=[
            "mWakefulness=Dozing", "", "", "mWakefulness=Dozing", "", "",
            "mWakefulness=Awake",
        ]) as adb, patch.object(sync.time, "sleep"):
            self.assertTrue(sync.wake_if_asleep("adb", "serial", lambda: None, events))
        self.assertEqual([call.args[5] for call in adb.call_args_list if call.args[2:4] == ("shell", "input")],
                         ["224", "26"])
        self.assertEqual(events, ["screen_woken_after_timeout"])

    def test_mm_dd_window_crosses_new_year(self):
        as_of = dt.date(2027, 1, 5)
        self.assertEqual(sync.published_date("12-31", as_of), dt.date(2026, 12, 31))
        self.assertEqual(sync.published_date("01-05", as_of), as_of)
        self.assertEqual(sync.published_date("02-29", dt.date(2025, 1, 5)), dt.date(2024, 2, 29))

    def test_webview_refresh_only_opens_and_closes_proven_filter(self):
        list_root = xml('<node bounds="[0,0][720,1612]">'
                        '<node text="数据中心" bounds="[1,1][90,40]"/>'
                        '<node text="作品分析" bounds="[1,45][90,80]"/>'
                        '<node package="com.xingin.xhs" text="全部笔记" bounds="[1,85][90,120]"/>'
                        '</node>')
        panel = xml('<node bounds="[0,0][720,1612]">'
                    '<node text="笔记类型" bounds="[1,1][90,40]"/>'
                    '<node text="发布时间" bounds="[1,45][90,80]"/>'
                    '<node text="排序方式" bounds="[1,85][90,120]"/>'
                    '<node package="com.xingin.xhs" text="收起" bounds="[1,125][90,160]"/>'
                    '</node>')
        events = []
        with patch.object(sync, "wake_if_asleep"), patch.object(sync, "tap_filter_label") as tap, \
                patch.object(sync, "capture", side_effect=[panel, list_root]):
            result = sync.refresh_scrolled_webview("adb", "serial", list_root, lambda: None, events)
        self.assertIs(result, list_root)
        self.assertEqual([call.args[3] for call in tap.call_args_list], ["全部笔记", "收起"])
        self.assertEqual(events, ["webview_accessibility_refreshed"])

    def test_clipped_card_with_image_hash_and_no_metrics_is_skipped(self):
        root = xml(
            '<node clickable="true" bounds="[30,0][690,210]">'
            '<node text="09-24" bounds="[30,100][170,140]"/>'
            '<node text="353ea5c70f0254174e836a624b3af557c3a4b5de" bounds="[190,20][690,70]"/>'
            '<node text="笔记状态正常" bounds="[190,80][400,110]"/>'
            '</node>'
        )
        self.assertEqual(sync.note_cards(root), [])

    def test_nonclickable_webview_card_with_all_fields_is_read(self):
        root = xml(
            '<node clickable="false" bounds="[30,336][690,546]">'
            '<node text="09-28" bounds="[30,500][170,540]"/>'
            '<node text="测试作品" bounds="[190,350][550,390]"/>'
            '<node text="笔记状态正常" bounds="[226,420][364,448]"/>'
            '<node text="108" bounds="[190,475][240,500]"/>'
            '<node text="0" bounds="[300,475][330,500]"/>'
            '<node text="1" bounds="[400,475][430,500]"/>'
            '</node>'
        )
        cards = sync.note_cards(root)
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0][1]["title"], "测试作品")
        self.assertEqual([cards[0][1][k] for k in
                          ("list_view_count", "list_like_count", "list_comment_count")], [108, 0, 1])

    def test_abnormal_creator_account_fails_before_navigation(self):
        root = xml('<node bounds="[0,0][720,1612]">'
                   '<node text="账号异常" bounds="[10,10][150,50]"/>'
                   '<node text="开通数据权限" bounds="[10,60][150,100]"/>'
                   '<node text="创作中心" bounds="[10,110][150,150]"/>'
                   '</node>')
        with patch.object(sync, "wake_if_asleep", return_value=False), \
                patch.object(sync, "adb") as adb:
            with self.assertRaisesRegex(RuntimeError, "abnormal status"):
                sync.ensure_creator_list("adb", "serial", root, "app1", lambda: None, [])
        adb.assert_not_called()

    def test_abnormal_creator_account_reports_inert_more_entry(self):
        root = xml('<node bounds="[0,0][720,1612]">'
                   '<node text="账号异常" bounds="[10,10][150,50]"/>'
                   '<node text="创作中心" bounds="[10,60][150,100]"/>'
                   '<node text="最新笔记" bounds="[10,110][150,150]"/>'
                   '<node text="更多" bounds="[500,110][620,150]"/>'
                   '</node>')
        with patch.object(sync, "wake_if_asleep", return_value=False), \
                patch.object(sync, "focus", return_value="com.xingin.xhs"), \
                patch.object(sync, "tap_label") as tap, \
                patch.object(sync, "capture", return_value=root), \
                patch.object(sync.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "More did not open works analysis"):
                sync.ensure_creator_list("adb", "serial", root, "app1", lambda: None, [])
        self.assertEqual(tap.call_count, 2)

    def test_header_only_webview_is_reopened_before_failing(self):
        shell = xml('<node><node text="数据中心" bounds="[1,1][90,40]"/>'
                    '<node text="作品分析" bounds="[1,45][90,80]"/></node>')
        center = xml('<node><node text="创作中心" bounds="[1,1][90,40]"/>'
                     '<node text="最新笔记" bounds="[1,45][90,80]"/>'
                     '<node text="更多" bounds="[1,85][90,120]"/></node>')
        listing = xml('<node><node text="数据中心" bounds="[1,1][90,40]"/>'
                      '<node text="作品分析" bounds="[1,45][90,80]"/>'
                      '<node text="全部笔记" bounds="[1,85][90,120]"/></node>')
        events = []
        with patch.object(sync, "wake_if_asleep", return_value=False), \
                patch.object(sync, "adb") as adb, \
                patch.object(sync, "tap_label") as tap, \
                patch.object(sync, "capture", side_effect=[shell, shell, center, listing]), \
                patch.object(sync.time, "sleep"):
            result = sync.ensure_creator_list("adb", "serial", shell, "app1", lambda: None, events)
        self.assertIs(result, listing)
        adb.assert_called_once_with("adb", "serial", "shell", "input", "keyevent", "4", timeout=7)
        self.assertEqual(tap.call_args.args[3], "更多")
        self.assertEqual(events, ["works_analysis_shell_reopened"])

    def test_transient_empty_ui_dump_retries_once(self):
        with patch.object(sync, "adb", side_effect=["UI hierarchy unavailable", "<hierarchy></hierarchy>"]) as adb, \
                patch.object(sync.time, "sleep") as sleep:
            self.assertEqual(sync.capture("adb", "serial").tag, "hierarchy")
        self.assertEqual(adb.call_count, 2)
        sleep.assert_called_once_with(0.5)

    def test_exact_vivo_update_defer(self):
        root = xml(
            '<node package="com.bbk.updater" text="系统升级"/>',
            '<node package="com.bbk.updater" resource-id="android:id/button2" '
            'clickable="true" enabled="true" bounds="[10,20][110,80]">'
            '<node package="com.bbk.updater" text="稍后提醒"/></node>',
        )
        events = []
        with patch.object(sync, "focus", side_effect=["mCurrentFocus=com.bbk.updater", "mCurrentFocus=com.xingin.xhs"]), \
                patch.object(sync, "adb") as adb, patch.object(sync.time, "sleep"):
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, events))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", "60", "50", timeout=7)
        self.assertEqual(events, ["vivo_update_deferred"])

    def test_vivo_update_without_exact_button_fails_closed(self):
        root = xml(
            '<node package="com.bbk.updater" text="系统升级"/>',
            '<node package="com.bbk.updater" resource-id="android:id/button1" '
            'clickable="true" enabled="true" bounds="[10,20][110,80]">'
            '<node package="com.bbk.updater" text="稍后提醒"/></node>',
        )
        with patch.object(sync, "focus", return_value="mCurrentFocus=com.bbk.updater"), \
                patch.object(sync, "adb") as adb:
            with self.assertRaisesRegex(RuntimeError, "not proven"):
                sync.recover_known_overlay("adb", "serial", root, lambda: None, [])
        adb.assert_not_called()

    def test_exact_vivo_usb_cancel(self):
        root = xml(
            '<node package="android" resource-id="android:id/alertTitle" text="USB 已连接"/>',
            '<node package="android" resource-id="android:id/button2" text="取消" '
            'clickable="true" enabled="true" bounds="[100,300][200,350]"/>',
        )
        events = []
        with patch.object(sync, "focus", side_effect=["mCurrentFocus=VivoUsbDialog", "mCurrentFocus=com.xingin.xhs"]), \
                patch.object(sync, "adb") as adb, patch.object(sync.time, "sleep"):
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, events))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", "150", "325", timeout=7)
        self.assertEqual(events, ["vivo_usb_cancelled"])

    def test_notification_prompt_uses_back(self):
        events = []
        with patch.object(sync, "focus", side_effect=["mCurrentFocus=NotificationAuthorizationTranslucentActivity", "mCurrentFocus=com.xingin.xhs"]), \
                patch.object(sync, "adb") as adb, patch.object(sync.time, "sleep"):
            self.assertTrue(sync.recover_known_overlay("adb", "serial", xml(), lambda: None, events))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "keyevent", "4", timeout=7)
        self.assertEqual(events, ["notification_prompt_back"])

    def test_milestone_popup_uses_back(self):
        root = xml(
            '<node package="com.xingin.xhs" text="恭喜你🎉累计获得500个赞和收藏啦"/>',
            '<node package="com.xingin.xhs" text="去发布" clickable="true" bounds="[48,2124][1032,2158]"/>',
        )
        events = []
        with patch.object(sync, "focus", return_value="mCurrentFocus=com.xingin.xhs/IndexActivityV2"), \
                patch.object(sync, "adb") as adb, patch.object(sync.time, "sleep"):
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, events))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "keyevent", "4", timeout=7)
        self.assertEqual(events, ["celebration_back"])

    def test_android_usb_mode_cancel(self):
        root = xml(
            '<node package="com.android.settings" resource-id="com.android.settings:id/alertTitle" text="USB 用于"/>',
            '<node package="com.android.settings" text="仅限充电"/>',
            '<node package="com.android.settings" text="传输文件"/>',
            '<node package="com.android.settings" text="传输照片"/>',
            '<node package="com.android.settings" resource-id="android:id/button2" text="取消" '
            'clickable="true" enabled="true" bounds="[110,2036][969,2172]"/>',
        )
        events = []
        with patch.object(sync, "focus", side_effect=[
            "mCurrentFocus=com.android.settings/com.android.settings.Settings$UsbDetailsActivity",
            "mCurrentFocus=com.xingin.xhs/IndexActivityV2",
        ]), patch.object(sync, "adb") as adb, patch.object(sync.time, "sleep"):
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, events))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", "539", "2104", timeout=7)
        self.assertEqual(events, ["android_usb_mode_cancelled"])

    def test_growth_center_offer_deferred(self):
        root = xml(
            '<node package="com.xingin.xhs" text="解锁成长中心"/>',
            '<node package="com.xingin.xhs" text="超多创作者权益等你来看"/>',
            '<node package="com.xingin.xhs" text="立即看看"/>',
            '<node package="com.xingin.xhs" content-desc="稍后再看" clickable="true" enabled="true" bounds="[44,2060][501,2181]">'
            '<node package="com.xingin.xhs" text="稍后再看" bounds="[194,2096][350,2146]"/>'
            '</node>',
        )
        events = []
        with patch.object(sync, "focus", return_value="mCurrentFocus=com.xingin.xhs/XhsReactActivity"), \
                patch.object(sync, "capture", return_value=xml()), patch.object(sync, "adb") as adb, patch.object(sync.time, "sleep"):
            self.assertTrue(sync.recover_known_overlay("adb", "serial", root, lambda: None, events))
        adb.assert_called_once_with("adb", "serial", "shell", "input", "tap", "272", "2120", timeout=7)
        self.assertEqual(events, ["growth_center_deferred"])

    def test_unknown_dialog_is_not_touched(self):
        root = xml('<node package="android" text="确认" bounds="[10,20][110,80]" clickable="true"/>')
        with patch.object(sync, "focus", return_value="mCurrentFocus=unknown"), \
                patch.object(sync, "adb") as adb:
            self.assertFalse(sync.recover_known_overlay("adb", "serial", root, lambda: None, []))
        adb.assert_not_called()


if __name__ == "__main__":
    unittest.main()
