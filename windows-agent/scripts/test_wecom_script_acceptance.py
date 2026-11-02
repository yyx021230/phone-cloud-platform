"""Actual preview/remark adapters, synthetic UI IO, never a native phone test.

The composed layout matrix is deliberately synthetic: observed identifiers do
not establish that every model/account has traversed these pages on a device.
The separately retained XML-derived replay is covered by test_wecom_real_elements.
"""
from dataclasses import replace
import json
import unittest

import wecom_invite_preview as w
import wecom_remark_preview as r
from test_wecom_invite_preview import PHONE, OTHER, Poco, frame
from test_wecom_remark_preview import scenario


NAME = 'yyx（坦克）'
DESCRIPTION = '接口测试\n发送前停止'


class ScriptHarness:
    """Only Poco IO is fake; selection, write/readback, flow and guards are real."""
    def __init__(self, *, layout=0, name='', description='添加更多备注信息',
                 fault=None, at=0):
        self.pages, self.actions = scenario(name, description, NAME, DESCRIPTION)
        mapping = dict(zip(r.REMARK_LAYOUTS[0], r.REMARK_LAYOUTS[layout]))
        self.pages = [replace(page, nodes=tuple(
            replace(node, name=mapping.get(node.name, node.name))
            for node in page.nodes)) for page in self.pages]
        self.fault, self.at, self.lease = fault, at, True
        self.attempted = []
        owner = self

        class AdvancingPoco(Poco):
            def __call__(self, **selector):
                items = super().__call__(**selector)
                for item in items:
                    click, write = item.click, item.set_text
                    def advance(original, *args):
                        # An unexpected send/message click is an independent
                        # oracle violation, even if run_preview catches it.
                        original(*args)
                        if not (owner.fault == 'stalled' and len(self.effects) == owner.at + 1):
                            self.screen = owner.pages[len(self.effects)]
                        if owner.fault == 'ack_lost' and len(self.effects) == owner.at + 1:
                            raise RuntimeError('synthetic acknowledgement lost')
                    item.click = lambda original=click: advance(original)
                    item.set_text = lambda value, original=write: advance(original, value)
                return items

        class ActualAdapter(r.PocoRemarkDriver):
            def apply(self, action, expected, phone, check_budget=lambda: None, context=None):
                owner.attempted.append(action)
                if len(self.poco.effects) == owner.at:
                    if owner.fault == 'lease':
                        owner.lease = False
                    elif owner.fault == 'page':
                        self.poco.screen = replace(self.poco.screen, nodes=self.poco.screen.nodes + (
                            w.Node('android.widget.TextView', text='synthetic changed page'),))
                    elif owner.fault in ('cancelled', 'timeout'):
                        def check_budget():
                            raise w.StopPreview(owner.fault)
                return super().apply(action, expected, phone, check_budget, context=context)

        self.poco = AdvancingPoco(self.pages[0])
        self.driver = ActualAdapter(self.poco, lambda: w.PACKAGE, lambda: self.lease)

    def run(self, **kwargs):
        return r.run_customer_preview(self.driver, {
            'phoneNumber': PHONE, 'remarkName': NAME, 'description': DESCRIPTION,
        }, sleep=lambda _: None, **kwargs)


class ScriptAcceptanceTests(unittest.TestCase):
    def assert_no_invitation(self, harness, result):
        self.assertFalse(result['invitationSent'])
        self.assertFalse(any(kind == 'click' and label in (w.SEND, '发消息')
                             for kind, label in harness.poco.effects))
        self.assertLessEqual(sum(kind == 'click' and label == '保存'
                                 for kind, label in harness.poco.effects), 1)
        serialized = json.dumps(result, ensure_ascii=False)
        for private in (PHONE, NAME, DESCRIPTION):
            self.assertNotIn(private, serialized)


def layout_case(layout, name, description):
    def test(self):
        h = ScriptHarness(layout=layout, name=name, description=description)
        result = h.run()
        self.assertTrue(result['readyToSend'], result)
        self.assertEqual(h.attempted, h.actions)
        self.assertEqual(len(h.poco.effects), len(h.actions))
        inputs = [PHONE] + ([] if name else [NAME]) + (
            [] if description == '已有描述' else [DESCRIPTION])
        self.assertEqual([value for kind, value in h.poco.effects if kind == 'input'], inputs)
        self.assertTrue(h.poco.screen.has(w.SEND))
        expected = 'not_needed' if name and description == '已有描述' else 'confirmed'
        self.assertEqual(result['remarkSaveStatus'], expected)
        # The last reopened editor must contain exactly the retained or requested
        # fields, while the synthetic company and phone editors survive unchanged.
        saved = next(page for page in reversed(h.pages) if r.remark_page(page))
        editors = {node.name: node.text for node in r.editors(saved)
                   if node.name in r.REMARK_LAYOUTS[layout][:2]}
        self.assertEqual(editors[r.REMARK_LAYOUTS[layout][0]], name or NAME)
        self.assertEqual(editors[r.REMARK_LAYOUTS[layout][1]],
                         description if description == '已有描述' else DESCRIPTION)
        self.assert_no_invitation(h, result)
    return test


