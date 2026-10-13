"""Verify the immutable chain; optionally compose it into a new local directory."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('--out', help='New, nonexistent local test directory; never a production checkout')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
base = root.parent / 'lookup-async-20261013-rc.1'
sdk = root.parent / 'lookup-async-20261013-rc.2'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
version = json.loads((root / 'VERSION.json').read_text())
for release in (base, sdk, root):
    manifest = json.loads((release / 'MANIFEST.json').read_text())
    for name, digest in manifest['files'].items():
        assert sha(release / name) == digest, (release.name, name)
for release in (base, sdk):
    assert sha(release / 'MANIFEST.json') == version['baseManifestHashes'][release.name]
assert set(version['overlayFiles']) == {'server/managed-lookup.mjs', 'server/managed-lookup-platform.mjs'}
assert not any((root / n).exists() for n in ('windows-agent', 'screen-client', 'deploy'))
if args.out:
    out = Path(args.out).expanduser().resolve()
    assert not out.exists(), 'output must be a new directory'
    shutil.copytree(base, out)
    for name in json.loads((sdk / 'VERSION.json').read_text())['overlayFiles']:
        shutil.copyfile(sdk / name, out / name)
    for name in version['overlayFiles'] + ['server/managed-lookup-isolation.test.mjs', 'verification/device-isolation-postgres.mjs']:
        (out / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / name, out / name)
    # The assembled tree must not present the base VERSION/MANIFEST as its own.
    shutil.copyfile(root / 'README.md', out / 'README.md')
    (out / 'VERSION.json').write_text(json.dumps({**version, 'candidateKind': 'local assembled rc.1 + SDK rc.2 + isolation rc.3'}, indent=2) + '\n')
    files = {str(p.relative_to(out)): sha(p) for p in sorted(out.rglob('*')) if p.is_file() and p != out / 'MANIFEST.json'}
    (out / 'MANIFEST.json').write_text(json.dumps({'version': version['version'], 'files': files}, indent=2) + '\n')
print(json.dumps({'verifiedChain': [base.name, sdk.name, root.name], 'AgentMediaUnchanged': True, 'assembled': bool(args.out), 'productionConnections': 0}))
