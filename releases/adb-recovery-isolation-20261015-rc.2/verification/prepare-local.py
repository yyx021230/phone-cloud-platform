"""Verify immutable sources and assemble into a new directory; never start services."""
from pathlib import Path
import argparse, hashlib, json, shutil, subprocess, sys
p=argparse.ArgumentParser();p.add_argument('--out',required=True);args=p.parse_args()
r=Path(__file__).resolve().parent.parent;v=json.loads((r/'VERSION.json').read_text());base=r.parent/v['baseTag']
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(base/'MANIFEST.json')==v['baseManifestSha256'],'base manifest changed'
for name,digest in json.loads((r/'MANIFEST.json').read_text())['files'].items():
    assert sha(r/name)==digest,name
out=Path(args.out).expanduser().resolve();assert not out.exists(),'output must not exist'
subprocess.run([sys.executable,str(base/'verification/prepare-local.py'),'--out',str(out)],check=True,stdout=subprocess.DEVNULL)
for name in v['overlayFiles']+['VERSION.json','README.md','RELEASE_NOTES.md','DRIVER_PLAN.md','verification/RESULTS.json','verification/FROZEN.json']:
    dest=out/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(r/name,dest)
for row in json.loads((r/'verification/FROZEN.json').read_text())['files']:
    assert sha(out/row['path'])==row['sha256'],row['path']
files={str(f.relative_to(out)):sha(f) for f in sorted(out.rglob('*')) if f.is_file() and f!=out/'MANIFEST.json'}
(out/'MANIFEST.json').write_text(json.dumps({'version':v['version'],'status':v['status'],'files':files},indent=2)+'\n')
print(json.dumps({'version':v['version'],'assembledFiles':len(files),'productionActions':0}))
