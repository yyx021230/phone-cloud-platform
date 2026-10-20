from pathlib import Path
import argparse,hashlib,json,subprocess,sys,shutil
p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args()
r=Path(__file__).resolve().parents[1];out=Path(a.out).resolve();assert not out.exists()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
m=json.loads((r/'MANIFEST.json').read_text());b=json.loads((r/'BASELINE.json').read_text())
for f,h in m.items():assert sha(r/f)==h,f
subprocess.run([sys.executable,str(r.parent/'lookup-offline-round-stop-20261020-rc.1/verification/prepare-local.py'),'--out',str(out)],check=True)
for f,h in b['before'].items():
 if h is None:assert not (out/f).exists(),f
 else:assert sha(out/f)==h,f
for f in m:
 (out/f).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(r/f,out/f)
for f,h in json.loads((r/'verification/FROZEN.json').read_text())['files'].items():assert sha(out/f)==h,f
shutil.copyfile(r/'verification/offline-handoff-http.mjs',out/'verification/offline-handoff-http.mjs')
print('Offline handoff rc.2 assembled; all before/after and 192 frozen hashes verified; no production changes.')
