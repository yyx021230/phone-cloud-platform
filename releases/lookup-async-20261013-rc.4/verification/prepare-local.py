"""Verify immutable rc.1–rc.4 and optionally compose a fresh local candidate."""
from pathlib import Path
import argparse,hashlib,json,shutil,subprocess,sys
p=argparse.ArgumentParser();p.add_argument('--out',help='New nonexistent local directory');args=p.parse_args()
r=Path(__file__).resolve().parent.parent;v=json.loads((r/'VERSION.json').read_text());sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for name,digest in v['baseManifestHashes'].items():assert sha(r.parent/name/'MANIFEST.json')==digest,name
subprocess.run([sys.executable,str(r.parent/'lookup-async-20261013-rc.3/verification/prepare-local.py')],check=True)
for name,digest in json.loads((r/'MANIFEST.json').read_text())['files'].items():assert sha(r/name)==digest,name
assert not any((r/n).exists() for n in ['windows-agent','screen-client','deploy'])
assert set(v['overlayFiles'])=={'server/managed-lookup.mjs','server/managed-lookup-platform.mjs','OPEN_NAME_LOOKUP_API.md','sdk/open_name_lookup/README.md','scripts/build-managed-lookup-docs.py','public/api-reference.json','public/openapi.json','public/downloads/name-lookup-openapi.json','public/downloads/name-lookup-integration.zip','public/downloads/name-lookup-sha256.json'}
if args.out:
 out=Path(args.out).expanduser().resolve();assert not out.exists(),'output must be a new directory'
 subprocess.run([sys.executable,str(r.parent/'lookup-async-20261013-rc.3/verification/prepare-local.py'),'--out',str(out)],check=True)
 for name in v['overlayFiles']+['server/managed-lookup-result-race.test.mjs','verification/result-race-postgres.mjs']:
  (out/name).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(r/name,out/name)
 shutil.copyfile(r/'README.md',out/'README.md')
 (out/'VERSION.json').write_text(json.dumps({**v,'candidateKind':'local assembled immutable rc.1 + rc.2 + rc.3 + rc.4'},indent=2)+'\n')
 files={str(f.relative_to(out)):sha(f) for f in sorted(out.rglob('*')) if f.is_file() and f!=out/'MANIFEST.json'}
 (out/'MANIFEST.json').write_text(json.dumps({'version':v['version'],'files':files},indent=2)+'\n')
print(json.dumps({'verifiedChain':list(v['baseManifestHashes'])+[r.name],'assembled':bool(args.out),'AgentMediaUnchanged':True,'productionConnections':0}))
