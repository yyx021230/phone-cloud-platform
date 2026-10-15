import unittest
from unittest import mock
import xml.etree.ElementTree as ET
from alipay_visual_result import parse_empty_rows
from test_lookup_visual_result import row, PHONE, card
import test_lookup_account_cooldown as cooldown
lookup = cooldown.lookup
import test_lookup_loading_guard as fixtures

SIZE = (720, 1612)
ROWS = [row(PHONE, 251, 105), row('快捷功能', 100, 321),
        row('手机充值：' + PHONE, 372, 432), row('大家都在搜', 115, 560, .938),
        row('查询快递', 120, 638), row('看账单记录', 462, 638),
        row('支付宝账号信息', 162, 726), row('查名字', 435, 726),
        row('用户信息', 120, 815), row('查询名字', 449, 815), row('自', 678, 1345)]


class GrayEmptyTests(unittest.TestCase):
    def test_real_layout_with_suggestions_is_empty(self):
        self.assertTrue(parse_empty_rows(ROWS, PHONE, SIZE)['notFound'])
        self.assertTrue(parse_empty_rows(ROWS[:-1], PHONE, SIZE)['notFound'])

    def test_other_two_observed_suggestion_orders(self):
        for labels in [('支付宝账号信息', '查询名字', '用户信息', '查名字', '账户信息', '查询快递'),
                       ('支付宝账号信息', '查询名字', '用户信息', '查名字', '查询快递', '账户信息')]:
            cells = [row(text, 160 if i % 2 == 0 else 450, 638 + i // 2 * 88)
                     for i, text in enumerate(labels)]
            self.assertTrue(parse_empty_rows(ROWS[:4] + cells + ROWS[-1:], PHONE, SIZE)['notFound'])

    def test_extra_card_risk_partial_misaligned_or_uncertain_is_not_empty(self):
        variants = [ROWS[:5], ROWS + card()[1:], ROWS + [row('网络有点忙', 300, 950)],
                    ROWS + [row('未知内容', 300, 950)], ROWS + [row('安全验证', 300, 950)],
                    ROWS[:3] + [row('大家都在搜', 115, 560, .8)] + ROWS[4:],
                    ROWS[:4] + [row('查询快递', 120, 638, .8)] + ROWS[5:],
                    ROWS[:5] + [row('看账单记录', 462, 750)] + ROWS[6:],
                    ROWS[:-1] + [row('自', 400, 1000)],
                    ROWS + [row('转账', 300, 1000)]]
        for rows in variants:
            with self.subTest(rows=rows):
                self.assertIsNone(parse_empty_rows(rows, PHONE, SIZE))

    def test_proof_and_two_frames_remain_mandatory(self):
        def setup(r, p): r.payload['preparedEmptyResult'] = True
        _, result, _ = fixtures.LoadingGuardTests().run_frames([ROWS, ROWS], setup=setup)
        self.assertTrue(result['notFound'])
        with self.assertRaisesRegex(RuntimeError, 'observation_budget_exhausted'):
            fixtures.LoadingGuardTests().run_frames([ROWS], budget=3)


CLOCK = ('', 'mCurrentFocus=Window{a u0 com.android.BBKClock/com.android.BBKClock.Timer type=1}',
         'mFocusedApp=ActivityRecord{a u0 com.android.BBKClock/.Timer}')
ALIPAY = ('', 'mCurrentFocus=Window{a u0 ' + lookup.ALIPAY_HOME + '}',
          'mFocusedApp=ActivityRecord{a u0 ' + lookup.ALIPAY_HOME + '}')


class GrayClockTests(unittest.TestCase):
    def runner(self, second=None):
        r = cooldown.AccountCooldownTests().runner()
        r.dump.side_effect = [RuntimeError('uiautomator_hierarchy_missing'),
                              (ET.Element('hierarchy'), {}) if second is None else second]
        r.focus_state = mock.Mock(side_effect=[CLOCK, ALIPAY])
        return r

    @mock.patch.object(lookup.time, 'sleep')
    def test_clock_missing_tree_brings_existing_app_without_force_stop(self, _):
        r = self.runner()
        self.assertTrue(r.prepare_available_account()['accountIdentityVerified'])
        r.adb.assert_called_once()
        args = r.adb.call_args.args[0]
        self.assertNotIn('force-stop', args)
        self.assertIn('0x10200000', args)
        self.assertEqual(r.dump.call_count, 2)

    @mock.patch.object(lookup.time, 'sleep')
    def test_restored_puzzle_never_force_stopped_or_account_switched(self, _):
        r = self.runner()
        r.verification_evidence = mock.Mock(return_value={'manual': True})
        with self.assertRaisesRegex(RuntimeError, 'human_verification_required'):
            r.prepare_available_account()
        r.launch.assert_not_called()
        r.open_account_picker.assert_not_called()
        r.switch_account.assert_not_called()

    def test_other_foreground_overlay_and_unknown_focus_do_not_relax_guard(self):
        for focus in [ALIPAY, ('', '', ''), ('', CLOCK[1], ALIPAY[2]),
                      ('', CLOCK[1].replace('com.android.BBKClock', 'com.other'), CLOCK[2])]:
            r = self.runner(); r.focus_state = mock.Mock(return_value=focus)
            with self.assertRaisesRegex(RuntimeError, 'hierarchy_missing'):
                r.prepare_available_account()
            r.adb.assert_not_called(); r.launch.assert_not_called()

    @mock.patch.object(lookup.time, 'sleep')
    def test_second_missing_tree_or_failed_foreground_stops(self, _):
        r = self.runner(RuntimeError('uiautomator_hierarchy_missing'))
        with self.assertRaisesRegex(RuntimeError, 'hierarchy_missing'):
            r.prepare_available_account()
        self.assertEqual(r.adb.call_count, 1); r.launch.assert_not_called()
        r = self.runner(); r.focus_state.side_effect = [CLOCK, CLOCK]
        with self.assertRaisesRegex(RuntimeError, 'foreground_unconfirmed'):
            r.prepare_available_account()
        r.launch.assert_not_called()

    def test_other_errors_are_not_a_clock_recovery(self):
        r = self.runner(); r.dump.side_effect = RuntimeError('device_not_online')
        with self.assertRaisesRegex(RuntimeError, 'device_not_online'):
            r.prepare_available_account()
        r.adb.assert_not_called()


if __name__ == '__main__':
    unittest.main()
