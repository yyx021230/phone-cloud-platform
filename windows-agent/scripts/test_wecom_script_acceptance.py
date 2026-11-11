"""Actual preview/remark adapters, synthetic UI IO, never a native phone test.

The composed layout matrix is deliberately synthetic: observed identifiers do
not establish that every model/account has traversed these pages on a device.
The separately retained XML-derived replay is covered by test_wecom_real_elements.
"""
from dataclasses import replace
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import wecom_invite_preview as w
import wecom_remark_preview as r
from test_wecom_invite_preview import PHONE, OTHER, Poco, frame, PATH, PROFILE, PREVIEW


NAME = 'yyx（坦克）'
DESCRIPTION = '接口测试\n发送前停止'
FIXTURE = json.loads((Path(__file__).resolve().parents[2] /
    'verification/wecom-script-oracle-20261102/field-fixtures.json').read_text())
LAYOUTS = FIXTURE['layouts']


def editor_template(page):
    return page.has('设置备注和描述') and len([
        n for n in page.nodes if n.kind == 'android.widget.EditText']) == 5


def plan(name, description, layout):
    """Navigation templates contain only INITIAL editor values, never expected writes."""
    ids = LAYOUTS[layout]
    others = FIXTURE['otherFields']
    editor = frame('设置备注和描述', '备注名', '企业', '电话', '描述', '保存',
        w.Node('android.widget.TextView', name=ids['back'], position=(.05, .065)),
        w.Node('android.widget.EditText', name=ids['remarkName'], text=name),
        *[w.Node('android.widget.EditText', name=f['resource'], text=f['text']) for f in others],
        w.Node('android.widget.EditText', name=ids['description'], text=description))
    pages = PATH[:6] + [editor]
    actions = ['open_menu', 'open_add', 'open_search', 'enter_phone', 'search', 'open_remark']
    if not name:
        pages.append(editor); actions.append('fill_remark')
    if description == '添加更多备注信息':
        pages.append(editor); actions.append('fill_description')
    if not name or description == '添加更多备注信息':
        pages += [PROFILE, editor]; actions += ['save_remark', 'open_remark']
    pages += [PROFILE, PREVIEW]; actions += ['close_remark', 'open_preview']
    return pages, actions


