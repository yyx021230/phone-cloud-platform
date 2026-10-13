import unittest
from alipay_visual_result import parse_rows, protection

PHONE = "10123456789"


def row(text, x, y, confidence=.999):
    return ([[x-20, y-12], [x+20, y-12], [x+20, y+12], [x-20, y+12]], text, confidence)


def card(phone=PHONE, display="示例(**甲)"):
    return [row(phone, 330, 90), row(display, 260, 390), row(phone, 260, 440),
            row("转账", 220, 500), row("加好友", 530, 500)]


class VisualResultTests(unittest.TestCase):
    def test_hidden_result_card_can_be_read_without_taking_input_as_result(self):
        result = parse_rows(card(), PHONE, (720, 1600))
        self.assertEqual(result["realNameTailCharacter"], "甲")
        self.assertFalse(result["notFound"])

    def test_wrong_phone_missing_actions_or_only_input_are_rejected(self):
        for rows in [card(phone="10987654321"), card()[:-1], [row(PHONE, 330, 90)]]:
            self.assertIsNone(parse_rows(rows, PHONE, (720, 1600)))

    def test_low_confidence_and_plain_nickname_are_not_guessed(self):
        rows = card(); rows[1] = row("示例(**甲)", 260, 390, .90)
        self.assertIsNone(parse_rows(rows, PHONE, (720, 1600)))
        self.assertIsNone(parse_rows(card(display="示例甲"), PHONE, (720, 1600)))
        self.assertIsNone(parse_rows(card(display="示例(***)"), PHONE, (720, 1600)))

    def test_protected_page_never_uses_name_visible_behind_overlay(self):
        rows = card() + [row("安全验证", 320, 680), row("拖动滑块完成拼图", 320, 740)]
        self.assertEqual(protection(rows, (720, 1600)), "human")
        self.assertIsNone(parse_rows(rows, PHONE, (720, 1600)))
        self.assertIsNone(parse_rows(card()+[row("操作频繁或访问异常", 320, 680)], PHONE, (720, 1600)))

    def test_duplicate_cards_or_unrelated_actions_are_ambiguous(self):
        self.assertIsNone(parse_rows(card()+card()[1:], PHONE, (720, 1600)))
        rows = card()[:3]+[row("转账", 220, 1100), row("加好友", 530, 1100)]
        self.assertIsNone(parse_rows(rows, PHONE, (720, 1600)))

    def test_old_result_with_a_different_search_input_is_rejected(self):
        rows = card(); rows[0] = row("10987654321", 330, 90)
        self.assertIsNone(parse_rows(rows, PHONE, (720, 1600)))

    def test_verified_unregistered_mask_retains_its_distinct_semantics(self):
        result = parse_rows(card(display="101****89(未实名)"), PHONE, (720, 1600))
        self.assertTrue(result["notFound"])
        self.assertEqual(result["message"], "account_not_real_named")


if __name__ == "__main__":
    unittest.main()
