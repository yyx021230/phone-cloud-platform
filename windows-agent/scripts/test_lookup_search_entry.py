import importlib.util
from pathlib import Path
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location("lookup_entry", Path(__file__).with_name("alipay_name_lookup.py"))
lookup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lookup)


class SearchEntryTests(unittest.TestCase):
    def runner(self):
        r = lookup.Runner({"serial": "SYNTHETIC", "operation": "start"})
        r.adb = mock.Mock()
        r.emit = mock.Mock()
        r.dismiss_known_overlay = mock.Mock(return_value=False)
        home = ET.Element("node", {"package": lookup.ALIPAY_PACKAGE,
            "content-desc": "搜索框", "bounds": "[0,0][100,100]", "clickable": "true"})
        r.wait_unique = mock.Mock(return_value=(home, {}, home))
        r.focus_state = mock.Mock(return_value=([],
            f"mCurrentFocus=Window{{ {lookup.ALIPAY_PACKAGE}/.AlipayLogin }}", ""))
        return r

    def test_browser_search_box_is_not_an_alipay_selector(self):
        root = ET.fromstring('<hierarchy><node package="com.vivo.browser" content-desc="搜索框"/>'
            '<node package="com.eg.android.AlipayGphone" content-desc="搜索框"/></hierarchy>')
        self.assertEqual(len(lookup.Runner.find(root, desc="搜索框", package=lookup.ALIPAY_PACKAGE)), 1)

    def test_concrete_foreign_window_blocks_stale_home_coordinates(self):
        for current in ["mCurrentFocus=Window{ com.vivo.browser/.Main }",
                        "mCurrentFocus=Window{ com.android.permissioncontroller/.GrantPermissionsActivity }"]:
            r = self.runner()
            r.focus_state.return_value = ([], current, f"mFocusedApp={lookup.ALIPAY_PACKAGE}/.AlipayLogin")
            with self.assertRaisesRegex(RuntimeError, "alipay_search_entry_foreground_changed"):
                r.open_search("test")
            r.adb.assert_not_called()

    def test_unknown_focus_does_not_allow_input(self):
        r = self.runner()
        r.focus_state.return_value = ([], "mCurrentFocus=null", "mFocusedApp=null")
        with self.assertRaisesRegex(RuntimeError, "alipay_search_entry_foreground_changed"):
            r.open_search("test")
        r.adb.assert_not_called()

    def test_search_entry_and_result_require_package_and_final_search_focus(self):
        r = self.runner()
        r.focus_state.side_effect = [r.focus_state.return_value, ([],
            f"mCurrentFocus=Window{{ {lookup.ALIPAY_PACKAGE}/.MainSearchActivity }}", "")]
        with mock.patch.object(lookup.time, "sleep"):
            r.open_search("test")
        self.assertEqual(r.adb.call_count, 1)
        for call in r.wait_unique.call_args_list:
            self.assertEqual(call.kwargs["package"], lookup.ALIPAY_PACKAGE)

    def test_foreground_change_after_tap_is_not_search_ready(self):
        r = self.runner()
        r.focus_state.side_effect = [r.focus_state.return_value, ([], "mCurrentFocus=Window{ com.vivo.browser/.Main }", "")]
        with mock.patch.object(lookup.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "alipay_search_entry_foreground_changed"):
                r.open_search("test")
        self.assertEqual(r.adb.call_count, 1)


if __name__ == "__main__":
    unittest.main()
