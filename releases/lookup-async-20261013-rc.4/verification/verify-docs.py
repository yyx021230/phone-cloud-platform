"""Verify the new-integration contract and every packaged SDK byte locally."""
from pathlib import Path
import hashlib,json,zipfile
r=Path(__file__).resolve().parent.parent
base=r.parent/'lookup-async-20261013-rc.1';sdk=r.parent/'lookup-async-20261013-rc.2'
sha=lambda b:hashlib.sha256(b).hexdigest()
read=lambda p:json.loads(p.read_text())
doc=(r/'OPEN_NAME_LOOKUP_API.md').read_text();new=doc.split('## 兼容附录A')[0]
assert '新接入优先使用上面的同步接口' not in doc
for text in ['POST /api/v1/open/name-lookups/tasks','GET /api/v1/open/name-lookups/tasks/{lookupId}','不等其余号码完成','不重新入队','HTTP200','尚未上线']:assert text in new
ref=read(r/'public/api-reference.json');oldref=read(base/'public/api-reference.json')
assert len(ref['endpoints'])==42
legacy=lambda d:[e for e in d['endpoints'] if e.get('async') not in ['submit','result']]
assert len(legacy(ref))==40 and legacy(ref)==legacy(oldref)
api=read(r/'public/openapi.json');old=read(base/'public/openapi.json');paths=['/api/v1/open/name-lookups/tasks','/api/v1/open/name-lookups/tasks/{lookupId}']
assert {k:v for k,v in api['paths'].items() if k not in paths}=={k:v for k,v in old['paths'].items() if k not in paths}
for path in paths:
 method='get' if '{lookupId}' in path else 'post'
 for section in ['requestBody','parameters','responses','security']:
  assert api['paths'][path][method].get(section)==old['paths'][path][method].get(section)
small=read(r/'public/downloads/name-lookup-openapi.json');assert sum(len(v) for v in small['paths'].values())==10
meta=read(r/'public/downloads/name-lookup-sha256.json');bundle=r/'public/downloads/name-lookup-integration.zip';assert sha(bundle.read_bytes())==meta['zipSha256']
with zipfile.ZipFile(bundle) as z:
 hashes=json.loads(z.read('SHA256.json'));assert hashes==meta['files']
 for name,digest in hashes.items():assert sha(z.read(name))==digest
 for name,p in {'OPEN_NAME_LOOKUP_API.md':r/'OPEN_NAME_LOOKUP_API.md','README.md':r/'sdk/open_name_lookup/README.md','openapi.json':r/'public/downloads/name-lookup-openapi.json','node_client.mjs':sdk/'sdk/open_name_lookup/node_client.mjs','python_client.py':base/'sdk/open_name_lookup/python_client.py','sign.mjs':base/'public/downloads/sign.mjs'}.items():assert z.read(name)==p.read_bytes(),name
print(json.dumps({'platformOperations':42,'hmacOperations':10,'original40ContractsUnchanged':True,'asyncWireContractsUnchanged':True,'allPackagedHashesMatch':True,'sdkRuntimeBytesPreserved':True,'newIntegrationRecommendsOnlySubmitAndGet':True,'productionConnections':0}))
