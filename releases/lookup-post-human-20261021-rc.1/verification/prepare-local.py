from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import sys

p = argparse.ArgumentParser()
p.add_argument('--out', required=True)
a = p.parse_args()
r = Path(__file__).resolve().parents[1]
out = Path(a.out).resolve()
assert not out.exists(), 'Use a new isolated output directory'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
m = json.loads((r / 'MANIFEST.json').read_text())
b = json.loads((r / 'BASELINE.json').read_text())
for f, h in m.items():
    assert sha(r / f) == h, f
subprocess.run([sys.executable, str(r.parent / b['parentCandidate'] / 'verification/prepare-local.py'), '--out', str(out)], check=True)
for f, h in b['before'].items():
    if h is None:
        assert not (out / f).exists(), f
    else:
        assert sha(out / f) == h, f
for f in m:
    (out / f).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(r / f, out / f)
frozen = json.loads((r / 'verification/FROZEN.json').read_text())['files']
for f, h in frozen.items():
    assert sha(out / f) == h, f
print(f'Scheduling candidate assembled; {len(frozen)} out-of-scope hashes unchanged. No production access.')
