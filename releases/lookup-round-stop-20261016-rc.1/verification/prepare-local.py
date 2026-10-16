from pathlib import Path
import argparse,hashlib,json,subprocess,sys,shutil
p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args()
r=Path(__file__).resolve().parents[1];out=Path(a.out).resolve();assert not out.exists()
m=json.loads((r/'MANIFEST.json').read_text())
for f,h in m.items():assert hashlib.sha256((r/f).read_bytes()).hexdigest()==h,f
subprocess.run([sys.executable,str(r.parent/'lookup-auto-recovery-20261016-rc.1/verification/prepare-local.py'),'--out',str(out)],check=True)
for f,h in json.loads((r/'BASELINE.json').read_text())['before'].items():
 if h is None:assert not (out/f).exists(),f
 else:assert hashlib.sha256((out/f).read_bytes()).hexdigest()==h,f
for f in m:
 (out/f).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(r/f,out/f)
for f,h in json.loads((r/'verification/FROZEN.json').read_text())['files'].items():assert hashlib.sha256((out/f).read_bytes()).hexdigest()==h,f
print('Assembled round-stop candidate; no dependency installation or production access')
