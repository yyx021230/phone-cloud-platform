import unittest
import alipay_visual_result as visual
from test_lookup_visual_result import row, card, PHONE

TEXT = "abc*** @example.test("+PHONE+")"


def inline_row(*, score=.975, digit_score=.999, chars=None, scores=None, text=TEXT):
    values = [.94] * len(text) if scores is None else scores
    if scores is None:
        start = text.index(PHONE)
        values[start:start+11] = [digit_score] * 11
    return [row(text, 350, 440)[0], text, score, [],
            list(text) if chars is None else chars, values]


class PhoneCharacterConfidenceTests(unittest.TestCase):
    def test_email_average_does_not_hide_high_confidence_phone_digits(self):
        rows = visual._result_rows([inline_row()])
        self.assertAlmostEqual(rows[0][2], .999)
        result = visual.parse_rows(card()[:2]+rows+card()[3:], PHONE, (720, 1600))
        self.assertEqual(result["realNameTailCharacter"], "甲")

    def test_one_uncertain_digit_is_not_hidden_by_high_whole_row_average(self):
        value = inline_row(score=.999)
        value[5][TEXT.index(PHONE)+5] = .97
        rows = visual._result_rows([value])
        self.assertAlmostEqual(rows[0][2], .97)
        self.assertIsNone(visual.parse_rows(card()[:2]+rows+card()[3:], PHONE, (720, 1600)))

    def test_missing_or_misaligned_character_evidence_fails_closed(self):
        for value in [inline_row()[:3], inline_row(chars=[]), inline_row(scores=[]),
                      inline_row(chars=list(TEXT.replace("a", "b", 1)))]:
            self.assertEqual(visual._result_rows([value])[0][2], 0)

    def test_nonfinite_or_impossible_digit_scores_fail_closed(self):
        for score in [float("nan"), float("inf"), 1.1, -.1]:
            self.assertEqual(visual._result_rows([inline_row(digit_score=score)])[0][2], 0)

    def test_unreliable_full_structure_is_not_promoted(self):
        self.assertEqual(visual._result_rows([inline_row(score=.89)])[0][2], 0)

    def test_different_phone_still_cannot_match_original_query(self):
        rows = visual._result_rows([inline_row(text=TEXT.replace(PHONE, "10987654321"),
                                             scores=[.999]*len(TEXT))])
        self.assertIsNone(visual.parse_rows(card()[:2]+rows+card()[3:], PHONE, (720, 1600)))

    def test_name_input_and_action_confidences_are_unchanged(self):
        original = card()
        self.assertEqual(visual._result_rows(original), original)

    def test_low_name_score_remains_rejected(self):
        rows = visual._result_rows([inline_row()])
        original = card(); original[1] = row("示例(**甲)", 260, 390, .95)
        self.assertIsNone(visual.parse_rows(original[:2]+rows+original[3:], PHONE, (720, 1600)))

    def test_arbitrary_number_in_text_is_not_promoted(self):
        value = inline_row(text="备注："+TEXT, scores=[.999]*(len(TEXT)+3))
        self.assertAlmostEqual(visual._result_rows([value])[0][2], .975)

    def test_exact_threshold_applies_to_every_phone_digit(self):
        self.assertAlmostEqual(visual._result_rows([inline_row(digit_score=.98)])[0][2], .98)


if __name__ == "__main__":
    unittest.main()
