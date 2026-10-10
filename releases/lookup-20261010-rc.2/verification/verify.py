#!/usr/bin/env python3
"""Reproduce offline checks in a disposable copy; never load business .env files."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

candidate = Path(__file__).resolve().parent.parent
workspace = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else candidate.parents[1]
manifest = json.loads((candidate / 'verification/MANIFEST.json').read_text())

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

for row in manifest['runtimeChanges']:
    if digest(candidate / row['path']) != row['mergedSha256']:
        raise SystemExit('Candidate runtime hash changed: ' + row['path'])
for row in manifest['frozenProductionFilesUnchanged']:
    if digest(candidate / row['path']) != row['sha256']:
        raise SystemExit('Production frozen file changed: ' + row['path'])
for row in manifest['testChanges']:
    if digest(candidate / row['path']) != row['afterSha256']:
        raise SystemExit('Reviewed test changed: ' + row['path'])

sandbox = Path(tempfile.mkdtemp(prefix='phone-cloud-offline-verification-'))
validation = sandbox / 'candidate'
shutil.copytree(candidate, validation,
                ignore=shutil.ignore_patterns('verification', 'README.md', '__pycache__', 'node_modules', '.env', '.env.*'))
for directory in ['fixtures', 'tests']:
    shutil.copytree(candidate / 'verification' / directory, validation, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('__pycache__', '.env', '.env.*'))
for relative in ['node_modules', 'windows-agent/node_modules']:
    dependency = workspace / relative
    if not dependency.is_dir():
        raise SystemExit('Existing workspace dependencies required: ' + str(dependency))
    (validation / relative).symlink_to(dependency)

# Explicit allowlist: no inherited DB/Redis, Agent, webhook, proxy or token configuration.
env = {key: os.environ[key] for key in ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT'] if key in os.environ}
env.update({'NO_PROXY': '127.0.0.1,localhost', 'PYTHONDONTWRITEBYTECODE': '1'})
commands = [
    ('syntax', validation, ['npm', 'run', 'check']),
    ('screen', validation, ['npm', 'run', 'test:screen']),
    ('agent', validation / 'windows-agent', ['npm', 'run', 'check']),
    ('python', validation, [sys.executable, '-m', 'unittest', 'discover', '-s', 'windows-agent/scripts', '-p', 'automation_runners_test.py']),
    ('lookup', validation, [sys.executable, '-m', 'unittest', 'discover', '-s', 'windows-agent/scripts', '-p', 'test_lookup_*.py']),
    ('sdk-node', validation, ['node', '--test', 'sdk/open_name_lookup/node_client.test.mjs']),
    ('sdk-python', validation, [sys.executable, '-m', 'unittest', 'sdk.open_name_lookup.python_client_test']),
]
results = []
for label, cwd, command in commands:
    log = sandbox / (label + '.log')
    with log.open('w') as handle:
        log.chmod(0o600)
        result = subprocess.run(command, cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT)
    results.append({'check': label, 'exitCode': result.returncode, 'log': str(log)})
    print(label + ': ' + ('PASS' if result.returncode == 0 else 'FAIL'), flush=True)
    if result.returncode:
        print('Private diagnostics: ' + str(log), flush=True)
        break
(sandbox / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
print('Offline evidence: ' + str(sandbox), flush=True)
raise SystemExit(0 if len(results) == len(commands) and all(row['exitCode'] == 0 for row in results) else 1)
