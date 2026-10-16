from pathlib import Path
import argparse, hashlib, json, shutil, subprocess, sys
p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args()
r=Path(__file__).resolve().parents[1];out=Path(a.out).resolve();assert not out.exists()
for name,digest in json.loads((r/'MANIFEST.json').read_text()).items():
 assert hashlib.sha256((r/name).read_bytes()).hexdigest()==digest,name
base=r.parent/'lookup-api-key-20261016-rc.1'
subprocess.run([sys.executable,str(base/'verification/prepare-local.py'),'--out',str(out)],check=True)
rc2=r.parent/'lookup-api-key-20261016-rc.2'
for name,digest in json.loads((rc2/'MANIFEST.json').read_text()).items():
 assert hashlib.sha256((rc2/name).read_bytes()).hexdigest()==digest,name
shutil.copytree(rc2/'public',out/'public',dirs_exist_ok=True)
for name,digest in json.loads((r/'BASELINE.json').read_text())['before'].items():
 assert hashlib.sha256((out/name).read_bytes()).hexdigest()==digest,name
for directory in ['server','public']:
 shutil.copytree(r/directory,out/directory,dirs_exist_ok=True)
shutil.copyfile(r/'verification/account-offline-http.mjs',out/'verification/account-offline-http.mjs')
for name,digest in json.loads((r/'verification/FROZEN.json').read_text())['files'].items():
 assert hashlib.sha256((out/name).read_bytes()).hexdigest()==digest,name
print('Assembled local account-offline candidate; no production connections or dependency installation')
