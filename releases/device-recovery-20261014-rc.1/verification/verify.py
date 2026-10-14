#!/usr/bin/env python3
"""Offline candidate overlay. No Agent startup or real ADB/USB operations."""
from pathlib import Path
import json, os, shutil, subprocess, sys, tempfile, hashlib
candidate = Path(__file__).resolve().parent.parent
repo = candidate.parents[1]
base = repo / 'releases/lookup-20261010-rc.2'
dependencies = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path('/Users/yyx/ztqc/phone-cloud-platform')
manifest = json.loads((candidate / 'verification/MANIFEST.json').read_text())
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
for row in manifest['runtimeChanges']:
    assert digest(candidate / row['path']) == row['candidateSha256'], row['path']
    if row['productionSha256']:
        assert digest(base / row['path']) == row['productionSha256'], 'baseline drift: ' + row['path']
assert digest(candidate / 'verification/recovery-regression.test.mjs') == manifest['regressionTestSha256']
sandbox = Path(tempfile.mkdtemp(prefix='pc-device-recovery-20261014-'))
sandbox.chmod(0o700)
runtime = sandbox / 'runtime'
shutil.copytree(base, runtime, ignore=shutil.ignore_patterns('verification', 'node_modules', '.env', '.env.*', '__pycache__'))
for sub in ['fixtures', 'tests']:
    shutil.copytree(base / 'verification' / sub, runtime, dirs_exist_ok=True)
shutil.copytree(candidate / 'windows-agent', runtime / 'windows-agent', dirs_exist_ok=True)
for row in manifest['frozenBaselineFilesUnchanged']:
    assert digest(runtime / row['path']) == row['sha256'], 'frozen baseline drift: ' + row['path']
for relative in ['node_modules', 'windows-agent/node_modules']:
    dependency = dependencies / relative
    assert dependency.is_dir(), str(dependency)
    (runtime / relative).symlink_to(dependency)
env = {k: os.environ[k] for k in ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT'] if k in os.environ}
env.update(NO_PROXY='127.0.0.1,localhost', PYTHONDONTWRITEBYTECODE='1', RECOVERY_SOURCE_ROOT=str(runtime / 'windows-agent/src'))
commands = [
 ('targeted', runtime, ['node', '--test', '--test-reporter=tap', str(candidate / 'verification/recovery-regression.test.mjs')]),
 ('syntax', runtime, ['npm', 'run', 'check']),
 ('agent', runtime / 'windows-agent', ['npm', 'run', 'check']),
 ('screen', runtime, ['npm', 'run', 'test:screen'])
]
results = []
print('sandbox: ' + str(sandbox), flush=True)
for label, cwd, command in commands:
    log = sandbox / (label + '.log')
    with log.open('w') as handle:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT)
    log.chmod(0o600)
    rows = {'check':label, 'command':command, 'exitCode':result.returncode, 'sha256':hashlib.sha256(log.read_bytes()).hexdigest()}
    results.append(rows)
    print(label + ': ' + ('PASS' if result.returncode == 0 else 'FAIL'), flush=True)
    (sandbox / 'results.json').write_text(json.dumps(results, indent=2)+'\n')
    if result.returncode: break
print('logs: ' + str(sandbox), flush=True)
raise SystemExit(0 if len(results)==len(commands) and all(x['exitCode']==0 for x in results) else 1)
