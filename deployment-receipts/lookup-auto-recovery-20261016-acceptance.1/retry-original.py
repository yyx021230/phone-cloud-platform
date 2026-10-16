import json,sys,uuid,time,subprocess,requests
from pathlib import Path
root=Path(__file__).resolve().parent
file=root/'BATCH_STATE.json';events=root/'BATCH_EVENTS.jsonl'
prior=json.loads((root/'EXTERNAL_STATE.json').read_text())
state=json.loads(file.read_text()) if file.exists() else {'prepareKey':prior['prepareKey'],'startedAt':time.time(),'budget':50,'rows':[]}
def save():
 p=file.with_suffix('.tmp');p.write_text(json.dumps(state,indent=2)+'\n');p.replace(file)
def event(x):
 x['at']=time.time()
 with events.open('a') as f:f.write(json.dumps(x)+'\n')
 print(json.dumps(x),flush=True)
secret=subprocess.run(['security','find-generic-password','-s','PhoneCloud API / 47.98.127.132 / name-lookup-v1','-a','lookup-api-key-20261016-deployed.1','-w'],capture_output=True,text=True)
if secret.returncode:raise SystemExit('secure_key_unavailable')
key=secret.stdout.strip();assert key.startswith('pclk_')
def call(method,path,body=None,idem=None):
 h={'X-API-Key':key}
 if idem:h['Idempotency-Key']=idem
 try:
  r=requests.request(method,'http://47.98.127.132/api/v1/open/name-lookups'+path,json=body,headers=h,timeout=20,allow_redirects=False)
  x=r.json()
 except (requests.RequestException,ValueError):raise SystemExit('request_outcome_unknown_keep_original_keys')
 return r.status_code,x

source_js="import fs from 'node:fs/promises';import crypto from 'node:crypto';const b=await fs.readFile('/app/data/test-receipts/lookup-natural-handoff-20261015/phones.json','utf8');if(crypto.createHash('sha256').update(b).digest('hex')!=='20d3440551746ef8abe6919e5a8b3c7d0c6c12ac555f00f97d61d82fa8c64b95')throw Error('source_changed');console.log(b);"

retryfile=root/'ORIGINAL_RETRY.json'
oldId='bdd4ff9b-2c3f-411d-8aa7-4007fe22b987'
x=json.loads(retryfile.read_text()) if retryfile.exists() else {'oldLookupId':oldId,'index':7,'key':'auto-recovery-terminal-retry-'+str(uuid.uuid4())}
code,old=call('GET','/tasks/'+oldId)
assert code==200 and old.get('status')=='failed' and old.get('code')=='lookup_queue_timeout','original_not_terminal'
if not x.get('lookupId'):
 code,p=call('POST','/prepare',{},state['prepareKey']);assert code==200 and p.get('ready') is True,'not_ready'
 retryfile.write_text(json.dumps(x,indent=2)+'\n')
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','-S','/tmp/pc-rc16-cloud-20261016.sock','root@47.98.127.132','docker exec -i phone-cloud-platform node --input-type=module'],input=source_js,text=True,capture_output=True,timeout=20)
 if r.returncode:raise SystemExit('source_unavailable')
 phones=json.loads(r.stdout);code,z=call('POST','/tasks',{'phoneNumber':phones[7]},x['key'])
 x.update(http=code,lookupId=z.get('lookupId'),reused=z.get('reused'),status=z.get('status'),submittedAt=time.time());retryfile.write_text(json.dumps(x,indent=2)+'\n')
 assert code in [200,202] and x['lookupId'] and x['lookupId']!=oldId,'new_terminal_retry_not_created'
code,z=call('GET','/tasks/'+x['lookupId']);x.update(http=code,status=z.get('status'),code=z.get('code'),checkedAt=time.time())
if x['status']=='completed':assert isinstance(z.get('name'),str);x['hasName']=bool(z['name'])
retryfile.write_text(json.dumps(x,indent=2)+'\n');print(json.dumps(x))
