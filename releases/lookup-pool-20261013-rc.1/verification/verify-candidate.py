"""Local artifact checks; no production or device access."""
from pathlib import Path
import hashlib,json,zipfile,subprocess,sys,re
root=Path(__file__).resolve().parent.parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
baseline=json.loads((root/'BASELINE.json').read_text())
frozen=[p for p in baseline['files'] if not p.endswith('.test.mjs') and (p.startswith(('screen-client/','deploy/mediamtx-pacing/','server/screen-','windows-agent/src/screen-')) or p in ['public/app.js','public/styles.css','windows-agent/scripts/alipay_name_lookup.py'])]
assert frozen
for p in frozen:assert sha(root/p)==baseline['files'][p],p+' frozen baseline changed'
assert sha(root/'windows-agent/scripts/alipay_name_lookup.py')==baseline['windowsRunnerSha256']
reference=json.loads((root/'public/api-reference.json').read_text())
assert len(reference['endpoints'])==40
assert len([e for e in reference['endpoints'] if e['auth']=='hmac'])==8
assert not any(e['path'].startswith('/api/v1/admin/') for e in reference['endpoints'])
new=next(e for e in reference['endpoints'] if e.get('managed'))
assert new['parameters']==[{'name':'phoneNumber','location':'body','type':'string','required':True,'description':'中国大陆11位手机号；示例为合成号码'}]
assert new['responseExample']=={'ok':True,'name':'**某'}
# Review legacy contract preservation against this candidate's immutable base.
base='238ec809352df34c4455b0c702328493bd17332e'
rel=root.relative_to(root.parents[1]).as_posix()
old=json.loads(subprocess.check_output(['git','show',base+':'+rel+'/public/api-reference.json'],cwd=root.parents[1]))
current={e['id']:e for e in reference['endpoints']}
for e in old['endpoints']:assert current[e['id']]==e,'legacy endpoint contract changed: '+e['id']
openapi=json.loads((root/'public/downloads/name-lookup-openapi.json').read_text())
assert sum(len(v) for v in openapi['paths'].values())==8
for value in openapi['paths'].values():
 for operation in value.values():assert operation['security']==[{'HmacSignature':[]}]
checksum=json.loads((root/'public/downloads/name-lookup-sha256.json').read_text())
with zipfile.ZipFile(root/'public/downloads/name-lookup-integration.zip') as z:
 for filename,digest in checksum['files'].items():assert hashlib.sha256(z.read(filename)).hexdigest()==digest,filename
 assert z.read('node_client.mjs')==(root/'sdk/open_name_lookup/node_client.mjs').read_bytes()
 assert z.read('python_client.py')==(root/'sdk/open_name_lookup/python_client.py').read_bytes()
 assert json.loads(z.read('SHA256.json'))==checksum['files']
assert sha(root/'public/downloads/name-lookup-integration.zip')==checksum['zipSha256']
artifacts=['public/api-reference.json','public/openapi.json','public/downloads/name-lookup-openapi.json','public/downloads/name-lookup-integration.zip','public/downloads/name-lookup-sha256.json']
before={p:sha(root/p) for p in artifacts}
subprocess.run([sys.executable,'scripts/build-managed-lookup-docs.py'],cwd=root,check=True)
assert before=={p:sha(root/p) for p in artifacts},'documentation build not reproducible'
for p in ['public/lookup-pool.js','public/api-docs.js',*map(str,[f.relative_to(root) for f in (root/'server').glob('managed-lookup*.mjs')])]:subprocess.run(['node','--check',p],cwd=root,check=True)
result={'frozenFilesVerified':len(frozen),'pythonRunnerUnchanged':True,'legacyContractsPreserved':len(old['endpoints']),'publicEndpoints':40,'hmacEndpoints':8,'zipSdkSourceMatched':True,'reproducibleDocs':True,'productionAccess':0}
print(json.dumps(result,indent=2))