FULL_ACTIONS = scenario(requested_name=NAME, requested_description=DESCRIPTION)[1]


def fault_case(fault, index):
    def test(self):
        h = ScriptHarness(fault=fault, at=index)
        result = h.run()
        self.assertFalse(result['readyToSend'], result)
        expected_code = {'lease': 'device_lease_lost', 'page': 'page_changed_before_action',
                         'ack_lost': 'executor_error_no_replay'}.get(fault, fault)
        self.assertEqual(result['code'], expected_code)
        delivered = index + (fault == 'ack_lost')
        self.assertEqual(len(h.poco.effects), delivered)
        self.assertEqual(h.attempted, FULL_ACTIONS[:index + 1])
        if FULL_ACTIONS[index] == 'save_remark':
            # Conservatively unknown even if the adapter stopped before effect;
            # do not turn uncertain delivery into permission to save again.
            self.assertEqual(result['remarkSaveStatus'], 'unknown')
        self.assert_no_invitation(h, result)
    return test


def replacement_page_case(label, code):
    def test(self):
        for index in range(len(ScriptHarness().pages) - 1):
            with self.subTest(page=index):
                h = ScriptHarness()
                h.pages[index] = frame(label)
                h.poco.screen = h.pages[0]
                result = h.run()
                self.assertEqual(result['code'], code)
                self.assertFalse(result['readyToSend'])
                self.assertEqual(len(h.poco.effects), index)
                self.assert_no_invitation(h, result)
    return test


def real_budget_case(reason, index):
    def test(self):
        h = ScriptHarness()
        if reason == 'cancelled':
            result = h.run(cancelled=lambda: len(h.poco.effects) >= index)
        else:
            calls = [0]
            def clock():
                calls[0] += 1
                return 20 if calls[0] > 1 and len(h.poco.effects) >= index else 0
            result = h.run(timeout=10, clock=clock)
        self.assertEqual(result['code'], reason)
        self.assertFalse(result['readyToSend'])
        self.assertEqual(len(h.poco.effects), index)
        self.assert_no_invitation(h, result)
    return test


def stalled_case(index):
    def test(self):
        h = ScriptHarness(fault='stalled', at=index)
        result = h.run()
        self.assertFalse(result['readyToSend'])
        self.assertIn(result['code'], ('observation_budget_exhausted',
                                      'remark_observation_budget_exhausted'))
        self.assertEqual(h.attempted, FULL_ACTIONS[:index + 1])
        self.assertEqual(len(h.poco.effects), index + 1)
        self.assert_no_invitation(h, result)
    return test


def profile_boundary_case(index, already_contact):
    def test(self):
        h = ScriptHarness()
        h.pages[index] = (frame('个人信息', '设置备注和描述', PHONE, '发消息')
                          if already_contact else replace(h.pages[index], nodes=tuple(
                              replace(n, text=OTHER) if n.text == PHONE else n
                              for n in h.pages[index].nodes)))
        result = h.run()
        self.assertEqual(result['code'], 'already_contact' if already_contact else 'profile_phone_mismatch')
        self.assertEqual(len(h.poco.effects), index)
        self.assertFalse(result['readyToSend'])
        self.assert_no_invitation(h, result)
    return test


for layout in range(len(r.REMARK_LAYOUTS)):
    for label, name, description in (
        ('empty', '', '添加更多备注信息'),
        ('retained', '已有名字', '已有描述'),
        ('name_retained', '已有名字', '添加更多备注信息'),
        ('description_retained', '', '已有描述'),
    ):
        setattr(ScriptAcceptanceTests, 'test_layout_%d_%s' % (layout, label),
                layout_case(layout, name, description))

for fault in ('lease', 'page', 'cancelled', 'timeout', 'ack_lost'):
    for index, action in enumerate(FULL_ACTIONS):
        setattr(ScriptAcceptanceTests, 'test_%s_%02d_%s' % (fault, index, action),
                fault_case(fault, index))

for index, action in enumerate(FULL_ACTIONS):
    setattr(ScriptAcceptanceTests, 'test_stalled_%02d_%s' % (index, action), stalled_case(index))
    for reason in ('cancelled', 'timeout'):
        setattr(ScriptAcceptanceTests, 'test_actual_budget_%s_%02d' % (reason, index),
                real_budget_case(reason, index))

for index in (5, 9, 11):
    for already_contact in (False, True):
        setattr(ScriptAcceptanceTests, 'test_profile_%02d_%s' % (index, already_contact),
                profile_boundary_case(index, already_contact))

for label, code in (('同事辅助验证', 'human_required'),
                    ('登录失效，请重新登录。', 'login_required'),
                    ('未找到相关用户', 'not_found')):
    setattr(ScriptAcceptanceTests, 'test_page_boundary_' + code,
            replacement_page_case(label, code))


if __name__ == '__main__':
    unittest.main()
