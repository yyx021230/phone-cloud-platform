import unittest

from alipay_visual_result import parse_rows
import test_lookup_loading_guard as frames

PHONE = "10123456789"
SIZE = (720, 1612)


def row(text, x, y, score=.999):
    return ([[x-20, y-12], [x+20, y-12], [x+20, y+12], [x-20, y+12]], text, score)


def card(account=None):
    return [row(PHONE, 255, 104), row("示例(**甲)", 217, 410, .986),
            row(account or f"abc***@alipay.tech({PHONE})", 354, 449, .991),
            row("转账", 204, 515, .996), row("加好友", 491, 515, .997)]


class InlineAccountPhoneTests(unittest.TestCase):
    def test_email_and_exact_phone_share_one_ocr_row(self):
        result = parse_rows(card(), PHONE, SIZE)
        self.assertIsNotNone(result)
        self.assertEqual(result["realNameTailCharacter"], "甲")
        self.assertEqual(result["matchedPhone"], PHONE)
        self.assertFalse(result["notFound"])

    def test_fullwidth_brackets_and_other_email_domains(self):
        result = parse_rows(card(f"a.***+b@example.test（{PHONE}）"), PHONE, SIZE)
        self.assertIsNotNone(result)

    def test_arbitrary_labels_and_ambiguous_phone_strings_are_rejected(self):
        for account in [f"手机充值({PHONE})", f"转账: {PHONE}",
                        f"abc***@alipay.tech({PHONE}0)",
                        f"abc***@alipay.tech(10987654321)",
                        f"abc***@alipay.tech({PHONE})10987654321",
                        f"abc***@alipay.tech({PHONE}",
                        f"abc***@alipay.tech[{PHONE}]", f"({PHONE})"]:
            with self.subTest(account=account):
                self.assertIsNone(parse_rows(card(account), PHONE, SIZE))

    def test_input_low_confidence_missing_actions_and_protection_stay_strict(self):
        variants = []
        rows = card(); rows[0] = row("10987654321", 255, 104); variants.append(rows)
        rows = card(); rows[2] = row(f"abc***@alipay.tech({PHONE})", 354, 449, .97); variants.append(rows)
        variants.extend([card()[:-1], card()+[row("操作频繁或访问异常", 360, 700)],
                         card()+[row("安全验证", 360, 700), row("拖动滑块完成拼图", 360, 800)]])
        for rows in variants:
            with self.subTest(rows=rows):
                self.assertIsNone(parse_rows(rows, PHONE, SIZE))

    def test_duplicate_cards_or_unrelated_account_row_are_rejected(self):
        self.assertIsNone(parse_rows(card()+card()[1:], PHONE, SIZE))
        rows = card(); rows[2] = row(f"abc***@alipay.tech({PHONE})", 354, 850)
        self.assertIsNone(parse_rows(rows, PHONE, SIZE))

    def test_explicit_not_real_named_retains_its_status(self):
        rows = card(); rows[1] = row("101****89(未实名)", 217, 410)
        result = parse_rows(rows, PHONE, SIZE)
        self.assertIsNotNone(result)
        self.assertTrue(result["notFound"])
        self.assertEqual(result["message"], "account_not_real_named")

    def test_runner_requires_two_complete_inline_cards(self):
        runner, result, _ = frames.LoadingGuardTests().run_frames([card(), card()])
        self.assertEqual(result["realNameTailCharacter"], "甲")
        self.assertEqual(runner.adb.call_count, 2)

    def test_runner_rejects_a_missing_second_inline_card(self):
        with self.assertRaisesRegex(RuntimeError, "visual_card_not_proven"):
            frames.LoadingGuardTests().run_frames([card(), card()[:1]])


if __name__ == "__main__":
    unittest.main()
