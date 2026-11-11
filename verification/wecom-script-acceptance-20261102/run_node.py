"""Offline wrapper/lifecycle regressions; fake children except one local fixture."""
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
TESTS = [
    'wecom-preview-task', 'wecom-preview-lifecycle', 'wecom-diagnostics',
    'wecom-cleanup-protocol', 'wecom-physical-readiness',
    'wecom-cleanup-entry', 'wecom-cleanup-verify',
]

if sys.argv[1:] != ['--offline']:
    raise SystemExit('explicit --offline required')
environment = {key: value for key, value in os.environ.items()
               if key in {'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT', 'WINDIR', 'HOME'}}
environment['PYTHONDONTWRITEBYTECODE'] = '1'
process = subprocess.run([shutil.which('node'), '--test', '--test-reporter=tap', '--test-concurrency=1', *[
    str(ROOT / 'windows-agent' / 'src' / (name + '.test.mjs')) for name in TESTS
]], cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, timeout=60)
(OUT / 'NODE_OUTPUT.txt').write_text(process.stdout, encoding='utf8')
counts = {key: int(value) for key, value in re.findall(
    r'^# (tests|pass|fail|cancelled|skipped) (\d+)\s*$', process.stdout, re.MULTILINE)}
receipt = {'atUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'exitCode': process.returncode, 'counts': counts, 'testFiles': TESTS,
           'scope': 'existing wrapper/lifecycle tests with fixture IO, not native acceptance',
           'nativeAcceptance': False}
(OUT / 'NODE_RECEIPT.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf8')
print(json.dumps(receipt))
raise SystemExit(process.returncode)
