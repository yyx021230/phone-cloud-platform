import unittest
from wecom_phone_registry import registry, device_label, summary


class RegistryTests(unittest.TestCase):
    def sheet(self, rows, name='新增企微号'):
        return registry([(name, [['电话号码', '企微登陆手机'], *rows])])

    def test_physical_device_is_not_assumed_to_be_main_or_row_order(self):
        result = self.sheet([['13800138001', '59'], ['13800138002', '59']])
        self.assertTrue(all(a['appSlot'] is None and not a['enabled'] for a in result['accounts']))
        self.assertEqual(summary(result)['slotProbeRequired'], 2)

    def test_explicit_clone_and_main_and_named_device(self):
        self.assertEqual(device_label('69企微2'), ('69', 'clone'))
        self.assertEqual(device_label('69微2'), ('69', 'clone'))
        self.assertEqual(device_label('69主号'), ('69', 'main'))
        self.assertEqual(device_label('珍珍138'), ('138', None))
        self.assertEqual(device_label('原59，已退出'), (None, None))

    def test_duplicate_phone_joins_sources_without_inventing_member_id(self):
        result = registry([('新增企微号', [['电话号码', '企微登陆手机'], ['13800138001', '157企微2']]),
                           ('广州云井个人企微帐号管理', [['号码1', '登陆手机'], ['13800138001', '157']])])
        account = result['accounts'][0]
        self.assertEqual(len(account['sources']), 2)
        self.assertEqual(account['appSlot'], 'clone')
        self.assertNotIn('wecom_userid', account)
        self.assertFalse(account['bindingVerified'])
        self.assertEqual(result['membersDraft'][0]['wecom_phone'], '13800138001')
        self.assertFalse(result['membersDraft'][0]['enabled'])

    def test_wrong_device_or_two_slots_or_same_sheet_duplicate_is_visible(self):
        account = self.sheet([['13800138001', '59主号'], ['13800138001', '59企微2'], ['13800138001', '23']])['accounts'][0]
        self.assertIn('phone_device_conflict', account['flags'])
        self.assertIn('phone_slot_conflict', account['flags'])
        self.assertIsNone(account['deviceNumber'])
        self.assertIsNone(account['appSlot'])
        self.assertEqual(self.sheet([['13800138001', '59主号'], ['13800138001', '59企微2']])['membersDraft'], [])

    def test_sim_card_column_is_never_used_and_repeated_headers_change_layout(self):
        result = registry([('新增企微号', [['电话号码', '手机卡编号'], ['13800138001', '59'],
                                           ['装卡手机', '电话号码', '企微登陆手机'], ['99', '13800138002', '23企微2']])])
        self.assertEqual(len(result['accounts']), 1)
        self.assertEqual(result['accounts'][0]['deviceNumber'], '23')

    def test_retired_sections_and_replacement_numbers_are_not_auto_enabled(self):
        result = registry([('优居帐号', [['原注册号码', '登陆手机', '待替换新号码'],
                                      ['13800138001', '59', '13800138002']])])
        self.assertEqual(len(result['accounts']), 1)
        self.assertIn('replacement_phone_requires_review', result['accounts'][0]['flags'])
        result = self.sheet([['以下装卡手机不方便使用，最好释放实名', ''], ['13800138001', '59企微2']])
        self.assertIn('source_restriction_requires_review', result['accounts'][0]['flags'])

    def test_partial_new_header_does_not_reuse_previous_login_column(self):
        result = self.sheet([['13800138001', '59企微2'], ['电话号码', '手机卡编号'], ['13800138002', '23']])
        self.assertEqual(len(result['accounts']), 1)
        self.assertEqual(result['accounts'][0]['deviceNumber'], '59')

    def test_multiple_numbers_and_same_physical_slot_are_not_first_match_wins(self):
        result = self.sheet([['13800138001\n13800138002', '59企微2']])
        for account in result['accounts']:
            self.assertIn('source_phone_ambiguous', account['flags'])
            self.assertIn('slot_multiple_accounts', account['flags'])
            self.assertFalse(account['enabled'])

    def test_unrelated_sheets_are_not_treated_as_wecom_accounts(self):
        result = registry([('支付宝登录明细', [['号码', '登陆手机'], ['13800138001', '59']])])
        self.assertEqual(result['accounts'], [])

    def test_summary_does_not_leak_phone_numbers(self):
        result = self.sheet([['13800138001', '59企微2']])
        self.assertNotIn('13800138001', str(summary(result)))


if __name__ == '__main__':
    unittest.main()
