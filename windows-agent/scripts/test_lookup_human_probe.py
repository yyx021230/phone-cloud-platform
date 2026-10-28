"""Synthetic read-only observation tests: never connect to ADB or a phone."""
import importlib.util
import pathlib
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("lookup_human_probe_test", pathlib.Path(__file__).with_name("alipay_name_lookup.py"))
lookup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lookup)


class HumanProbeTests(unittest.TestCase):
    def probe(self, texts=(), inputs=1, enabled=True, visible=True, webview=False, focus=None, freeze_error=False):
        runner = lookup.Runner({"serial": "SYNTHETIC", "operation": "human_probe"})
        node = mock.Mock()
        node.attr.side_effect = lambda key: enabled if key == "enabled" else visible
        runner.poco_snapshot_texts = mock.Mock(return_value=list(texts))
        runner.poco_nodes = mock.Mock(side_effect=lambda _snapshot, **selector: [node] * inputs if selector.get("name") else [node] if webview else [])
        runner.focus = mock.Mock(return_value=focus if focus is not None else ["mCurrentFocus=Window{a com.eg.android.AlipayGphone/.SearchActivity}"])
        runner.adb = mock.Mock(side_effect=AssertionError("observer must not run an input or launch command"))
        runner.poco_tap = mock.Mock(side_effect=AssertionError("observer must not tap"))
        runner.poco_search_ready = mock.Mock(side_effect=AssertionError("observer must not navigate"))
        poco = mock.Mock()
        if freeze_error:
            poco.freeze.side_effect = RuntimeError("synthetic hierarchy timeout")
        result = runner.run_poco(poco)
        runner.adb.assert_not_called()
        runner.poco_tap.assert_not_called()
        runner.poco_search_ready.assert_not_called()
        self.assertEqual(set(result), {"ok", "operation", "verificationState"})
        self.assertEqual(runner.log, [])
        return result["verificationState"]

    def test_positive_read_only_search_page(self):
        self.assertEqual(self.probe(), "search_ready")

    def test_virtual_display_null_focus_with_unique_alipay_window_is_ready(self):
        self.assertEqual(self.probe(focus=["mCurrentFocus=null",
                         "mCurrentFocus=Window{a com.eg.android.AlipayGphone/.SearchActivity}"]), "search_ready")
        self.assertEqual(self.probe(focus=["  mCurrentFocus = null  ",
                         "mCurrentFocus=Window{a u0 com.eg.android.AlipayGphone/.SearchActivity}"]), "search_ready")
        self.assertEqual(self.probe(focus=["mCurrentFocus=null",
                         "mCurrentFocus=Window{a u0 com.eg.android.AlipayGphone/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity type=1}"]), "search_ready")

    def test_null_only_ambiguous_malformed_or_non_exact_focus_is_unknown(self):
        focus = "mCurrentFocus=Window{a com.eg.android.AlipayGphone/.SearchActivity}"
        for lines in (["mCurrentFocus=null"], ["mCurrentFocus=null", "mCurrentFocus=null"],
                      [focus, focus], [focus, "mCurrentFocus=Window{b other/app}"],
                      [focus, "mCurrentFocus=unknown"], [focus, "mCurrentFocus=null trailing-data"],
                      ["mCurrentFocus=Window{a prefix.com.eg.android.AlipayGphone/.SearchActivity}"],
                      ["mCurrentFocus=Window{a other/app com.eg.android.AlipayGphone/.SearchActivity} trailing-data"],
                      ["mCurrentFocus=com.eg.android.AlipayGphone/.SearchActivity"],
                      ["mCurrentFocus=Window{a u0 com.eg.android.AlipayGphone/.SearchActivity type=other/app}"]):
            with self.subTest(lines=lines):
                self.assertEqual(self.probe(focus=lines), "unknown")

    def test_captcha_stays_present_even_with_search_input(self):
        for text in (lookup.VERIFICATION_TITLE, lookup.JIGSAW_VERIFICATION_ACTION,
                     lookup.VERIFICATION_ACTION):
            with self.subTest(text=text):
                self.assertEqual(self.probe(texts=[text]), "present")

    def test_missing_duplicate_disabled_hidden_input_and_other_app_are_unknown(self):
        for kwargs in ({"inputs": 0}, {"inputs": 2}, {"enabled": False}, {"visible": False}, {"webview": True}, {"freeze_error": True},
                       {"texts": ["访问被拒绝"]}, {"texts": ["短信验证码登录"]},
                       {"texts": [lookup.FREQUENT_OR_ABNORMAL_ACCESS_TITLE, "反馈码: synthetic"]},
                       {"texts": ["反馈码: synthetic"]},
                       {"focus": []}, {"focus": ["mCurrentFocus=Window{other/app}"]}):
            with self.subTest(kwargs=kwargs):
                self.assertEqual(self.probe(**kwargs), "unknown")

    def test_foreground_change_during_read_stays_unknown(self):
        runner = lookup.Runner({"serial": "SYNTHETIC", "operation": "human_probe"})
        runner.focus = mock.Mock(side_effect=[["mCurrentFocus=com.eg.android.AlipayGphone/.Search"], ["mCurrentFocus=other/app"]])
        runner.poco_snapshot_texts = mock.Mock(return_value=[])
        node = mock.Mock(); node.attr.return_value = True
        runner.poco_nodes = mock.Mock(side_effect=lambda _snapshot, **selector: [node] if selector.get("name") else [])
        runner.adb = mock.Mock(side_effect=AssertionError("no ADB mutations"))
        self.assertEqual(runner.run_poco(mock.Mock())["verificationState"], "unknown")


if __name__ == "__main__":
    unittest.main()
