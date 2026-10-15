"""Read-only archive verification; supports OCI manifest IDs and classic config IDs."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('directory')
args = parser.parse_args()
root = Path(args.directory).expanduser().resolve()
sha = lambda b: hashlib.sha256(b).hexdigest()
manifest = json.loads((root / 'ARTIFACTS.json').read_text())
for name, row in manifest['artifacts'].items():
    assert sha((root / name).read_bytes()) == row['sha256'], name
    with zipfile.ZipFile(root / name) as z:
        assert set(z.namelist()) == set(row['files']), name
        for member, digest in row['files'].items():
            assert sha(z.read(member)) == digest, member
image = json.loads((root / 'IMAGE.json').read_text())
archive = root / image['archive']['file']
assert sha(archive.read_bytes()) == image['archive']['sha256']
with tarfile.open(archive, 'r:gz') as tar:
    rows = json.load(tar.extractfile('manifest.json'))
    assert len(rows) == 1
    row = rows[0]
    assert row['RepoTags'] == [image['tag']]
    config_bytes = tar.extractfile(row['Config']).read()
    config_id = 'sha256:' + sha(config_bytes)
    config = json.loads(config_bytes)
    assert config['architecture'] == 'amd64' and config['os'] == 'linux'
    assert config['config']['Labels'] == image['labels']
    manifests = []
    if 'index.json' in tar.getnames():
        index = json.load(tar.extractfile('index.json'))
        for entry in index['manifests']:
            payload = tar.extractfile('blobs/sha256/' + entry['digest'].split(':')[1]).read()
            assert 'sha256:' + sha(payload) == entry['digest']
            spec = json.loads(payload)
            assert spec['config']['digest'] == config_id
            assert ['blobs/sha256/' + layer['digest'].split(':')[1] for layer in spec['layers']] == row['Layers']
            for layer in spec['layers']:
                stream = tar.extractfile('blobs/sha256/' + layer['digest'].split(':')[1])
                digest = hashlib.sha256()
                while block := stream.read(1024 * 1024):
                    digest.update(block)
                assert 'sha256:' + digest.hexdigest() == layer['digest']
            manifests.append(entry['digest'])
    else:
        for name in row['Layers']:
            stream = tar.extractfile(name)
            while stream.read(1024 * 1024):
                pass
    assert image['imageId'] in [config_id, *manifests]
print(json.dumps({'sourceArchivesVerified': len(manifest['artifacts']), 'imageArchiveVerified': True,
                  'imageConfigDigest': config_id, 'imageManifestDigests': manifests,
                  'layersVerified': len(row['Layers']), 'productionConnections': 0}, indent=2))
