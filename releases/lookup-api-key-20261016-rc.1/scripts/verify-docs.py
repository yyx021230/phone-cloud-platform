"""Offline validation of the published-facing guide; no external calls."""
import hashlib
import io
import json
import py_compile
import subprocess
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

R=Path(__file__).resolve().parents[1]
P=R/'public'
d=json.loads((P/'api-reference.json').read_text())
lookup=[e for e in d['endpoints'] if e['group']=='lookup-user']
assert len(lookup)==3 and len(d['endpoints'])==33
ids={e['id'] for e in d['endpoints']}|{g['id'] for g in d['guides']}
for g in d['guides']:
 for sec in g.get('sections',[]):
  for link in sec.get('links',[]):
   if link['href'].startswith('#'): assert link['href'][1:] in ids,link
for e in lookup:
 code=e['httpExamples']['Python']
 assert 'requests.request(' in code and 'client.' not in code and 'savedLookup' not in code
 def request(method,url,headers,json,timeout,allow_redirects):
  assert headers['X-API-Key']=='mock-key'
  assert all(h not in headers for h in ['X-Signature','X-Client-Id','X-Timestamp','X-Nonce'])
  assert method==e['method'] and timeout==30 and not allow_redirects
  if e['async']=='prepare':assert json=={}
  elif e['async']=='submit':assert json=={'phoneNumber':'13800000000'}
  else:assert json is None and url.endswith('/mock-id')
  return type('Response',(),{'status_code':200,'text':'{"ok":true}'})()
 inputs=['request-demo-001','13800000000'] if e['async']=='submit' else ['mock-id'] if e['async']=='result' else ['prepare-demo-001']
 with patch.dict('os.environ',{'API_KEY':'mock-key'}),patch('builtins.input',side_effect=inputs),patch('requests.request',side_effect=request),redirect_stdout(io.StringIO()):
  exec(compile(code,e['id'], 'exec'),{})
 with tempfile.NamedTemporaryFile(suffix='.mjs') as f:
  f.write(e['httpExamples']['Node.js'].encode());f.flush();subprocess.run(['node','--check',f.name],check=True)
py=next(g for g in d['guides'] if g['id']=='lookup-python')['sections'][-1]['code']
assert py==(P/'downloads/lookup.py').read_text()
checks=json.loads((P/'downloads/name-lookup-sha256.json').read_text())
archive=P/'downloads/name-lookup-integration.zip'
assert hashlib.sha256(archive.read_bytes()).hexdigest()==checks['zipSha256']
with ZipFile(archive) as z:
 assert set(z.namelist())==set(checks['files'])
 for name,digest in checks['files'].items():assert hashlib.sha256(z.read(name)).hexdigest()==digest
 for name in ['lookup.py','lookup.mjs']:assert z.read(name)==(P/'downloads'/name).read_bytes()
api=json.loads((P/'downloads/name-lookup-openapi.json').read_text())
assert len(api['paths'])==3
for ops in api['paths'].values():
 for op in ops.values():
  assert op['security']==[{'LookupApiKey':[]}]
  assert not any(p.get('name','').lower() in ['x-client-id','x-timestamp','x-nonce','x-signature'] for p in op.get('parameters',[]))
for e in lookup:
 assert e['auth']=='api-key'
 assert 'CLIENT_ID' not in e['httpExamples']['Python']
assert 'X-API-Key: <API_KEY>' in (P/'api-docs.js').read_text()
print('PASS: 33 endpoints / 3 Python HTTP snippets executed / 3 Node syntax / navigation / source parity / zip / OpenAPI one-key security')
