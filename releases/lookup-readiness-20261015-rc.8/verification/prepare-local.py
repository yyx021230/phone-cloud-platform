from pathlib import Path
import argparse,json,hashlib,subprocess,sys,shutil
p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args()
r=Path(__file__).resolve().parent.parent;v=json.loads((r/'VERSION.json').read_text());b=r.parent/v['baseTag'];sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(b/'MANIFEST.json')==v['baseManifestSha256']
for n,h in json.loads((r/'MANIFEST.json').read_text())['files'].items():assert sha(r/n)==h,n
out=Path(a.out).resolve();assert not out.exists()
subprocess.run([sys.executable,str(b/'verification/prepare-local.py'),'--out',str(out)],check=True)
for n in v['overlayFiles']:
 d=out/n;d.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(r/n,d)
print(json.dumps({'version':v['version'],'overlayCount':len(v['overlayFiles']),'productionActions':0}))
