import unittest
import alipay_visual_result as visual
import test_lookup_loading_guard as fixtures
from test_lookup_visual_result import row, card, PHONE


class LoadingAnimationTests(unittest.TestCase):
    def test_animated_dot_frame_waits_for_two_complete_cards(self):
        loading = [row(PHONE, 330, 90), row("搜索中·", 349, 214, .871712)]
        r, result, _ = fixtures.LoadingGuardTests().run_frames([loading, card(), card()])
        self.assertEqual(result, fixtures.RESULT)
        self.assertEqual(r.adb.call_count, 3)

    def test_only_bounded_animation_suffix_is_accepted(self):
        for text in ["搜索中·", "搜索中...", "搜索中…", "搜索中···"]:
            with self.subTest(text=text):
                self.assertTrue(visual.search_loading([row(PHONE, 330, 90), row(text, 349, 214, .87)], PHONE, fixtures.SIZE))
        for text, score in [("搜索中·", .84), ("搜索中断", .99), ("搜索中正在查", .99), ("搜索中", .89)]:
            with self.subTest(text=text):
                self.assertFalse(visual.search_loading([row(PHONE, 330, 90), row(text, 349, 214, score)], PHONE, fixtures.SIZE))

    def test_animation_never_overrides_phone_or_protection(self):
        loading = [row("10987654321", 330, 90), row("搜索中·", 349, 214, .87)]
        self.assertFalse(visual.search_loading(loading, PHONE, fixtures.SIZE))
        loading[0] = row(PHONE, 330, 90)
        self.assertFalse(visual.search_loading(loading+[row("安全验证", 300, 600)], PHONE, fixtures.SIZE))


if __name__ == "__main__":
    unittest.main()
