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

    def test_empty_poco_proxy_is_not_iterated(self):
        class Proxy:
            def __init__(self, items):
                self.items = items
            def __len__(self):
                return len(self.items)
            def __iter__(self):
                if not self.items:
                    raise RuntimeError('real Poco empty iteration raises')
                return iter(self.items)
        class NativeLikePoco(Poco):
            def __call__(self, **selector):
                return Proxy(super().__call__(**selector))
        poco = NativeLikePoco(self.home)
        driver = w.PocoPreviewDriver(poco, lambda: w.PACKAGE, lambda: True)
        self.assertTrue(w.is_home(driver.snapshot()))
        driver.apply('open_menu', driver.snapshot(), self.phone)
        self.assertEqual(len(poco.effects), 1)

    def test_proxy_count_failure_is_not_silently_skipped(self):
        class BrokenProxy:
            def __len__(self):
                raise RuntimeError('transport failed')
        class BrokenPoco(Poco):
            def __call__(self, **selector):
                return BrokenProxy()
        poco = BrokenPoco(self.home)
        driver = w.PocoPreviewDriver(poco, lambda: w.PACKAGE, lambda: True)
        result = w.run_preview(driver, self.scenario['request'])
        self.assertEqual(result['code'], 'executor_error_no_replay')
        self.assertFalse(poco.effects)

    def test_system_clock_battery_and_traffic_change_does_not_block_menu(self):
        clock = w.Node('android.widget.TextView', text='14:54',
                       name='com.android.systemui:id/clock', position=(.108,.017), size=(.106,.034))
        battery = replace(clock, text='100%', name='com.android.systemui:id/battery_percentage_view')
        traffic = w.Node('android.widget.ImageView', name='com.android.systemui:id/wifi_in',
                         position=(.779,.017), size=(.039,.012))
        poco = Poco(replace(self.home, nodes=self.home.nodes + (clock,battery,traffic)))
        driver = w.PocoPreviewDriver(poco, lambda: w.PACKAGE, lambda: True)
        before = driver.snapshot()
        poco.screen = replace(self.home, nodes=self.home.nodes + (replace(clock,text='14:55'),replace(battery,text='99%')))
        self.assertEqual(driver.snapshot(), before)
        driver.apply('open_menu', before, self.phone)
        self.assertEqual(len(poco.effects), 1)

    def test_application_or_body_system_overlay_changes_still_stop(self):
        status = w.Node('android.widget.ImageView', name='com.android.systemui:id/wifi_in',
                        position=(.779,.017), size=(.039,.012))
        for added in (replace(status, name='com.tencent.wework:id/wifi_in'),
                      replace(status, position=(.8,.4)),
                      replace(status, size=(.05,.1)),
                      replace(status, text='安全验证'), replace(status, desc='安全验证'),
                      w.Node('android.widget.TextView', text='请确认',
                             name='com.android.systemui:id/unknown_prompt',position=(.5,.017),size=(.1,.034))):
            with self.subTest(node=added):
                poco = Poco(self.home)
                driver = w.PocoPreviewDriver(poco, lambda: w.PACKAGE, lambda: True)
                before = driver.snapshot()
                poco.screen = replace(self.home, nodes=self.home.nodes + (added,))
                with self.assertRaisesRegex(w.StopPreview, 'page_changed_before_action'):
                    driver.apply('open_menu', before, self.phone)
                self.assertFalse(poco.effects)

    def test_unknown_clock_text_and_invalid_status_geometry_are_retained(self):
        clock = w.Node('android.widget.TextView', text='14:54',
                       name='com.android.systemui:id/clock',position=(.108,.017),size=(.106,.034))
        for changed in (replace(clock,text='登录'),replace(clock,desc='安全验证'),
                        replace(clock,size=(.1,float('nan'))),replace(clock,position=(.5,.2))):
            self.assertFalse(w.is_system_status_indicator(changed))

    def test_status_filter_does_not_bypass_lost_lease_or_changed_target(self):
        poco = Poco(self.home)
        driver = w.PocoPreviewDriver(poco, lambda: w.PACKAGE, lambda: True)
        before = driver.snapshot()
        driver.lease_valid = lambda: False
        with self.assertRaisesRegex(w.StopPreview, 'device_lease_lost'):
            driver.apply('open_menu', before, self.phone)
        self.assertFalse(poco.effects)
        driver.lease_valid = lambda: True
        poco.screen = replace(self.home,nodes=tuple(replace(n,position=(.85,.11)) if n.name==w.OBSERVED_HOME_MENU else n for n in self.home.nodes))
        with self.assertRaisesRegex(w.StopPreview, 'page_changed_before_action'):
            driver.apply('open_menu', before, self.phone)
        self.assertFalse(poco.effects)


if __name__ == '__main__':
    unittest.main()
