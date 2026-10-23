from pathlib import Path
import argparse,hashlib,json,shutil,subprocess,sys
p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args()
r=Path(__file__).resolve().parents[1];out=Path(a.out).resolve();assert not out.exists()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
subprocess.run([sys.executable,str(r.parent/'lookup-page-recovery-20261023-rc.2/verification/prepare-local.py'),'--out',str(out)],check=True)
for f,h in json.loads((r/'BASELINE.json').read_text())['before'].items():assert (sha(out/f) if (out/f).exists() else None)==h,f
for f,h in json.loads((r/'MANIFEST.json').read_text()).items():
 assert sha(r/f)==h,f
 (out/f).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(r/f,out/f)
for f,h in json.loads((r/'verification/FROZEN.json').read_text()).items():assert sha(out/f)==h,f
print('Admin capacity candidate assembled; parent and unchanged files verified. No production actions.')
