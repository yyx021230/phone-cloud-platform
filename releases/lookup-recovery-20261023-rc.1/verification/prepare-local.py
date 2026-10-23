from pathlib import Path
import argparse, hashlib, json, shutil, subprocess, sys

p = argparse.ArgumentParser()
p.add_argument('--out', required=True)
a = p.parse_args()
r = Path(__file__).resolve().parents[1]
out = Path(a.out).resolve()
assert not out.exists(), 'Output must be a new directory'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
subprocess.run([sys.executable, str(r.parent / 'lookup-ai-vision-20261022-rc.1/verification/prepare-local.py'), '--out', str(out)], check=True)
b = json.loads((r / 'BASELINE.json').read_text())
m = json.loads((r / 'MANIFEST.json').read_text())
for f, h in m.items():
    assert sha(r / f) == h, (f, 'candidate')
for f, h in b['before'].items():
    assert (sha(out / f) if (out / f).exists() else None) == h, (f, 'baseline')
for f in m:
    (out / f).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(r / f, out / f)
for f, h in json.loads((r / 'verification/FROZEN.json').read_text()).items():
    assert sha(out / f) == h, (f, 'frozen')
print('Recovery candidate assembled; production parent, scoped changes and frozen hashes verified. No production actions.')
