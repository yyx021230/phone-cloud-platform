from pathlib import Path
import argparse,hashlib,json,shutil,subprocess,sys
p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args()
r=Path(__file__).resolve().parents[1];out=Path(a.out).resolve();assert not out.exists(),'Use a fresh output directory'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
subprocess.run([sys.executable,str(r.parent/'lookup-throughput-20261022-rc.2/verification/prepare-local.py'),'--out',str(out)],check=True)
m=json.loads((r/'MANIFEST.json').read_text());b=json.loads((r/'BASELINE.json').read_text())
for f,h in m.items():assert sha(r/f)==h,(f,'source')
for f,h in b['before'].items():assert (sha(out/f) if (out/f).exists() else None)==h,(f,'before')
for f in m:(out/f).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(r/f,out/f)
for f,h in json.loads((r/'verification/FROZEN.json').read_text()).items():assert sha(out/f)==h,(f,'frozen')
for f,h in json.loads((r/'PRODUCTION_DIFF.json').read_text()).items():assert sha(out/f)==h['after'],(f,'production diff')
print('Throughput rc.3 assembled; parent, changes and all out-of-scope files verified. No production actions.')
