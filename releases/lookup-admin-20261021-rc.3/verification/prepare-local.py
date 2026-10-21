from pathlib import Path
import argparse,hashlib,json,shutil,subprocess,sys
p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args()
r=Path(__file__).resolve().parents[1];out=Path(a.out).resolve();assert not out.exists(),'Use a new isolated output directory'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
subprocess.run([sys.executable,str(r.parent/'lookup-post-human-20261021-rc.1/verification/prepare-local.py'),'--out',str(out)],check=True)
for name in ['lookup-admin-20261021-rc.1','lookup-admin-20261021-rc.2']:
 layer=r.parent/name;m=json.loads((layer/'MANIFEST.json').read_text());b=json.loads((layer/'BASELINE.json').read_text())
 for f,h in m.items():assert sha(layer/f)==h,(name,f,'source')
 for f,h in b['before'].items():
  assert (sha(out/f) if (out/f).exists() else None)==h,(name,f,'before')
 for f in m:(out/f).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(layer/f,out/f)
 frozen=json.loads((layer/'verification/FROZEN.json').read_text());frozen=frozen.get('files',frozen)
 for f,h in frozen.items():assert sha(out/f)==h,(name,f,'frozen')
 for f,h in m.items():assert sha(out/f)==h,(name,f,'after')
m=json.loads((r/'MANIFEST.json').read_text());b=json.loads((r/'BASELINE.json').read_text())
for f,h in m.items():assert sha(r/f)==h,(f,'rc3 source')
for f,h in b['before'].items():assert sha(out/f)==h,(f,'rc3 before')
for f in m:shutil.copyfile(r/f,out/f)
for f,h in json.loads((r/'PRODUCTION_DIFF.json').read_text()).items():assert sha(out/f)==h['after'],(f,'final production diff')
print('Final rc.3 assembled; all layers, out-of-scope files and final production diff verified. No production actions.')
