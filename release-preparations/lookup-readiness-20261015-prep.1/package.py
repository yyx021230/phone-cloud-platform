"""Offline immutable release packaging. Never connects to production or starts services."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
VERSION = 'lookup-readiness-20261015-rc.1'
COMMIT = 'fda9967e0b5e441f750c7bdae94e07be6cd86235'
BASE = 'lookup-delivery-20261014-rc.1'
sha = lambda data: hashlib.sha256(data).hexdigest()


def archive(path, files):
    with zipfile.ZipFile(path, 'x', compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in sorted(files.items()):
            assert not name.startswith('/') and '..' not in Path(name).parts
            info = zipfile.ZipInfo(name, (2026, 10, 15, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, data)
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None
        assert set(z.namelist()) == set(files)
        for name, data in files.items():
            assert z.read(name) == data, name
    return {'sha256': sha(path.read_bytes()), 'bytes': path.stat().st_size,
            'files': {name: sha(data) for name, data in sorted(files.items())}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    out = Path(args.out).expanduser().resolve()
    assert not out.exists(), 'refuse to overwrite existing release artifacts'
    assert subprocess.check_output(['git', 'rev-parse', VERSION + '^{commit}'], cwd=REPO, text=True).strip() == COMMIT
    with tempfile.TemporaryDirectory(prefix='lookup-release-pack-') as temp:
        roots = {}
        for tag in [BASE, VERSION]:
            root = Path(temp) / tag
            subprocess.run([sys.executable, str(REPO / 'releases' / tag / 'verification/prepare-local.py'), '--out', str(root)], check=True)
            subprocess.run([sys.executable, str(root / 'verification/verify-candidate.py')], check=True)
            roots[tag] = root
        source, baseline = roots[VERSION], roots[BASE]
        manifest = json.loads((source / 'MANIFEST.json').read_text())['files']
        full = {name: (source / name).read_bytes() for name in manifest}
        full['MANIFEST.json'] = (source / 'MANIFEST.json').read_bytes()
        version = json.loads(full['VERSION.json'])
        changes = {}
        for name in version['overlayFiles']:
            if name.endswith('.test.mjs') or Path(name).name.startswith('test_'):
                continue
            component = 'windows' if name.startswith('windows-agent/') else 'cloud' if name.startswith(('server/', 'public/', 'docs/')) else None
            if component:
                old = baseline / name
                changes[name] = {'component': component, 'before': sha(old.read_bytes()) if old.exists() else None, 'after': sha(full[name])}
        assert sum(row['component'] == 'cloud' for row in changes.values()) == 16
        assert sum(row['component'] == 'windows' for row in changes.values()) == 4
        receipt = json.loads((REPO / 'docs/evidence/LOOKUP_DELIVERY_DEPLOYMENT_20261015.json').read_text())
        observed = {**receipt['cloudRuntimeFiles'], **receipt['agentFiles']}
        for name, row in changes.items():
            if name in observed:
                assert row['before'] == observed[name], 'historical production mismatch: ' + name
            row['baselineEvidence'] = 'committed-production-receipt' if name in observed else 'immutable-baseline-source; verify actual file before deployment'
        for name in ['package.json', 'package-lock.json', 'windows-agent/package.json', 'windows-agent/package-lock.json', 'requirements-visual-lookup.txt']:
            assert (source / name).read_bytes() == (baseline / name).read_bytes(), name
        dockerfile = full['Dockerfile'].decode()
        dockerfile = dockerfile.replace('LABEL org.opencontainers.image.version="platform-core-20261014-rc.2"',
            f'LABEL org.opencontainers.image.version="{VERSION}"\nLABEL org.opencontainers.image.revision="{COMMIT}"')
        assert f'LABEL org.opencontainers.image.version="{VERSION}"' in dockerfile
        context = {name: data for name, data in full.items() if name.startswith(('server/', 'public/', 'docs/')) or name in ['package.json', 'package-lock.json', 'VERSION.json']}
        context['Dockerfile'] = dockerfile.encode()
        windows = {name.removeprefix('windows-agent/'): full[name] for name, row in changes.items() if row['component'] == 'windows'}
        rollback = {name: (baseline / name).read_bytes() for name, row in changes.items() if row['before'] is not None}
        simulated = {name: full[name] for name in changes}
        for name, row in changes.items():
            assert sha(simulated[name]) == row['after']
            if row['before'] is None:
                del simulated[name]
            else:
                simulated[name] = rollback[name]
                assert sha(simulated[name]) == row['before']
        out.mkdir(parents=True, mode=0o700)
        sets = {'combined-source.zip': full, 'cloud-build-context.zip': context,
                'windows-agent-overlay.zip': windows, 'rollback-source-reference.zip': rollback}
        artifacts = {name: archive(out / name, files) for name, files in sets.items()}
        plan = {'version': VERSION, 'sourceCommit': COMMIT, 'status': 'local-prepared-not-deployed',
                'baselineTag': BASE, 'baselineCommit': '509bea2ef12f4c26325a8b7bb5098f16fc4c7c98',
                'historicalProductionRelease': receipt['version'], 'historicalRollbackImage': receipt['imageId'],
                'requiresFreshProductionBackup': True, 'databaseMigrations': [], 'dependencyChanges': False,
                'changes': changes, 'artifacts': artifacts,
                'verification': {'archiveRoundTrip': True, 'rollbackSourceRoundTrip': True, 'runtimeFiles': 20,
                                 'sourceManifestFiles': len(manifest), 'productionConnections': 0}}
        (out / 'ARTIFACTS.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'out': str(out), 'archives': len(artifacts), 'cloudFiles': 16, 'windowsFiles': 4, 'sourceFiles': len(manifest)}))


if __name__ == '__main__':
    main()
