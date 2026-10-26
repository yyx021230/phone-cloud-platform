"""Bound repeated XML work without caching data across snapshots; no devices."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

S = Path(__file__).parent
spec = importlib.util.spec_from_file_location('parse_perf_sync', os.environ.get('XHS_PARSE_BASELINE', S/'小红书数据同步.py'))
sync = importlib.util.module_from_spec(spec); spec.loader.exec_module(sync)


class ParsePerformanceTests(unittest.TestCase):
    def fixture(self):
        return ET.parse(S/'fixtures/xhs/works-elements-141.xml').getroot()

    def test_visibility_scan_parses_each_coordinate_once(self):
        root = ET.Element('hierarchy')
        for i in range(1000):
            ET.SubElement(root, 'node', {'bounds': '[0,0][100,100]' if i % 2 else '[0,0][0,0]'})
        with patch.object(sync, 'bounds', wraps=sync.bounds) as parse:
            self.assertEqual(len(sync.live_nodes(root)), 500)
        self.assertLessEqual(parse.call_count, 1000)

    def test_structured_rows_do_not_walk_the_whole_tree_for_every_child(self):
        root = self.fixture()
        with patch.object(sync, 'live_nodes', wraps=sync.live_nodes) as scan:
            cards = sync.structured_note_cards(root)
        self.assertEqual(len(cards), 5)
        self.assertLessEqual(scan.call_count, 2)
        self.assertEqual([r['list_view_count'] for _, r in cards], [252, 136, 37, 638, 105])

    def test_changed_values_and_geometry_are_read_again_on_next_call(self):
        root = self.fixture()
        first = sync.element_page_signature(root)
        node = next(n for n in root.iter('node') if n.get('text') == '252')
        node.set('text', '253')
        second = sync.element_page_signature(root)
        self.assertNotEqual(first, second)
        self.assertEqual(sync.note_cards(root)[0][1]['list_view_count'], 253)
        node.set('bounds', '[0,0][0,0]')
        with self.assertRaisesRegex(sync.ElementListReadError, 'incomplete'):
            sync.element_page_signature(root)

    def test_visibility_keeps_node_order_and_excludes_invalid_rectangles(self):
        root = ET.fromstring('<hierarchy><node text="first" bounds="[1,1][4,4]"/>'
                             '<node text="missing"/><node text="reverse" bounds="[4,4][1,1]"/>'
                             '<node text="last" bounds="[0,0][2,2]"/></hierarchy>')
        self.assertEqual([n.get('text') for n in sync.live_nodes(root)], ['first', 'last'])


if __name__ == '__main__':
    unittest.main()
