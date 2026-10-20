from pathlib import Path
import argparse,hashlib,json,subprocess,sys,shutil
p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args();r=Path(__file__).resolve().parents[1];out=Path(a.out).resolve();assert not out.exists()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
m=json.loads((r/'MANIFEST.json').read_text())
for f,h in m.items():assert sha(r/f)==h,f
subprocess.run([sys.executable,str(r.parent/'lookup-idle-refresh-20261020-rc.2/verification/prepare-local.py'),'--out',str(out)],check=True)
for f,h in json.loads((r/'BASELINE.json').read_text())['before'].items():
 if h is None:assert not (out/f).exists(),f
 else:assert sha(out/f)==h,f
for f in m:
 (out/f).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(r/f,out/f)
for f,h in json.loads((r/'verification/FROZEN.json').read_text())['files'].items():assert sha(out/f)==h,f
shutil.copyfile(r/'verification/retained-capacity-http.mjs',out/'verification/retained-capacity-http.mjs')
print('Assembled bounded retained-capacity candidate; no production or dependency installation')
