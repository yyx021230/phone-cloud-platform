"""Verify and compose the immutable async candidate chain; no services."""
from pathlib import Path
import argparse, hashlib, json, shutil, subprocess, sys
p=argparse.ArgumentParser();p.add_argument('--out');a=p.parse_args()
r=Path(__file__).resolve().parent.parent;v=json.loads((r/'VERSION.json').read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
b=r.parent/v['baseTag'];assert sha(b/'MANIFEST.json')==v['baseManifestSha256']
for name,digest in json.loads((r/'MANIFEST.json').read_text())['files'].items():assert sha(r/name)==digest,name
subprocess.run([sys.executable,str(b/'verification/prepare-local.py')],check=True)
if a.out:
 out=Path(a.out).expanduser().resolve();assert not out.exists()
 subprocess.run([sys.executable,str(b/'verification/prepare-local.py'),'--out',str(out)],check=True)
 for name,digest in v['baseFileHashes'].items():assert sha(out/name)==digest,name
 for name in v['overlayFiles']+v['testFiles']:
  (out/name).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(r/name,out/name)
 shutil.copyfile(r/'VERSION.json',out/'VERSION.json')
 files={str(f.relative_to(out)):sha(f) for f in sorted(out.rglob('*')) if f.is_file() and f!=out/'MANIFEST.json'}
 (out/'MANIFEST.json').write_text(json.dumps({'version':v['version'],'files':files},indent=2)+'\n')
print(json.dumps({'verified':v['version'],'assembled':bool(a.out),'productionActions':0}))