class ScriptHarness:
    """Only Poco IO is fake; selection, write/readback, flow and guards are real."""
    def __init__(self, *, layout=0, name='', description='添加更多备注信息',
                 fault=None, at=0, mutation=None):
        self.pages, self.actions = plan(name, description, layout)
        self.fault, self.at, self.lease = fault, at, True
        self.attempted, self.mutations = [], []
        self.layout, self.mutation, self.index, self.pending = layout, mutation, 0, None
        self.initial = tuple(n for n in self.pages[6].nodes if n.kind == 'android.widget.EditText')
        self.saved = self.initial
        self.draft = None
        self.commits = 0
        owner = self

        class AdvancingPoco(Poco):
            def __call__(self, **selector):
                items = super().__call__(**selector)
                for item in items:
                    click, write, node = item.click, item.set_text, item.node
                    def deliver(original, node, *args):
                        original(*args)
                        owner.deliver(node, args)
                        if not (owner.fault == 'stalled' and len(self.effects) == owner.at + 1):
                            self.screen = owner.render()
                        if owner.fault == 'ack_lost' and len(self.effects) == owner.at + 1:
                            raise RuntimeError('synthetic acknowledgement lost')
                    item.click = lambda original=click, node=node: deliver(original, node)
                    item.set_text = lambda value, original=write, node=node: deliver(original, node, value)
                return items

        class ActualAdapter(r.PocoRemarkDriver):
            def apply(self, action, expected, phone, check_budget=lambda: None, context=None):
                owner.attempted.append(action)
                owner.pending = action
                if owner.mutation == 'save_not_clicked' and action == 'save_remark':
                    return  # Mutation oracle: pretend success without any UI effect.
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

    def render(self):
        template = self.pages[self.index]
        if not editor_template(template):
            return template
        if self.draft is None:
            raise AssertionError('editor rendered without an actual open click')
        iterator = iter(self.draft)
        # Every editor value is state, never a precomputed expected fixture.
        return replace(template, nodes=tuple(next(iterator) if n.kind == 'android.widget.EditText'
                                             else n for n in template.nodes))

    def deliver(self, node, args):
        """UI state follows the actual selected node, not the requested action."""
        field = None
        if args and self.draft is not None:
            # Identity within five editors disambiguates the two generic IDs.
            field = next((i for i, n in enumerate(self.draft) if n is node), None)
            if field is None:
                raise AssertionError('selected editor is not in the current UI state')
        self.mutations.append({'action': self.pending, 'resource': node.name,
                               'kind': node.kind, 'field': field,
                               'original': node.text, 'value': args[0] if args else None})
        if args:
            if node.kind not in ('android.widget.EditText', 'android.widget.SearchView'):
                raise AssertionError('write to a non-editor')
            if field is not None:
                if self.mutation != 'input_no_effect':
                    draft = list(self.draft)
                    draft[field] = replace(node, text=args[0])
                    if self.mutation in ('company_corrupted', 'phone_corrupted'):
                        other = 1 if self.mutation == 'company_corrupted' else 2
                        self.mutations.append({'action': 'synthetic_extra_write',
                            'resource': draft[other].name, 'kind': draft[other].kind,
                            'field': other, 'original': draft[other].text,
                            'value': 'synthetic unrelated corruption'})
                        draft[other] = replace(draft[other], text='synthetic unrelated corruption')
                    self.draft = tuple(draft)
            else:
                # Search input also reflects actual delivered text rather than PHONE.
                typed = self.pages[self.index + 1]
                self.pages[self.index + 1] = replace(typed, nodes=tuple(
                    replace(n, text=args[0]) if n.kind == 'android.widget.EditText'
                    else replace(n, text='网络查找手机/邮箱：' + args[0])
                    if n.text.startswith('网络查找手机/邮箱') else n for n in typed.nodes))
        elif node.text == '保存':
            if self.draft is None:
                raise AssertionError('save without editor')
            if self.mutation != 'save_no_effect':
                self.saved = tuple(self.draft)
                self.commits += 1
            self.draft = None
        elif node.text == '设置备注和描述':
            self.draft = tuple(self.initial if self.mutation == 'reopen_stale' and self.commits
                               else self.saved)  # Never derive readback from desired values.
        elif node.name == LAYOUTS[self.layout]['back'] and self.draft is not None:
            self.draft = None  # Back discards unsaved draft.
        elif node.text in (w.SEND, '发消息'):
            raise AssertionError('forbidden send/message click')
        self.index += 1

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


def layout_case(layout, name, description, *, mutation=None, captured=None):
    def test(self):
        h = ScriptHarness(layout=layout, name=name, description=description, mutation=mutation,
                          fault='ack_lost' if mutation == 'save_ack_lost' else None, at=8)
        if captured is not None:
            captured.append(h)
        result = h.run()
        h.result = result
        self.assertTrue(result['readyToSend'], result)
        self.assertEqual(h.attempted, h.actions)
        self.assertEqual(len(h.poco.effects), len(h.actions))
        inputs = [PHONE] + ([] if name else [NAME]) + (
            [] if description == '已有描述' else [DESCRIPTION])
        self.assertEqual([value for kind, value in h.poco.effects if kind == 'input'], inputs)
        self.assertTrue(h.poco.screen.has(w.SEND))
        expected = 'not_needed' if name and description == '已有描述' else 'confirmed'
        self.assertEqual(result['remarkSaveStatus'], expected)
        # Assert actual committed state and concrete target identity independently
        # from the product's resolver and REMARK_LAYOUTS constants.
        self.assertEqual(h.saved[0].text, name or NAME)
        self.assertEqual(h.saved[4].text, description if description == '已有描述' else DESCRIPTION)
        self.assertEqual(h.saved[1:4], h.initial[1:4])
        expected_targets = ([] if name else [(LAYOUTS[layout]['remarkName'], 0, NAME)])
        expected_targets += ([] if description == '已有描述' else [
            (LAYOUTS[layout]['description'], 4, DESCRIPTION)])
        actual_targets = [(x['resource'], x['field'], x['value']) for x in h.mutations if x['field'] is not None]
        self.assertEqual(actual_targets, expected_targets)
        self.assertEqual(h.commits, 0 if expected == 'not_needed' else 1)
        self.assert_no_invitation(h, result)
    return test


