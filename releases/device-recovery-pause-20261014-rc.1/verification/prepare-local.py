"""Verify and assemble the immutable combined candidate. No services or deployment."""
from pathlib import Path
import argparse,hashlib,json,shutil,subprocess,sys
p=argparse.ArgumentParser();p.add_argument('--out');a=p.parse_args()
r=Path(__file__).resolve().parent.parent;v=json.loads((r/'VERSION.json').read_text());base=r.parent/v['baseTag']
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(base/'MANIFEST.json')==v['baseManifestSha256'],'parent changed'
for name,digest in json.loads((r/'MANIFEST.json').read_text())['files'].items():assert sha(r/name)==digest,name
args=[sys.executable,str(base/'verification/prepare-local.py')]
if a.out:
 out=Path(a.out).expanduser().resolve();assert not out.exists(),'output already exists';args+=['--out',str(out)]
subprocess.run(args,check=True,stdout=subprocess.DEVNULL)
if a.out:
 for name in v['overlayFiles']+['VERSION.json','README.md','RELEASE_NOTES.md','verification/RESULTS.json','verification/FROZEN.json','verification/BUILD.json']:
  target=out/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(r/name,target)
 frozen=json.loads((r/'verification/FROZEN.json').read_text())
 for row in frozen['protectedSource']+frozen['productionBundles']:assert sha(out/row['path'])==row['sha256'],row['path']
 files={str(f.relative_to(out)):sha(f) for f in sorted(out.rglob('*')) if f.is_file() and f!=out/'MANIFEST.json'}
 (out/'MANIFEST.json').write_text(json.dumps({'version':v['version'],'status':v['status'],'files':files},indent=2)+'\n')
 print(json.dumps({'version':v['version'],'assembledFiles':len(files),'productionActions':0}))
else:print(json.dumps({'verified':v['version'],'productionActions':0}))
