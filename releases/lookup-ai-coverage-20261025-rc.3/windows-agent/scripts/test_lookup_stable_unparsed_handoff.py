import copy
import json
from pathlib import Path
import unittest
from unittest import mock

import alipay_name_lookup as lookup
import alipay_visual_result as visual
from test_lookup_blank_card_guard import BlankCardGuardTests, PHONE, RESULT
from test_lookup_visual_result import row, card

FIXTURE = json.loads(Path(__file__).with_name('lookup-native-double-card.fixture.json').read_text())
ROWS, SIZE = FIXTURE['rows'], FIXTURE['size']


class StableUnparsedHandoffTests(unittest.TestCase):
    def fingerprint(self, rows):
        return visual.unparsed_person_section_fingerprint(rows, PHONE, SIZE)

    def test_native_zero_confidence_names_only_authorize_ai_handoff(self):
        self.assertIsNone(visual.parse_rows(ROWS, PHONE, SIZE))
        self.assertTrue(self.fingerprint(ROWS))
        self.assertEqual(self.fingerprint(ROWS), self.fingerprint(copy.deepcopy(ROWS)))

    def test_incomplete_loading_protected_and_wrong_number_never_shortcut(self):
        variants = [[], [row(PHONE, 330, 90)],
                    [r for r in ROWS if r[1] != '快捷功能'],
                    [r for r in ROWS if r[1] != '可能想找的人'],
                    [r for r in ROWS if r[1] != '加好友'],
                    [r for r in ROWS if '甲' not in r[1]],
                    ROWS + [row('搜索中', 387, 214)],
                    ROWS + [row('安全验证', 300, 600)],
                    ROWS + [row('操作频繁', 300, 600)],
                    [[box, '10987654321' if text == PHONE else text, score]
                     for box, text, score in ROWS],
                    [[box, text, .8 if text == '可能想找的人' else score]
                     for box, text, score in ROWS]]
        for rows in variants:
            with self.subTest(rows=rows):
                self.assertIsNone(self.fingerprint(rows))

    def run_frames(self, frames, setup=None):
        runner, poco = BlankCardGuardTests().fixture()
        runner.emit_query_result = mock.Mock()
        if setup:
            setup(runner)
        clock, count = [100.0], [0]
        def recognize(_raw, timeout=10):
            frame = frames[min(count[0], len(frames)-1)]
            count[0] += 1
            clock[0] += .3
            return frame, SIZE
        with mock.patch.object(visual, 'recognize', side_effect=recognize), \
             mock.patch.object(lookup.time, 'perf_counter', side_effect=lambda: clock[0]), \
             mock.patch.object(lookup.time, 'sleep', side_effect=lambda n: clock.__setitem__(0, clock[0]+n)):
            try:
                result = runner.poco_visual_result_readonly(poco, PHONE, 120)
                return runner, count[0], result, None
            except RuntimeError as error:
                return runner, count[0], None, str(error)

    def test_two_stable_frames_handoff_without_result_or_any_input(self):
        runner, count, result, error = self.run_frames([ROWS, ROWS])
        self.assertEqual(count, 2)
        self.assertEqual(error, 'local_lookup_result_unconfirmed:visual_card_not_proven')
        self.assertIsNone(result)
        runner.emit_query_result.assert_not_called()
        self.assertEqual(runner.adb.call_count, 2)  # fixture only permits screencap
        self.assertEqual(runner.focus.call_count, 4)  # each frame before/after

    def test_change_loading_and_blank_break_stability(self):
        changed = [[box, text.replace('甲', '乙'), score] for box, text, score in ROWS]
        for middle in [changed, ROWS + [row('搜索中', 387, 214)], [row(PHONE, 330, 90)]]:
            with self.subTest(middle=middle):
                _, count, _, error = self.run_frames([ROWS, middle, ROWS, ROWS])
                self.assertEqual(count, 4)
                self.assertEqual(error, 'local_lookup_result_unconfirmed:visual_card_not_proven')

    def test_valid_second_frame_keeps_native_two_frame_result(self):
        runner, count, result, error = self.run_frames([ROWS, card(), card()])
        self.assertIsNone(error)
        self.assertEqual(count, 3)
        self.assertEqual(result, RESULT)
        runner.emit_query_result.assert_called_once()

    def test_captcha_and_changed_input_keep_existing_errors(self):
        _, _, _, error = self.run_frames([ROWS, ROWS + [row('安全验证', 300, 600), row('拖动滑块完成拼图', 300, 700)]])
        self.assertIn('human_verification_required', error)
        def change_input(runner):
            good = runner.poco_nodes.return_value
            bad = mock.Mock(); bad.attr.return_value = '10987654321'
            runner.poco_nodes.side_effect = [good, good, [bad]]
        _, count, _, error = self.run_frames([ROWS], change_input)
        self.assertEqual(count, 1)
        self.assertIn('input_changed', error)


if __name__ == '__main__':
    unittest.main()