class MutationOracleTests(unittest.TestCase):
    """Deliberately wrong implementations must fail the SAME positive oracle."""


def mutation_case(layout, mutation):
    def test(self):
        captured = []
        resolver = r.resolve_remark
        def wrong_editor(action, screen, phone, context=None):
            node = resolver(action, screen, phone, context)
            if action in ('fill_remark', 'fill_description'):
                other = LAYOUTS[layout]['description' if action == 'fill_remark' else 'remarkName']
                return next(n for n in screen.nodes if n.kind == 'android.widget.EditText' and n.name == other)
            return node
        if mutation == 'wrong_editor':
            context = patch.object(r, 'resolve_remark', wrong_editor)
        elif mutation == 'swapped_constants':
            layouts = list(r.REMARK_LAYOUTS)
            a, b, back = layouts[layout]
            layouts[layout] = (b, a, back)
            context = patch.object(r, 'REMARK_LAYOUTS', tuple(layouts))
        else:
            from contextlib import nullcontext
            context = nullcontext()
        with context, self.assertRaises(AssertionError):
            layout_case(layout, '', '添加更多备注信息', mutation=mutation, captured=captured)(self)
        self.assertEqual(len(captured), 1)
        h = captured[0]
        if mutation == 'wrong_editor':
            self.assertEqual(h.mutations[-1]['resource'], LAYOUTS[layout]['description'])
            self.assertEqual(h.mutations[-1]['field'], 4)
            self.assertEqual(h.result['code'], 'remark_readback_mismatch')
        elif mutation == 'save_no_effect' or mutation == 'reopen_stale':
            self.assertEqual(h.result['code'], 'remark_persistence_unconfirmed')
            self.assertEqual(h.result['remarkSaveStatus'], 'unknown')
            self.assertEqual(h.commits, 0 if mutation == 'save_no_effect' else 1)
        elif mutation == 'save_not_clicked':
            self.assertEqual(h.commits, 0)
            self.assertFalse(any(x['original'] == '保存' for x in h.mutations))
            self.assertEqual(h.result['code'], 'remark_observation_budget_exhausted')
        elif mutation == 'input_no_effect':
            self.assertEqual(h.result['code'], 'remark_observation_budget_exhausted')
            self.assertEqual(h.commits, 0)
            self.assertEqual(h.draft, h.initial)
        elif mutation == 'save_ack_lost':
            self.assertEqual(h.commits, 1)
            self.assertEqual(h.result['remarkSaveStatus'], 'unknown')
            self.assertFalse(h.result['readyToSend'])
            self.assertEqual((h.saved[0].text, h.saved[4].text), (NAME, DESCRIPTION))
        elif mutation in ('company_corrupted', 'phone_corrupted'):
            self.assertEqual(h.result['code'], 'remark_readback_mismatch')
            self.assertEqual(h.commits, 0)
        elif mutation == 'swapped_constants':
            # Product may internally agree on the wrong mapping. Independent
            # semantic fixtures still reject the resulting committed values.
            self.assertEqual(h.saved[0].text, DESCRIPTION)
            self.assertEqual(h.saved[4].text, NAME)
        self.assertFalse(h.result['invitationSent'])
        self.assertFalse(any(kind == 'click' and value == w.SEND for kind, value in h.poco.effects))
    return test


for layout in range(len(LAYOUTS)):
    for mutation in ('wrong_editor', 'swapped_constants', 'input_no_effect',
                     'company_corrupted', 'phone_corrupted', 'save_not_clicked',
                     'save_no_effect', 'reopen_stale', 'save_ack_lost'):
        setattr(MutationOracleTests, 'test_reject_%s_layout_%d' % (mutation, layout),
                mutation_case(layout, mutation))


FULL_ACTIONS = plan('', '添加更多备注信息', 0)[1]


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


for layout in range(len(LAYOUTS)):
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
