import importlib.util
from pathlib import Path
import unittest
from xml.etree import ElementTree as ET

RELEASE = Path(__file__).resolve().parent
FIXTURE = RELEASE.parents[1] / 'windows-agent/scripts/fixtures/xhs/works-elements-141.xml'
STATUS = '该笔记已被限制推荐和搜索展示，但广告投放和蒲公英流量不受影响。'
spec = importlib.util.spec_from_file_location('candidate', (Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class RestrictedRecommendationTests(unittest.TestCase):
    def setUp(self):
        self.root = ET.parse(FIXTURE).getroot()
        cards = sync.note_cards(self.root)
        self.expected = [item for _, item in cards]
        self.row, first = cards[0]
        self.status_node, = [node for node in self.row.iter('node')
                             if node.get('text') == first['status_raw']]

    def test_exact_status_preserves_the_full_row_and_order(self):
        self.status_node.set('text', STATUS)
        self.expected[0] = dict(self.expected[0], status_raw=STATUS)
        self.assertEqual([item for _, item in sync.note_cards(self.root)], self.expected)
        self.assertEqual(len(sync.element_page_signature(self.root)[0]), len(self.expected))

    def test_unknown_status_still_rejects_the_full_page(self):
        self.status_node.set('text', STATUS.removesuffix('。'))
        with self.assertRaisesRegex(sync.ElementListReadError, 'incomplete status/title/metrics'):
            sync.element_page_signature(self.root)

    def test_exact_status_with_missing_metric_still_rejects_the_full_page(self):
        self.status_node.set('text', STATUS)
        metric = next(node for node in self.row.iter('node')
                      if (node.get('text') or '').isdigit())
        metric.set('text', '')
        with self.assertRaisesRegex(sync.ElementListReadError, 'incomplete title/date/metrics'):
            sync.element_page_signature(self.root)


if __name__ == '__main__':
    unittest.main()
