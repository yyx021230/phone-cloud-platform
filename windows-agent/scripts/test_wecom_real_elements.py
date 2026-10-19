"""Offline tests using minimized XML-derived fixtures. Never connects to a phone."""
from dataclasses import replace
import json
from pathlib import Path
import unittest

import wecom_invite_preview as w
from test_wecom_invite_preview import Poco

FIXTURE = Path(__file__).resolve().parents[2] / 'releases/wecom-invite-preview-20261019-rc.2/redacted-real-flow.json'


class RealElementReplayTests(unittest.TestCase):
    def setUp(self):
        self.scenario = json.loads(FIXTURE.read_text(encoding='utf-8'))
        self.phone = self.scenario['request']['phoneNumber']
        self.home = w.ReplayDriver(self.scenario).snapshot()

    def test_reconstructed_path_reaches_boundary_in_six_actions(self):
        driver = w.ReplayDriver(self.scenario)
        result = w.run_preview(driver, self.scenario['request'], sleep=lambda _: None)
        self.assertEqual(result['status'], 'ready_before_send')
        self.assertEqual(driver.actions, ['open_menu','open_add','open_search','enter_phone','search','open_preview'])
        self.assertFalse(result['invitationSent'])
        self.assertFalse(result['remarkSaved'])

    def test_unlabeled_textview_resource_is_resolved(self):
        node = w.resolve_action('open_menu', self.home, self.phone)
        self.assertEqual(node.name, 'com.tencent.wework:id/nt3')
        self.assertEqual(node.kind, 'android.widget.TextView')
        self.assertFalse(node.text or node.desc)

    def test_adapter_uses_type_and_name_not_coordinates(self):
        class RecordingPoco(Poco):
            def __call__(self, **selector):
                self.last_selector = selector
                return super().__call__(**selector)
        poco = RecordingPoco(self.home)
        driver = w.PocoPreviewDriver(poco, lambda: w.PACKAGE, lambda: True)
        driver.apply('open_menu', driver.snapshot(), self.phone)
        self.assertEqual(poco.last_selector, {'type':'android.widget.TextView','name':'com.tencent.wework:id/nt3'})
        self.assertEqual(len(poco.effects), 1)

    def test_wrong_resource_type_geometry_or_unseen_text_is_rejected(self):
        original = w.resolve_action('open_menu', self.home, self.phone)
        for changed in (replace(original, name='com.tencent.wework:id/ntd'),
                        replace(original, kind='android.widget.ImageView'),
                        replace(original, position=(.5,.8)),
                        replace(original, enabled=False), replace(original, visible=False),
                        replace(original, text='unknown_action')):
            home = replace(self.home, nodes=tuple(changed if n == original else n for n in self.home.nodes))
            with self.subTest(changed=changed), self.assertRaises(w.StopPreview):
                w.resolve_action('open_menu', home, self.phone)

    def test_resource_without_home_context_is_not_accepted(self):
        node = w.resolve_action('open_menu', self.home, self.phone)
        with self.assertRaisesRegex(w.StopPreview, 'action_not_allowed'):
            w.resolve_action('open_menu', w.Screen(w.PACKAGE, (node,)), self.phone)

    def test_duplicate_observed_resource_is_rejected(self):
        node = w.resolve_action('open_menu', self.home, self.phone)
        home = replace(self.home, nodes=self.home.nodes + (replace(node, position=(.9,.1)),))
        with self.assertRaisesRegex(w.StopPreview, 'ambiguous'):
            w.resolve_action('open_menu', home, self.phone)

    def test_live_resource_changes_before_click_stop_without_action(self):
        poco = Poco(self.home)
        driver = w.PocoPreviewDriver(poco, lambda: w.PACKAGE, lambda: True)
        expected = driver.snapshot()
        poco.screen = replace(self.home, nodes=tuple(replace(n, name='different') if n.name == w.OBSERVED_HOME_MENU else n for n in self.home.nodes))
        with self.assertRaisesRegex(w.StopPreview, 'page_changed_before_action'):
            driver.apply('open_menu', expected, self.phone)
        self.assertFalse(poco.effects)


if __name__ == '__main__':
    unittest.main()
