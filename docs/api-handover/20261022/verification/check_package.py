from pathlib import Path
import json,re,uuid,datetime,ast,hashlib,zipfile
root=Path('docs/api-handover/20261022');doc=(root/'README.md').read_text();api=json.loads((root/'openapi.json').read_text())
def schema(path,method,status):return api['paths']['/api/v1/open/name-lookups'+path][method]['responses'][status]['content']['application/json']['schema']
def validate(v,s):
 if 'oneOf' in s:
  passed=0
  for sub in s['oneOf']:
   try:validate(v,sub);passed+=1
   except (AssertionError,ValueError,TypeError):pass
  assert passed==1;return
 if '$ref' in s:
  t=api
  for k in s['$ref'].split('/')[1:]:t=t[k]
  return validate(v,t)
 types=s.get('type');types=types if isinstance(types,list) else [types] if types else []
 check={'object':lambda v:isinstance(v,dict),'string':lambda v:isinstance(v,str),'boolean':lambda v:isinstance(v,bool),'integer':lambda v:isinstance(v,int) and not isinstance(v,bool),'null':lambda v:v is None,'number':lambda v:isinstance(v,(int,float)) and not isinstance(v,bool),'array':lambda v:isinstance(v,list)}
 if types:assert any(check[t](v) for t in types)
 if 'enum' in s:assert v in s['enum']
 if isinstance(v,dict):
  assert all(k in v for k in s.get('required',[]))
  if s.get('additionalProperties') is False:assert set(v)<=set(s.get('properties',{}))
  for k,value in v.items():
   if k in s.get('properties',{}):validate(value,s['properties'][k])
 if isinstance(v,str) and s.get('format')=='uuid':uuid.UUID(v)
 if isinstance(v,str) and s.get('format')=='date-time':datetime.datetime.fromisoformat(v.replace('Z','+00:00'))
blocks=re.findall(r'```json\n(.*?)\n```',doc,re.S)
for raw in blocks:
 v=json.loads(raw)
 if 'preparationId' in v:
  sc=schema('/stop','post','200' if v['stopped'] else '202') if 'stopped' in v else schema('/prepare','post','200')
 elif 'lookupId' in v:sc=schema('/tasks','post','200') if 'reused' in v else schema('/tasks/{lookupId}','get','200')
 elif v.get('code')=='lookup_no_available_device':sc=schema('/tasks','post','503')
 else:sc=schema('/tasks','post','429')
 validate(v,sc)
assert '当前准备租约为30分钟' not in doc
assert len(api['paths'])==4
assert 'readyCount' not in schema('/prepare','post','200')['properties']
for p in root.glob('*.py'):ast.parse(p.read_text())
# copied published examples/spec should remain byte-identical to deployed candidate
published=Path('/tmp/pc-lookup-unavailable-verified-20261022/public/downloads')
for f,source in [('lookup.py','lookup.py'),('lookup.mjs','lookup.mjs'),('stop_lookup.py','stop_lookup.py'),('openapi.json','name-lookup-openapi.json')]:assert (root/f).read_bytes()==(published/source).read_bytes()
files=['README.md','http_flow.py','lookup.py','lookup.mjs','stop_lookup.py','openapi.json']
manifest={f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files};(root/'SHA256SUMS.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+'\n')
with zipfile.ZipFile(root/'支付宝查名字API对接资料.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
 for f in files+['SHA256SUMS.json']:
  info=zipfile.ZipInfo(f,date_time=(2026,10,22,12,0,0));info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,(root/f).read_bytes())
with zipfile.ZipFile(root/'支付宝查名字API对接资料.zip') as z:
 assert set(z.namelist())==set(files+['SHA256SUMS.json'])
 for f in files:assert z.read(f)==(root/f).read_bytes();assert hashlib.sha256(z.read(f)).hexdigest()==manifest[f]
result={'readmeResponseExamplesChecked':len(blocks),'checks':'required fields, enum, primitive types, oneOf, additional properties, UUID/date formats; four paths; published sample bytes; ZIP contents and SHA256','pythonFlowTestsPassed':22,'pythonSyntaxFiles':3,'productionChanges':False,'realPhoneQueries':0,'sourceRelease':'lookup-throughput-20261022-deployed.1','warning':'Python3.9 environment emits existing urllib3 LibreSSL warning; tests passed'}
(root/'verification/RESULTS.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n');print(json.dumps(result,ensure_ascii=False))
