"""Sanitized result-card regressions; no ADB or account access."""
import importlib.util
import pathlib
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location(
    "lookup_name_formats", pathlib.Path(__file__).with_name("alipay_name_lookup.py"))
lookup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lookup)
PHONE = "10123456789"


class Node:
    def __init__(self, text, y):
        self.text = text
        self.y = y

    def attr(self, key):
        return {"text": self.text, "desc": "", "type": "android.widget.TextView"}.get(key, "")

    def get_position(self):
        return (0.4, self.y)


class Snapshot:
    def __init__(self, display, phone=PHONE, actions=True, name_y=0.25):
        self.nodes = [Node(display, name_y), Node(phone, 0.28)]
        if actions:
            self.nodes += [Node("转账", 0.32), Node("加好友", 0.32)]

    def __call__(self, **selector):
        return self.nodes if selector.get("type") == "android.widget.TextView" else []


class NameFormatTests(unittest.TestCase):
    def setUp(self):
        self.runner = lookup.Runner({"serial": "SYNTHETIC"})

    def test_poco_segmented_mask_keeps_exact_phone_and_action_proof(self):
        for display in ("示例·用户(***·*甲)", "示例用户（***·*甲）", "***·*甲", "示例用户(**甲)"):
            with self.subTest(display=display):
                result = self.runner.parse_poco_result(Snapshot(display), PHONE)
                self.assertIsNotNone(result)
                self.assertEqual(result["realNameTailCharacter"], "甲")
                self.assertEqual(result["alipayDisplayName"], display)
                self.assertEqual(result["matchedPhone"], PHONE)

    def test_xml_segmented_mask_uses_existing_card_association(self):
        for display in ("示例·用户(***·*甲)", "示例用户（***·*甲）", "***·*甲"):
            with self.subTest(display=display):
                root = ET.Element("hierarchy")
                card = ET.SubElement(root, "node")
                for text in (display, PHONE, "转账", "加好友"):
                    ET.SubElement(card, "node", text=text)
                result = self.runner.parse_result(root, {}, PHONE)
                self.assertIsNotNone(result)
                self.assertEqual(result["realNameTailCharacter"], "甲")
                self.assertIsNone(self.runner.parse_result(root, {}, "10987654321"))

    def test_segmented_mask_does_not_relax_poco_result_evidence(self):
        for snapshot in (Snapshot("示例用户(***·*甲)", phone="10987654321"),
                         Snapshot("示例用户(***·*甲)", actions=False),
                         Snapshot("示例用户(***·*甲)", name_y=0.05)):
            self.assertIsNone(self.runner.parse_poco_result(snapshot, PHONE))

    def test_plain_or_malformed_parenthetical_name_is_not_real_name_proof(self):
        for display in ("示例用户(甲)", "示例用户(***·甲乙)", "示例用户(***·公开甲)",
                        "示例用户(***·*甲)其他内容"):
            with self.subTest(display=display):
                self.assertIsNone(self.runner.parse_poco_result(Snapshot(display), PHONE))


if __name__ == "__main__":
    unittest.main()
