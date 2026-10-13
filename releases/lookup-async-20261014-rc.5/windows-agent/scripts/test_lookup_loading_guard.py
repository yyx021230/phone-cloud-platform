"""Slow result pages must wait without repeating the submitted query."""
import unittest
from unittest import mock
import alipay_name_lookup as lookup
import alipay_visual_result as visual
from test_lookup_blank_card_guard import BlankCardGuardTests, PHONE, RESULT
from test_lookup_visual_result import row, card

SIZE = (720, 1600)
LOADING = [row(PHONE, 330, 90), row("搜索中", 387, 214)]


class LoadingGuardTests(unittest.TestCase):
    def fixture(self):
        return BlankCardGuardTests().fixture()

    def run_frames(self, frames, *, budget=12, setup=None):
        r, poco = self.fixture()
        r.emit_query_result = mock.Mock()
        if setup:
            setup(r, poco)
        clock = [100.0]
        index = [0]
        def recognize(_raw):
            value = frames[min(index[0], len(frames)-1)]
            index[0] += 1
            clock[0] += .2
            return value, SIZE
        with mock.patch.object(visual, "recognize", side_effect=recognize), \
                mock.patch.object(lookup.time, "perf_counter", side_effect=lambda: clock[0]), \
                mock.patch.object(lookup.time, "sleep", side_effect=lambda n: clock.__setitem__(0, clock[0]+n)):
            result = r.poco_visual_result_readonly(poco, PHONE, 100+budget)
        return r, result, clock[0]

    def test_loading_then_two_complete_cards_no_extra_input(self):
        r, result, _ = self.run_frames([LOADING, LOADING, card(), card()])
        self.assertEqual(result, RESULT)
        self.assertEqual(r.adb.call_count, 4)  # fixture permits screenshots only
        self.assertEqual(r.focus.call_count, 8)
        r.emit_query_result.assert_called_once_with(RESULT, driver="poco_visual_readonly")

    def test_loading_expires_original_budget_without_empty_result(self):
        with self.assertRaisesRegex(RuntimeError, "observation_budget_exhausted"):
            self.run_frames([LOADING], budget=3)

    def test_loading_cannot_hide_captcha_or_restriction(self):
        for extra, error in [([row("安全验证", 300, 600), row("拖动滑块完成拼图", 300, 700)], "human_verification_required"),
                             ([row("操作频繁", 300, 600)], "protected_visual_page")]:
            with self.assertRaisesRegex(RuntimeError, error):
                self.run_frames([LOADING, LOADING+extra])

    def test_changed_input_after_loading_is_not_retried(self):
        def setup(r, poco):
            node = mock.Mock(); node.attr.return_value = "10987654321"
            good = r.poco_nodes.return_value
            r.poco_nodes.side_effect = [good, good, [node]]
        with self.assertRaisesRegex(RuntimeError, "input_changed"):
            self.run_frames([LOADING, card()], setup=setup)

    def test_loading_foreground_change_is_not_recovered(self):
        def setup(r, poco):
            good = r.focus.return_value
            r.focus.side_effect = [good, good, ["mCurrentFocus=Window{x u0 other/app}"]]
        with self.assertRaisesRegex(RuntimeError, "foreground_changed"):
            self.run_frames([LOADING, card()], setup=setup)

    def test_loading_must_not_stitch_nonconsecutive_result_frames(self):
        with self.assertRaisesRegex(RuntimeError, "visual_card_not_proven"):
            self.run_frames([card(), LOADING, card()])

    def test_loading_with_old_card_cannot_return_that_card(self):
        with self.assertRaisesRegex(RuntimeError, "observation_budget_exhausted"):
            self.run_frames([LOADING+card()[1:]], budget=3)

    def test_blank_without_loading_remains_unconfirmed(self):
        with self.assertRaisesRegex(RuntimeError, "visual_card_not_proven"):
            self.run_frames([LOADING[:1]])

    def test_only_exact_loading_in_expected_region_and_input_can_wait(self):
        for rows in [LOADING[:-1]+[row("搜索中", 387, 214, .89)],
                     LOADING[:-1]+[row("搜索中", 387, 1000)],
                     [row("10987654321", 330, 90), LOADING[-1]],
                     LOADING[:-1]+[row("搜索中断", 387, 214)]]:
            with self.subTest(rows=rows), self.assertRaisesRegex(RuntimeError, "visual_card_not_proven"):
                self.run_frames([rows])


if __name__ == "__main__":
    unittest.main()
