import json,sys,time,uuid,subprocess,requests,hashlib,os,re
from pathlib import Path
os.umask(0o077)
root=Path(__file__).resolve().parent;file=root/'EXTERNAL_STATE.json';events=root/'EXTERNAL_EVENTS.jsonl'
s=json.loads(file.read_text()) if file.exists() else {'rounds':{},'rows':[],'startedAt':time.time(),'budget':12}
def save():
 p=file.with_suffix('.tmp');p.write_text(json.dumps(s,indent=2)+'\n');p.replace(file)
def event(x):
 x['atUtc']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
 with events.open('a') as f:f.write(json.dumps(x)+'\n')
 print(json.dumps(x),flush=True)
secret=subprocess.run(['security','find-generic-password','-s','PhoneCloud API / 47.98.127.132 / name-lookup-v1','-a','lookup-api-key-20261016-deployed.1','-w'],capture_output=True,text=True)
if secret.returncode:raise SystemExit('secure_key_unavailable')
key=secret.stdout.strip();assert key.startswith('pclk_')
base='http://47.98.127.132/api/v1/open/name-lookups'
def call(method,path,body=None,idem=None):
 h={'X-API-Key':key}
 if idem:h['Idempotency-Key']=idem
 try:
  r=requests.request(method,base+path,headers=h,json=body,timeout=20,allow_redirects=False);x=r.json()
 except (requests.RequestException,ValueError):raise SystemExit('unknown_http_outcome_keep_original_identifiers')
 assert isinstance(x,dict),'invalid_response'
 return r.status_code,x
def round(n):
 if str(n) not in s['rounds']:s['rounds'][str(n)]={'key':'stop-acceptance-prepare-'+str(uuid.uuid4())};save()
 return s['rounds'][str(n)]
def prepare(n):
 rd=round(n);code,x=call('POST','/prepare',{},rd['key']);rd.update(status=x.get('status'),ready=x.get('ready'))
 if x.get('preparationId'):rd['preparationId']=x['preparationId']
 save();event({'action':'prepare','round':n,'http':code,'status':rd['status'],'ready':rd['ready'],'preparationId':rd.get('preparationId'),'code':x.get('code')});return x
def get(row):
 code,x=call('GET','/tasks/'+row['lookupId']);row.update(status=x.get('status'),code=x.get('code'))
 if row['status']=='completed':
  assert isinstance(x.get('name'),str);digest=hashlib.sha256(x['name'].encode()).hexdigest()
  if row.get('nameHash'):assert row['nameHash']==digest,'completed_result_changed'
  row.update(hasName=bool(x['name']),nameHash=digest)
 save();event({'action':'result','index':row['index'],'http':code,'lookupId':row['lookupId'],'status':row['status'],'code':row.get('code'),'hasName':row.get('hasName')});return x
def phones():
 js="import fs from 'node:fs';import c from 'node:crypto';const b=fs.readFileSync('/app/data/test-receipts/lookup-natural-handoff-20261015/phones.json');if(c.createHash('sha256').update(b).digest('hex')!=='20d3440551746ef8abe6919e5a8b3c7d0c6c12ac555f00f97d61d82fa8c64b95')throw Error('source_changed');console.log(b.toString());"
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','-S','/tmp/pc-rc16-cloud-20261016.sock','root@47.98.127.132','docker exec -i phone-cloud-platform node --input-type=module'],input=js,text=True,capture_output=True,timeout=20)
 if r.returncode:raise SystemExit('authorized_source_unavailable')
 return json.loads(r.stdout)
def submit(n,indices):
 assert prepare(n).get('ready') is True,'not_ready_no_submission';numbers=phones()
 assert all(104<=i<=115 for i in indices)
 for i in indices:
  row=next((r for r in s['rows'] if r['index']==i),None)
  if row and row.get('lookupId'):get(row);continue
  if row is None:row={'index':i,'round':n,'key':'round-stop-business-'+str(uuid.uuid4())};s['rows'].append(row)
  save();code,x=call('POST','/tasks',{'phoneNumber':numbers[i]},row['key'])
  if x.get('lookupId'):row['lookupId']=x['lookupId']
  row.update(status=x.get('status'),reused=x.get('reused'),code=x.get('code'));save();event({'action':'submit','index':i,'http':code,'lookupId':row.get('lookupId'),'status':row['status'],'reused':row['reused'],'code':row['code']});assert code in (200,202),'submit_rejected'
def stop(n):
 rd=round(n);pid=rd['preparationId'];code,x=call('POST','/stop',{'preparationId':pid},'stop-'+pid)
 assert x.get('preparationId')==pid and x.get('status') in ['stopping','stopped'] and x.get('stopped')==(x['status']=='stopped'),'invalid_stop_response'
 rd['stopStatus']=x['status'];save();event({'action':'stop','round':n,'http':code,**x});return x
mode=sys.argv[1]
if mode=='prepare':prepare(int(sys.argv[2]))
elif mode=='seed':submit(int(sys.argv[2]),[int(sys.argv[3])])
elif mode=='burst-stop':
 assert next(r for r in s['rows'] if r['index']==104)['status']=='completed','finish_seed_first'
 submit(1,list(range(105,115)))
 for row in s['rows']:
  if 105<=row['index']<115:get(row)
 s['beforeStop']={k:sum(r['status']==k for r in s['rows'] if 105<=r['index']<115) for k in ['queued','processing','completed','failed']};save();event({'action':'before_stop',**s['beforeStop']});st=stop(1)
 if st['stopped']:raise SystemExit('already_stopped_no_inflight_barrier_sample')
 code,x=call('POST','/prepare',{},'stop-acceptance-blocked-start-'+round(1)['preparationId']);event({'action':'new_start_during_stop','http':code,'code':x.get('code'),'status':x.get('status')});s['startWhileStopping']={'http':code,'code':x.get('code')};save()
 assert code==409 and x.get('code')=='lookup_round_stopping','expected_stop_barrier'
elif mode=='sample-stop':
 import importlib.util
 n=int(sys.argv[2]);rd=round(n);response=requests.get('http://47.98.127.132/downloads/stop_lookup.py',timeout=20)
 expected=json.loads((root/'PREPARED.json').read_text())['files']['public/downloads/stop_lookup.py']
 assert response.status_code==200 and hashlib.sha256(response.content).hexdigest()==expected
 path=root/'downloaded_stop_lookup.py';path.write_bytes(response.content)
 spec=importlib.util.spec_from_file_location('downloaded_stop',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 result=module.stop_round(rd['preparationId'],key,wait_seconds=40);rd['stopStatus']=result['status'];save();event({'action':'downloaded_python_stop','round':n,**result})
elif mode=='stop':stop(int(sys.argv[2]))
elif mode=='poll':
 for row in s['rows']:
  if row.get('lookupId'):get(row)
elif mode=='old-stop':
 assert stop(1)['stopped'] is True
 expected_id=round(2)['preparationId'];fresh=prepare(2)
 assert fresh.get('preparationId')==expected_id and fresh.get('status') in ['preparing','ready'],'old_stop_affected_new_round'
 s['oldStopDidNotStopNewRound']=True;save()
else:raise SystemExit('unknown_mode')
