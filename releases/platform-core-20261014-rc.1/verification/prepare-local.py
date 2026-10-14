"""Compose the verified core candidate. No services, installation or deployment."""
from pathlib import Path
import argparse, hashlib, json, shutil, subprocess, sys

p=argparse.ArgumentParser();p.add_argument('--out');a=p.parse_args()
r=Path(__file__).resolve().parent.parent;v=json.loads((r/'VERSION.json').read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
base=r.parent/v['baseTag'];recovery=r.parent/v['recoveryTag']
assert sha(base/'MANIFEST.json')==v['baseManifestSha256']
assert sha(recovery/'verification/MANIFEST.json')==v['recoveryManifestSha256']
for name,digest in json.loads((r/'MANIFEST.json').read_text())['files'].items():
 assert sha(r/name)==digest,name
if a.out:
 out=Path(a.out).expanduser().resolve();assert not out.exists(),'output already exists'
 subprocess.run([sys.executable,str(base/'verification/prepare-local.py'),'--out',str(out)],check=True,stdout=subprocess.DEVNULL)
 for name in v['overlayFiles']:
  target=out/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(r/name,target)
 for name in ['VERSION.json','README.md','RELEASE_NOTES.md']:
  shutil.copyfile(r/name,out/name)
 frozen=json.loads((recovery/'verification/MANIFEST.json').read_text())['frozenBaselineFilesUnchanged']
 for row in frozen:assert sha(out/row['path'])==row['sha256'],row['path']
 # Actual production browser bundles are retained, never rebuilt from old sources.
 production=json.loads((r/'verification/cloud-runtime-full-hashes.json').read_text())['files']
 for name,digest in production.items():
  if name.startswith('public/vendor/') and (name.endswith('.js') or name.endswith('.wasm')) and not Path(name).name.startswith('._'):
   assert sha(out/name)==digest,name
 files={str(f.relative_to(out)):sha(f) for f in sorted(out.rglob('*')) if f.is_file() and f!=out/'MANIFEST.json'}
 (out/'MANIFEST.json').write_text(json.dumps({'version':v['version'],'status':v['status'],'files':files},indent=2)+'\n')
 print(json.dumps({'version':v['version'],'assembledFiles':len(files),'frozenFilesVerified':len(frozen),'productionMutations':0}))
else:
 subprocess.run([sys.executable,str(base/'verification/prepare-local.py')],check=True,stdout=subprocess.DEVNULL)
 print(json.dumps({'verified':v['version'],'productionMutations':0}))
