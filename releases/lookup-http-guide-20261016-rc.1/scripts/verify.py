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
 def request(method,url,headers,data,timeout,allow_redirects):
  import hmac,urllib.parse
  canonical='\n'.join([method,urllib.parse.urlsplit(url).path,headers['X-Timestamp'],headers['X-Nonce'],hashlib.sha256(data or b'').hexdigest()])
  assert headers['X-Signature']==hmac.new(b'mock-secret',canonical.encode(),hashlib.sha256).hexdigest()
  assert method==e['method'] and timeout==30 and not allow_redirects
  if e['async']=='prepare':assert json.loads(data)=={}
  elif e['async']=='submit':assert json.loads(data)=={'phoneNumber':'13800000000'}
  else:assert data is None and url.endswith('/mock-id')
  return type('Response',(),{'status_code':200,'text':'{"ok":true}'})()
 inputs=['13800000000','request-demo-001'] if e['async']=='submit' else ['mock-id'] if e['async']=='result' else ['prepare-demo-001']
 with patch.dict('os.environ',{'CLIENT_ID':'mock-client','CLIENT_SECRET':'mock-secret'}),patch('builtins.input',side_effect=inputs),patch('requests.request',side_effect=request),redirect_stdout(io.StringIO()):
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
for name,digest in json.loads((R/'MANIFEST.json').read_text()).items():assert hashlib.sha256((R/name).read_bytes()).hexdigest()==digest
print('PASS: 33 endpoints / 3 direct HTTP Python examples executed with mock signatures / 3 Node syntax / navigation / source parity / zip / 9 hashes')
