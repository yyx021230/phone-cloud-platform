"""Real pages can pass through blank/network states before the card arrives."""
import unittest
import alipay_visual_result as visual
import test_lookup_loading_guard as fixtures
from test_lookup_visual_result import card, row, PHONE

LOADING, SIZE = fixtures.LOADING, fixtures.SIZE

BUSY = [row(PHONE, 330, 90), row("网络有点忙", 360, 459),
        row("刷新试试", 360, 511), row("刷新", 360, 594)]


class VisualPendingTests(unittest.TestCase):
    def run_frames(self, *args, **kwargs):
        original_setup=kwargs.pop("setup",None)
        def setup(r,poco):
            old=r.adb.side_effect
            def adb(args,**options):
                if args==["shell","input","tap","360","594"]:return ""
                return old(args,**options)
            r.adb.side_effect=adb
            if original_setup:original_setup(r,poco)
        return fixtures.LoadingGuardTests().run_frames(*args, setup=setup,**kwargs)

    def test_initial_incomplete_frame_waits_for_two_complete_cards(self):
        r, result, _ = self.run_frames([LOADING[:1], card(), card()])
        self.assertEqual(result["realNameTailCharacter"], "甲")
        self.assertEqual(r.adb.call_count, 3)  # screenshots only; no input/refresh

    def test_initial_incomplete_frame_expires_original_budget(self):
        with self.assertRaisesRegex(RuntimeError, "observation_budget_exhausted"):
            self.run_frames([LOADING[:1]], budget=3)

    def test_busy_then_two_cards_waits_without_refresh(self):
        r, result, _ = self.run_frames([BUSY, LOADING[:1], card(), card()])
        self.assertEqual(result["realNameTailCharacter"], "甲")
        self.assertEqual(r.adb.call_count, 4)

    def test_persistent_busy_has_explicit_failure_instead_of_no_name(self):
        with self.assertRaisesRegex(RuntimeError, "visual_network_busy"):
            self.run_frames([BUSY], budget=3)

    def test_busy_cannot_return_an_old_card_behind_it(self):
        with self.assertRaisesRegex(RuntimeError, "visual_network_busy"):
            self.run_frames([BUSY+card()[1:]], budget=3)

    def test_busy_cannot_hide_protection(self):
        with self.assertRaisesRegex(RuntimeError, "protected_visual_page"):
            self.run_frames([BUSY+[row("操作频繁", 300, 900)]])

    def test_busy_must_match_all_markers_input_confidence_and_position(self):
        self.assertTrue(visual.search_network_busy(BUSY, PHONE, SIZE))
        for rows in [BUSY[:-1], [row("10987654321", 330, 90)]+BUSY[1:],
                     BUSY[:1]+[row("网络有点忙", 360, 459, .89)]+BUSY[2:],
                     BUSY[:1]+[row("网络有点忙", 360, 1000)]+BUSY[2:],
                     BUSY[:1]+[row("网络有点忙呀", 360, 459)]+BUSY[2:]]:
            self.assertFalse(visual.search_network_busy(rows, PHONE, SIZE))

    def test_nonconsecutive_cards_still_cannot_be_joined(self):
        r,result,_=self.run_frames([card(),BUSY,card()])
        self.assertEqual(result["realNameTailCharacter"],"甲")
        self.assertEqual(r.adb.call_count,4) # two NEW cards; no stitching over busy frame

    def test_incomplete_wait_keeps_native_input_and_foreground_guards(self):
        def setup(r, poco):
            r.focus.side_effect = [r.focus.return_value, r.focus.return_value,
                                   ["mCurrentFocus=Window{x u0 other/app}"]]
        with self.assertRaisesRegex(RuntimeError, "foreground_changed"):
            self.run_frames([LOADING[:1], card()], setup=setup)


if __name__ == "__main__":
    unittest.main()
