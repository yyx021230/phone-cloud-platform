from pathlib import Path
import argparse,hashlib,json,shutil,subprocess,sys
p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args()
r=Path(__file__).resolve().parents[1];out=Path(a.out).resolve();assert not out.exists()
for name,digest in json.loads((r/'MANIFEST.json').read_text()).items():assert hashlib.sha256((r/name).read_bytes()).hexdigest()==digest,name
base=r.parent/'lookup-readiness-20261016-rc.16'
subprocess.run([sys.executable,str(base/'verification/prepare-local.py'),'--out',str(out)],check=True)
for name,digest in json.loads((r/'BASELINE.json').read_text())['before'].items():assert hashlib.sha256((out/name).read_bytes()).hexdigest()==digest,name
for source in [r.parent/'lookup-http-guide-20261016-rc.1/public',r/'public']:
 shutil.copytree(source,out/'public',dirs_exist_ok=True)
for source in (r/'server').glob('*.mjs'):shutil.copyfile(source,out/'server'/source.name)
shutil.copyfile(r/'verification/api-key-http.mjs',out/'verification/api-key-http.mjs')
print('Assembled API Key candidate; no production connections or dependencies installed')
