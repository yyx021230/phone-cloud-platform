"""Owned local regression launcher; no inherited service credentials or upstreams."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
if (ROOT / '.env').exists():
    raise SystemExit('isolated checkout must not contain .env')
NODE = '/opt/homebrew/bin/node'
NPM = '/opt/homebrew/bin/npm'
targets = {
    'http': [NODE, '--test', '--test-concurrency=1', '--test-reporter=spec',
             'server/wecom-preview.http.test.mjs', 'server/wecom-physical-cleanup.http.test.mjs',
             'server/wecom-status-transport.http.test.mjs', 'server/wecom-integration.e2e.test.mjs'],
    'agent': [NPM, 'run', 'check', '--prefix', 'windows-agent'],
    'screen': [NPM, 'run', 'test:screen'],
    'check': [NPM, 'run', 'check'],
    'python': ['python3', '-m', 'unittest', 'discover', '-s', 'windows-agent/scripts', '-p', 'test_wecom*.py'],
    'sdk': [NODE, '--test', 'examples/wecom-integration/client.test.mjs'],
}
name, label = sys.argv[1:]
if name not in targets or not label.replace('-', '').replace('_', '').isalnum():
    raise SystemExit('invalid fixed local target/label')
command = targets[name]
def sources():
    paths = set()
    for directory, pattern in [('server','*.mjs'),('windows-agent/src','*.mjs'),
                               ('windows-agent/scripts','*.py'),('screen-client','*.js'),
                               ('screen-client','*.mjs'),('scripts','*.mjs'),
                               ('examples/wecom-integration','*.mjs')]:
        paths.update((ROOT/directory).glob(pattern))
    paths.update(ROOT/p for p in ['package.json','package-lock.json','windows-agent/package.json',
                                 'windows-agent/package-lock.json'])
    paths.update(OUT.glob('*.py'))
    return {str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}
before = sources()
safe = {k: os.environ[k] for k in ['PATH', 'HOME', 'SYSTEMROOT', 'TEMP', 'TMP'] if os.environ.get(k)}
safe.update(DATABASE_URL='', REDIS_URL='', STORAGE_BACKEND='json', PYTHONDONTWRITEBYTECODE='1')
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
with tempfile.TemporaryDirectory(prefix='pc-wecom-causal-local-') as work:
    safe['TMPDIR'] = work
    with (OUT / (label + '.txt')).open('wb') as log:
        child = subprocess.Popen(command, cwd=ROOT, env=safe, stdout=log, stderr=subprocess.STDOUT,
                                 stdin=subprocess.DEVNULL, start_new_session=True)
        timed_out = False
        try:
            code = child.wait(timeout=600 if name == 'screen' else 180)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(child.pid, signal.SIGTERM)
            try:
                code = child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                code = child.wait(timeout=5)
result = dict(command=command, target=name, startedAt=started,
              endedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
              exitCode=code, timedOut=timed_out, environmentKeys=sorted(safe),
              inheritedCredentials=False, databaseUrl='', redisUrl='',
              temporaryStorage=True, services='loopback fixtures only',
              sourceBefore=before, sourceAfter=sources())
result['sourceUnchanged'] = result['sourceBefore'] == result['sourceAfter']
if not result['sourceUnchanged']:
    result['invalidatedBySourceDrift'] = True
    code = 1
(OUT / (label + '.json')).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(dict(label=label, exitCode=code, timedOut=timed_out)))
raise SystemExit(1 if code else 0)
