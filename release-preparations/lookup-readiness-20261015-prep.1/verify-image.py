"""Validate/export an already-built image on the dedicated LOCAL release daemon."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import time
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--artifacts', required=True)
args = parser.parse_args()
root = Path(args.artifacts).expanduser().resolve()
manifest = json.loads((root / 'ARTIFACTS.json').read_text())
docker = ['docker', '--host', 'unix://' + str(Path.home() / '.colima/phonecloud-release/docker.sock')]
run = lambda *args, **kw: subprocess.check_output([*docker, *args], text=True, **kw).strip()
tag = 'phone-cloud-platform:' + manifest['version']
info = json.loads(run('image', 'inspect', tag))[0]
assert info['Architecture'] == 'amd64' and info['Os'] == 'linux'
assert info['Config']['Labels']['org.opencontainers.image.revision'] == manifest['sourceCommit']
assert info['Config']['Labels']['org.opencontainers.image.version'] == manifest['version']
assert not (root / 'IMAGE.json').exists(), 'do not overwrite image evidence'
assert not (root / 'cloud-image-linux-amd64.tar.gz').exists(), 'do not overwrite image archive'
container = None
try:
    # Ephemeral random fixture credentials never enter command arguments, files or reports.
    bootstrap = "import crypto from 'node:crypto';for(const k of ['ADMIN_PASSWORD','ADMIN_API_TOKEN','WINDOWS_AGENT_TOKEN','DEVICE_AGENT_TOKEN','SCREEN_MEDIA_AUTH_SECRET','EVIDENCE_SIGNING_SECRET'])process.env[k]=crypto.randomUUID();await import('./server/index.mjs');"
    container = run('run', '-d', '--platform', 'linux/amd64', '--network', 'none',
                    '--tmpfs', '/app/data', '--env', 'STORAGE_BACKEND=json', '--env', 'NODE_ENV=test',
                    '--env', 'DATABASE_URL=', '--env', 'REDIS_URL=',
                    '--env', 'OPEN_NAME_LOOKUP_API_ENABLED=true',
                    '--env', 'MANAGED_NAME_LOOKUP_ENABLED=true',
                    '--entrypoint', 'node', info['Id'], '--input-type=module', '-e', bootstrap)
    statuses = {}
    for attempt in range(45):
        if run('inspect', '--format', '{{.State.Running}}', container) != 'true':
            raise RuntimeError('isolated container exited; inspect fixture configuration')
        try:
            status = run('exec', container, 'node', '-e', "fetch('http://127.0.0.1:8787/readyz').then(r=>console.log(r.status)).catch(()=>console.log(0))")
            if status == '200':
                break
        except subprocess.CalledProcessError:
            pass
        time.sleep(1)
    else:
        raise RuntimeError('isolated image readiness did not reach 200')
    with zipfile.ZipFile(root / 'cloud-build-context.zip') as z:
        expected = {name: hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist() if name != 'Dockerfile'}
    js = "const fs=require('fs'),c=require('crypto');const names=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(Object.fromEntries(names.map(n=>[n,c.createHash('sha256').update(fs.readFileSync('/app/'+n)).digest('hex')]))));"
    actual = json.loads(run('exec', '-i', container, 'node', '-e', js, input=json.dumps(list(expected))))
    assert actual == expected, 'container source mismatch'
    routes = ['/healthz', '/readyz', '/api-docs.html', '/api-reference.json', '/openapi.json', '/downloads/name-lookup-integration.zip']
    for path in routes:
        status = int(run('exec', container, 'node', '-e', f"fetch('http://127.0.0.1:8787{path}').then(r=>console.log(r.status))"))
        statuses[path] = status
        assert status == 200, path
    unauthorized = int(run('exec', container, 'node', '-e', "fetch('http://127.0.0.1:8787/api/v1/open/name-lookups/prepare',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log(r.status))"))
    assert unauthorized == 401, unauthorized
    # Verify shipped downloads over HTTP, not just their on-disk names.
    for name in ['public/api-reference.json', 'public/openapi.json', 'public/downloads/name-lookup-integration.zip']:
        digest = run('exec', container, 'node', '-e', f"fetch('http://127.0.0.1:8787/{name.removeprefix('public/')}').then(r=>r.arrayBuffer()).then(b=>console.log(require('crypto').createHash('sha256').update(Buffer.from(b)).digest('hex'))) ")
        assert digest == expected[name], name
    evidence = {'version': manifest['version'], 'sourceCommit': manifest['sourceCommit'],
                'imageId': info['Id'], 'tag': tag, 'platform': 'linux/amd64',
                'labels': info['Config']['Labels'], 'node': run('exec', container, 'node', '--version'),
                'isolation': 'network=none; no published ports; ephemeral fixture data and credentials',
                'environment': 'NODE_ENV=test / JSON smoke only; PostgreSQL behavior covered by previous local HTTP regression, not by this smoke',
                'verifiedContainerFiles': len(expected), 'httpStatuses': statuses,
                'unsignedPrepareStatus': unauthorized, 'httpDownloadHashesMatch': True,
                'productionConnections': 0, 'realDeviceQueries': 0}
finally:
    if container:
        subprocess.run([*docker, 'rm', '-f', container], check=True, stdout=subprocess.DEVNULL)
archive = root / 'cloud-image-linux-amd64.tar.gz'
with archive.open('xb') as target:
    with gzip.GzipFile(filename='', fileobj=target, mode='wb', mtime=0) as compressed:
        process = subprocess.Popen([*docker, 'save', tag], stdout=subprocess.PIPE)
        while block := process.stdout.read(1024 * 1024):
            compressed.write(block)
        assert process.wait() == 0, 'docker save failed'
evidence['archive'] = {'file': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'bytes': archive.stat().st_size}
(root / 'IMAGE.json').write_text(json.dumps(evidence, indent=2) + '\n')
print(json.dumps(evidence, indent=2))
