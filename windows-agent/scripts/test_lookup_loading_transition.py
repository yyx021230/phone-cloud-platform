import unittest
import test_lookup_loading_guard as fixtures
from test_lookup_visual_result import card


class LoadingTransitionTests(unittest.TestCase):
    def test_proven_loading_may_transition_through_blank_before_two_cards(self):
        r, result, _ = fixtures.LoadingGuardTests().run_frames([
            fixtures.LOADING, fixtures.LOADING[:1], card(), card()])
        self.assertEqual(result, fixtures.RESULT)
        self.assertEqual(r.adb.call_count, 4)

    def test_proven_loading_then_unknown_expires_without_guessing(self):
        with self.assertRaisesRegex(RuntimeError, "observation_budget_exhausted"):
            fixtures.LoadingGuardTests().run_frames([fixtures.LOADING, fixtures.LOADING[:1]], budget=4)


if __name__ == "__main__":
    unittest.main()
