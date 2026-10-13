"""Focused safety checks for the standalone Creator Center list collector."""

import importlib.util
import datetime as dt
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("小红书数据同步.py")
SPEC = importlib.util.spec_from_file_location("xhs_data_sync", SCRIPT)
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


def xml(*children):
    return ET.fromstring("<hierarchy>" + "".join(children) + "</hierarchy>")


class OverlayRecoveryTests(unittest.TestCase):
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
            '<node package="com.xingin.xhs" content-desc="稍后再看" clickable="true" bounds="[44,2060][501,2181]">'
            '<node package="com.xingin.xhs" text="稍后再看" bounds="[194,2096][350,2146]"/>'
            '</node>',
        )
        events = []
        with patch.object(sync, "focus", return_value="mCurrentFocus=com.xingin.xhs/XhsReactActivity"), \
                patch.object(sync, "adb") as adb, patch.object(sync.time, "sleep"):
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
