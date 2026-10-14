"""Verify assembled source identity and partner download integrity, offline."""
from pathlib import Path
import hashlib,json,zipfile
r=Path(__file__).resolve().parent.parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
m=json.loads((r/'MANIFEST.json').read_text())
for name,digest in m['files'].items():assert sha(r/name)==digest,name
checks=json.loads((r/'public/downloads/name-lookup-sha256.json').read_text())
assert sha(r/'public/downloads/name-lookup-integration.zip')==checks['zipSha256']
with zipfile.ZipFile(r/'public/downloads/name-lookup-integration.zip') as z:
 for name,digest in checks['files'].items():assert hashlib.sha256(z.read(name)).hexdigest()==digest,name
 assert z.read('node_client.mjs')==(r/'sdk/open_name_lookup/node_client.mjs').read_bytes()
 assert z.read('python_client.py')==(r/'sdk/open_name_lookup/python_client.py').read_bytes()
for name in ['package-lock.json','docs/OPEN_NAME_LOOKUP_API.md','public/assets/login-terminal-bg.png']:
 assert (r/name).is_file(),name
print(json.dumps({'version':m['version'],'verifiedFiles':len(m['files']),'sdkArchiveMatches':True,'productionMutations':0}))
