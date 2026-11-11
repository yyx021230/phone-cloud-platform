"""Reproduce the old oracle blind spot and prove the replacement catches it.

Every product modification is an in-memory monkeypatch in this process. This
never modifies product files or starts SDKs/phones, and is not a product defect.
"""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
BASE = 'c6cce4fe4206ff8dd0473e86637a04656900f4de'
RELATIVE = 'windows-agent/scripts/test_wecom_script_acceptance.py'
if sys.argv[1:] != ['--offline']:
    raise SystemExit('explicit --offline required')
os.environ.clear()
old_source = subprocess.check_output(['/usr/bin/git', '-C', str(ROOT), 'show', BASE + ':' + RELATIVE], text=True)
def audit(event, args):
    if event in ('socket.connect', 'socket.bind', 'subprocess.Popen', 'os.system', 'os.exec', 'os.posix_spawn'):
        raise RuntimeError('mutation_comparison_external_or_child_action_forbidden')
sys.addaudithook(audit)
sys.path.insert(0, str(ROOT / 'windows-agent/scripts'))
import test_wecom_script_acceptance as current
import test_wecom_invite_preview as io_fixture
import wecom_remark_preview as r
baseline = types.ModuleType('wecom_baseline_oracle')
baseline.__file__ = str(ROOT / RELATIVE)
exec(compile(old_source, BASE + ':' + RELATIVE, 'exec'), baseline.__dict__)
summary = {'baselineCommit': BASE, 'scope': 'wrong-editor mutation of actual resolver in local process only',
           'nativeAcceptance': False, 'runs': {}}
resolver, original_write = r.resolve_remark, io_fixture.PocoItem.set_text
for label, module in [('baseline', baseline), ('current', current)]:
    wrong_writes = []
    def swapped(action, screen, phone, context=None):
        node = resolver(action, screen, phone, context)
        if action in ('fill_remark', 'fill_description'):
            for ids in current.LAYOUTS:
                if node.name in (ids['remarkName'], ids['description']):
                    other = ids['description'] if node.name == ids['remarkName'] else ids['remarkName']
                    return next(n for n in screen.nodes if n.kind == 'android.widget.EditText' and n.name == other)
        return node
    def record(item, value):
        if ((value == current.NAME and item.node.name in {x['description'] for x in current.LAYOUTS})
                or (value == current.DESCRIPTION and item.node.name in {x['remarkName'] for x in current.LAYOUTS})):
            wrong_writes.append(item.node.name)
        return original_write(item, value)
    cls = module.ScriptAcceptanceTests
    suite = unittest.TestSuite(cls(name) for name in sorted(unittest.defaultTestLoader.getTestCaseNames(cls))
                              if name.startswith('test_layout_'))
    log = io.StringIO()
    with patch.object(r, 'resolve_remark', swapped), patch.object(io_fixture.PocoItem, 'set_text', record):
        result = unittest.TextTestRunner(stream=log, verbosity=2).run(suite)
    (OUT / (label.upper() + '_MUTATION_OUTPUT.txt')).write_text(log.getvalue())
    summary['runs'][label] = {'tests': result.testsRun, 'failures': len(result.failures),
        'errors': len(result.errors), 'actualWrongTargetWrites': len(wrong_writes),
        'casesPassed': result.testsRun - len(result.failures) - len(result.errors),
        'noWriteCases': 6,
        'susceptibleMutantSurvived': result.testsRun - len(result.failures) - len(result.errors) - 6}
old, new = summary['runs']['baseline'], summary['runs']['current']
# New flow stops at the first mismatching write. Six fully-retained cases have
# no edits at all: the adversarial resolver is never invoked for those cases.
# Their positive oracle legitimately passes; they are not surviving mutants.
summary['expectedOutcomeVerified'] = (old['tests'] == 24 and old['errors'] == 0
    and old['failures'] == 0 and old['actualWrongTargetWrites'] == 24
    and new['tests'] == 24 and new['errors'] == 0 and new['failures'] == 18
    and new['actualWrongTargetWrites'] == 18 and new['casesPassed'] == 6
    and new['susceptibleMutantSurvived'] == 0)
(OUT / 'MUTATION_COMPARISON.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary))
raise SystemExit(0 if summary['expectedOutcomeVerified'] else 1)
