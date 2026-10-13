import sys
import unittest
from unittest import mock
import alipay_name_lookup as lookup
import alipay_visual_result as visual

PHONE = "10123456789"
RESULT = {"alipayDisplayName": "示例(**甲)", "realNameTailCharacter": "甲", "matchedPhone": PHONE,
          "notFound": False, "message": "", "matchMethod": "visual_ocr_exact_phone_actions_two_frames"}
SEARCH_FOCUS = ["mCurrentFocus=Window{fixture u0 com.eg.android.AlipayGphone/com.alipay.mobile.antui.basic.AUActivityMainSearchActivity}"]


class BlankCardGuardTests(unittest.TestCase):
    def test_blank_accessibility_cannot_be_returned_as_no_name(self):
        clock = [100.0]
        node = mock.Mock(); node.attr.side_effect = lambda k: PHONE if k == "text" else ""
        confirm = mock.Mock(); poco = mock.Mock()
        runner = lookup.Runner({"serial": "fixture"}); runner.emit = mock.Mock()
        runner.poco_search_ready = mock.Mock(return_value=node)
        runner.focused_search_input_length = mock.Mock(return_value=0)
        runner.poco_tap = mock.Mock(); runner.adb = mock.Mock()
        runner.wait_before_phone_input = mock.Mock(); runner.input_phone_humanized = mock.Mock()
        runner.poco_raise_if_account_restricted = mock.Mock()
        runner.poco_verification_evidence = mock.Mock(return_value=None)
        runner.poco_dismiss_post_input_usb_warning = mock.Mock(return_value=False)
        runner.parse_poco_result = mock.Mock(return_value=None)
        runner.poco_nodes = mock.Mock(side_effect=lambda s, **q: [confirm] if q.get("name", "").endswith("search_confirm") else [node])
        runner.poco_visual_result_readonly = mock.Mock(return_value=RESULT)
        with mock.patch.object(lookup.time, "time", side_effect=lambda: clock[0]), \
                mock.patch.object(lookup.time, "perf_counter", side_effect=lambda: clock[0]), \
                mock.patch.object(lookup.time, "sleep", side_effect=lambda n: clock.__setitem__(0, clock[0]+n)):
            result = runner.query_once_poco(poco, PHONE)
        self.assertEqual(result, RESULT)
        runner.poco_visual_result_readonly.assert_called_once()
        runner.input_phone_humanized.assert_called_once()
        self.assertEqual(sum(c.args[0] is confirm for c in runner.poco_tap.call_args_list), 1)

    def fixture(self):
        r = lookup.Runner({"serial": "fixture"}); r.emit = mock.Mock()
        r.focus = mock.Mock(return_value=SEARCH_FOCUS)
        node = mock.Mock(); node.attr.side_effect = lambda k: PHONE if k == "text" else ""
        r.poco_nodes = mock.Mock(return_value=[node])
        r.poco_raise_if_account_restricted = mock.Mock()
        r.poco_verification_evidence = mock.Mock(return_value=None)
        def adb(args, **kwargs):
            self.assertEqual(args, ["exec-out", "screencap", "-p"])
            self.assertTrue(kwargs["binary"])
            return b"synthetic screenshot"
        r.adb = mock.Mock(side_effect=adb)
        return r, mock.Mock()

    def test_two_frames_have_no_input_submit_restart_or_account_calls(self):
        r, poco = self.fixture()
        with mock.patch.object(visual, "recognize", return_value=([], (720, 1600))), \
                mock.patch.object(visual, "protection", return_value=""), \
                mock.patch.object(visual, "parse_rows", return_value=RESULT), \
                mock.patch.object(lookup.time, "sleep"):
            result = r.poco_visual_result_readonly(poco, PHONE, lookup.time.perf_counter()+30)
        self.assertEqual(result, RESULT)
        self.assertEqual(r.adb.call_count, 2)
        self.assertEqual(r.focus.call_count, 4)

    def test_changed_frame_or_missing_card_fails_instead_of_returning_empty(self):
        for values in [[RESULT, {**RESULT, "realNameTailCharacter": "乙"}], [None]]:
            r, poco = self.fixture()
            with mock.patch.object(visual, "recognize", return_value=([], (720, 1600))), \
                    mock.patch.object(visual, "protection", return_value=""), \
                    mock.patch.object(visual, "parse_rows", side_effect=values), \
                    mock.patch.object(lookup.time, "sleep"):
                with self.assertRaisesRegex(RuntimeError, "local_lookup_result_unconfirmed"):
                    r.poco_visual_result_readonly(poco, PHONE, lookup.time.perf_counter()+30)

    def test_captcha_is_human_and_never_returns_underlying_name(self):
        r, poco = self.fixture()
        with mock.patch.object(visual, "recognize", return_value=([], (720, 1600))), \
                mock.patch.object(visual, "protection", return_value="human"):
            with self.assertRaisesRegex(RuntimeError, "poco_alipay_human_verification_required"):
                r.poco_visual_result_readonly(poco, PHONE, lookup.time.perf_counter()+30)

    def test_missing_ocr_or_deadline_does_not_call_any_input(self):
        r, poco = self.fixture()
        with mock.patch.dict(sys.modules, {"alipay_visual_result": None}):
            with self.assertRaisesRegex(RuntimeError, "local_lookup_result_unconfirmed:ocr_dependency_unavailable"):
                r.poco_visual_result_readonly(poco, PHONE, lookup.time.perf_counter()+30)
        with self.assertRaisesRegex(RuntimeError, "observation_budget_exhausted"):
            r.poco_visual_result_readonly(poco, PHONE, lookup.time.perf_counter())
        r.adb.assert_not_called()


if __name__ == "__main__":
    unittest.main()
