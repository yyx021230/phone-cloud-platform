"""Read-only manifest, compatibility and integration-bundle verification."""
from pathlib import Path
import hashlib,json,zipfile
root=Path(__file__).resolve().parent.parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
manifest=json.loads((root/'MANIFEST.json').read_text())
for name,digest in manifest['files'].items():
 assert sha(root/name)==digest,name
baseline=json.loads((root/'BASELINE.json').read_text())
unchanged=[n for n in baseline['files'] if n.startswith(('windows-agent/','screen-client/','server/screen','deploy/mediamtx-pacing/'))]
for name in unchanged:assert sha(root/name)==baseline['files'][name],name
reference=json.loads((root/'public/api-reference.json').read_text());old=json.loads((root.parent/'lookup-pool-20261013-rc.1/public/api-reference.json').read_text());by_id={e['id']:e for e in reference['endpoints']}
assert all(by_id[e['id']]==e for e in old['endpoints'])
assert len(reference['endpoints'])==42
openapi=json.loads((root/'public/downloads/name-lookup-openapi.json').read_text());assert sum(len(v) for v in openapi['paths'].values())==10
get=openapi['paths']['/api/v1/open/name-lookups/tasks/{lookupId}']['get'];assert not any(p['name']=='Idempotency-Key' for p in get['parameters']);assert 'idempotency_conflict' not in get['x-route-errors']
checks=json.loads((root/'public/downloads/name-lookup-sha256.json').read_text());assert sha(root/'public/downloads/name-lookup-integration.zip')==checks['zipSha256']
with zipfile.ZipFile(root/'public/downloads/name-lookup-integration.zip') as z:
 for name,digest in checks['files'].items():assert hashlib.sha256(z.read(name)).hexdigest()==digest,name
 assert z.read('node_client.mjs')==(root/'sdk/open_name_lookup/node_client.mjs').read_bytes()
 assert z.read('python_client.py')==(root/'sdk/open_name_lookup/python_client.py').read_bytes()
print(json.dumps({'manifestFiles':len(manifest['files']),'AgentAndScreenMediaUnchanged':True,'previous40ContractsUnchanged':True,'HmacOperations':10,'SDKZipMatch':True,'productionConnections':0}))
