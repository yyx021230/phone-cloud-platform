import unittest
import xml.etree.ElementTree as ET
from alipay_name_lookup import Runner, ACCOUNT_ID, ACCOUNT_CURRENT_ID


class SavedAccountActionRowsTest(unittest.TestCase):
    def rows(self, label="登录其他账号", action_container=True):
        root = ET.Element("hierarchy")
        for index, account in enumerate(["fixture-current", "fixture-next", label]):
            container = ET.SubElement(root, "node", {"resource-id":
                "com.alipay.mobile.securitybiz:id/ll_switch_layout" if index == 2 and action_container
                else "com.alipay.mobile.securitybiz:id/layout_container"})
            ET.SubElement(container, "node", {"resource-id": ACCOUNT_ID,
                "text": account, "bounds": "[40,100][640,160]"})
            if index == 0:
                ET.SubElement(container, "node", {"resource-id": ACCOUNT_CURRENT_ID, "text": "当前"})
        return Runner({"serial": "fixture"}).account_picker_rows(root, {c: p for p in root.iter() for c in p})

    def test_same_resource_login_other_is_not_a_saved_account(self):
        rows = self.rows()
        self.assertEqual([r[0] for r in rows], ["fixture-current", "fixture-next"])
        self.assertEqual(Runner.rotation_account_rows(rows)[1][0], "fixture-next")
        self.assertEqual(len(Runner.saved_account_choices(rows)), 2)

    def test_exact_action_label_is_excluded_without_action_container(self):
        self.assertEqual(len(self.rows(action_container=False)), 2)
        self.assertEqual(len(self.rows("登录其他账户", action_container=False)), 2)

    def test_action_container_is_excluded_even_if_text_changes(self):
        self.assertEqual(len(self.rows("fixture-navigation-action")), 2)

    def test_email_or_non_numeric_saved_label_is_preserved(self):
        self.assertEqual(len(self.rows("fixture@invalid.example", action_container=False)), 3)


if __name__ == "__main__":
    unittest.main()
