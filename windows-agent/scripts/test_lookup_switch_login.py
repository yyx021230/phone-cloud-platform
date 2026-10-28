"""Account-switch login classification; synthetic UI, no real account actions."""
import importlib.util
import pathlib
import unittest
import xml.etree.ElementTree as ET
from unittest import mock
spec = importlib.util.spec_from_file_location("switch_login", pathlib.Path(__file__).with_name("alipay_name_lookup.py"))
lookup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lookup)

class SwitchLoginTests(unittest.TestCase):
    def runner(self, current, underlying=""):
        r = lookup.Runner({"serial": "SYNTHETIC"})
        r.focus = mock.Mock(return_value=["mCurrentFocus=null", "mCurrentFocus=" + current, "mFocusedApp=" + underlying])
        root = ET.Element("hierarchy")
        ET.SubElement(root, "node", text="我的")
        r.dump = mock.Mock(return_value=(root, {}))
        r.adb = mock.Mock(side_effect=AssertionError("No device action allowed"))
        r.emit = mock.Mock()
        r.account_switched = True
        r.account_identity_verified = False
        r.current_account_after_switch = "SYNTHETIC_B"
        r.account_switch_history = [{"fromAccount": "SYNTHETIC_A", "toAccount": "SYNTHETIC_B", "reason": "cooldown"}]
        return r

    def test_exact_login_after_selection_fails_before_dump_or_any_input(self):
        r = self.runner(lookup.ALIPAY_LOGIN_ACTIVITY)
        with self.assertRaisesRegex(RuntimeError, "^poco_alipay_login_required$"):
            r.wait_unique("account-switch-returned-home", timeout=1, text="我的")
        r.dump.assert_not_called()
        r.adb.assert_not_called()
        self.assertTrue(r.account_switched)
        self.assertFalse(r.account_identity_verified)
        self.assertEqual(r.current_account_after_switch, "SYNTHETIC_B")
        self.assertEqual(len(r.account_switch_history), 1)
        r.emit.assert_called_once()

    def test_real_home_returns_exact_node(self):
        r = self.runner(lookup.ALIPAY_PACKAGE + "/.AlipayLogin")
        self.assertEqual(r.wait_unique("account-switch-returned-home", text="我的")[2].get("text"), "我的")
        r.dump.assert_called_once()
        r.adb.assert_not_called()

    def test_underlying_old_login_does_not_override_current_home(self):
        r = self.runner(lookup.ALIPAY_PACKAGE + "/.AlipayLogin", lookup.ALIPAY_LOGIN_ACTIVITY)
        r.wait_unique("account-switch-returned-home", text="我的")
        r.dump.assert_called_once()

    def test_other_xml_navigation_is_unchanged(self):
        r = self.runner(lookup.ALIPAY_LOGIN_ACTIVITY)
        r.wait_unique("unrelated-navigation", text="我的")
        r.focus.assert_not_called()
        r.dump.assert_called_once()

    def test_other_package_login_is_not_alipay_login_evidence(self):
        r = self.runner("com.example.other/.LoginActivity")
        # Neither an Alipay login nor proof of returning to Alipay Home.
        with self.assertRaisesRegex(RuntimeError, "^selector_missing:"):
            r.wait_unique("account-switch-returned-home", timeout=.01, text="我的")
        r.dump.assert_called_once()
        r.adb.assert_not_called()

if __name__ == "__main__":
    unittest.main()
