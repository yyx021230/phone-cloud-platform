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
mode=sys.argv[1]
if mode=='prepare':
 code,x=call('POST','/prepare',{},state['prepareKey']);state['ready']=x.get('ready');save();event({'action':mode,'http':code,'status':x.get('status'),'ready':x.get('ready'),'code':x.get('code')})
elif mode=='submit':
 offset=int(sys.argv[2]);count=int(sys.argv[3]);assert 4<=offset and offset+count<=54 and 1<=count<=10
 code,x=call('POST','/prepare',{},state['prepareKey'])
 if code!=200 or x.get('ready') is not True:event({'action':'prepare','http':code,'status':x.get('status'),'code':x.get('code')});raise SystemExit('not_ready_no_new_business')
 active=[r for r in state['rows'] if r.get('status') not in ['completed','failed','expired','cancelled']]
 assert len(active)+count<=20,'bounded_inflight_budget'
 js="""import fs from 'node:fs/promises';import crypto from 'node:crypto';const b=await fs.readFile('/app/data/test-receipts/lookup-natural-handoff-20261015/phones.json','utf8');if(crypto.createHash('sha256').update(b).digest('hex')!=='20d3440551746ef8abe6919e5a8b3c7d0c6c12ac555f00f97d61d82fa8c64b95')throw Error('source_changed');console.log(b);"""
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','-S','/tmp/pc-rc16-cloud-20261016.sock','root@47.98.127.132','docker exec -i phone-cloud-platform node --input-type=module'],input=js,text=True,capture_output=True,timeout=20)
 if r.returncode:raise SystemExit('authorized_source_unavailable')
 phones=json.loads(r.stdout)
 for i in range(offset,offset+count):
  row=next((r for r in state['rows'] if r['index']==i),None)
  if row and row.get('lookupId'):event({'action':'already_submitted','index':i,'lookupId':row['lookupId']});continue
  if not row:row={'index':i,'key':'account-offline-batch-'+str(uuid.uuid4())};state['rows'].append(row)
  save();code,x=call('POST','/tasks',{'phoneNumber':phones[i]},row['key'])
  if x.get('lookupId'):row['lookupId']=x['lookupId']
  row.update(status=x.get('status'),code=x.get('code'),reused=x.get('reused'));save();event({'action':mode,'index':i,'http':code,'lookupId':row.get('lookupId'),'status':row['status'],'code':row['code'],'reused':row['reused']})
  if code not in [200,202]:raise SystemExit('submission_rejected_stop_batch')
elif mode=='resubmit':
 i=int(sys.argv[2]);row=next(r for r in state['rows'] if r['index']==i);assert row.get('lookupId') and row.get('status')=='processing'
 row.setdefault('retryKey','account-offline-retry-'+str(uuid.uuid4()));save()
 js="""import fs from 'node:fs/promises';import crypto from 'node:crypto';const b=await fs.readFile('/app/data/test-receipts/lookup-natural-handoff-20261015/phones.json','utf8');if(crypto.createHash('sha256').update(b).digest('hex')!=='20d3440551746ef8abe6919e5a8b3c7d0c6c12ac555f00f97d61d82fa8c64b95')throw Error('source_changed');console.log(b);"""
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','-S','/tmp/pc-rc16-cloud-20261016.sock','root@47.98.127.132','docker exec -i phone-cloud-platform node --input-type=module'],input=js,text=True,capture_output=True,timeout=20)
 if r.returncode:raise SystemExit('source_unavailable')
 phone=json.loads(r.stdout)[i];code,x=call('POST','/tasks',{'phoneNumber':phone},row['retryKey'])
 same=x.get('lookupId')==row['lookupId'];event({'action':mode,'index':i,'http':code,'lookupId':x.get('lookupId'),'sameLookupId':same,'reused':x.get('reused'),'status':x.get('status')});assert same,'unexpected_duplicate_stop'
elif mode=='poll':
 for row in state['rows']:
  if not row.get('lookupId') or row.get('status')=='completed':continue
  code,x=call('GET','/tasks/'+row['lookupId']);row.update(status=x.get('status'),code=x.get('code'))
  if row['status']=='completed':assert isinstance(x.get('name'),str);row['hasName']=bool(x['name'])
  save();event({'action':mode,'index':row['index'],'http':code,'lookupId':row['lookupId'],'status':row['status'],'code':row['code'],'hasName':row.get('hasName')})
 print(json.dumps({'summary':{s:sum(r.get('status')==s for r in state['rows']) for s in set(r.get('status') for r in state['rows'])},'total':len(state['rows'])}))
else:raise SystemExit('invalid_action')
