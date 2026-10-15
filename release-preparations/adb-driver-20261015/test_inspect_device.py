import copy
import unittest
from inspect_device import choose_adb_driver

class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.adb = {'provider': 'Microsoft', 'inf': r'C:\Windows\INF\winusb.inf', 'section': 'ADB',
                    'hardwareId': r'USB\Class_ff&SubClass_42&Prot_01'}
    def test_prefers_adb_section_over_generic_or_oem(self):
        oem = dict(self.adb, inf=r'C:\Windows\INF\oem44.inf', provider='vivo, Inc.')
        generic = dict(self.adb, section='WINUSB', hardwareId=r'USB\MS_COMP_WINUSB')
        self.assertEqual(choose_adb_driver([oem, generic, self.adb]), self.adb)
    def test_fails_closed_on_no_or_ambiguous_candidate(self):
        for rows in [[], [self.adb, copy.deepcopy(self.adb)]]:
            with self.assertRaises(ValueError): choose_adb_driver(rows)
    def test_rejects_wrong_inf_provider_section_or_interface(self):
        for field, value in [('inf', r'D:\temp\winusb.inf'), ('provider', 'Vendor'),
                             ('section', 'WINUSB'), ('hardwareId', r'USB\Class_09')]:
            with self.assertRaises(ValueError): choose_adb_driver([dict(self.adb, **{field: value})])

if __name__ == '__main__': unittest.main()
