import subprocess,json,sys,time,getpass,uuid,hashlib
from pathlib import Path
folder=Path(__file__).parent
ssh=['/usr/bin/ssh','-F','/dev/null','-S','/private/tmp/pc-wecom-23-cloud-20261103.sock','-o','ControlMaster=no','-o','BatchMode=yes','-o','ProxyCommand=/usr/bin/false','-T','root@47.98.127.132','docker exec -i phone-cloud-platform node --input-type=module']
number=getpass.getpass('Authorized test customer: ')
assert len(number)==11 and number.isdigit() and number.endswith('6441')
request='native23-'+uuid.uuid4().hex
(folder/'attempt-intent.json').write_text(json.dumps({'deviceNumber':'23','appSlot':'main','mode':'preview','requestId':request,'phoneTail':'6441','sourceCommit':'32c0091a534aa7f9038deb91aa33f202f72e0e6b','originalSourceSha256':'4bcecc8702ea577a77e5f17664b7833ced33b681f88e5beedcdc6875b6f047cc','productionReload':False}))
prefix="""import fs from 'node:fs';import{createHash}from'node:crypto';
if(createHash('sha256').update(fs.readFileSync('server/index.mjs')).digest('hex')!=='4bcecc8702ea577a77e5f17664b7833ced33b681f88e5beedcdc6875b6f047cc')throw Error('source_drift');
const headers={authorization:'Bearer '+process.env.ADMIN_API_TOKEN,'content-type':'application/json'};
async function api(route,method='GET',body){const r=await fetch('http://127.0.0.1:8787'+route,{method,headers,redirect:'error',signal:AbortSignal.timeout(8000),...(body?{body:JSON.stringify(body)}:{})});return{http:r.status,body:await r.json()};}
"""
def run(source,label):
 r=subprocess.run(ssh,input=(prefix+source).encode(),capture_output=True,timeout=18)
 (folder/(label+'.stdout.raw')).write_bytes(r.stdout);(folder/(label+'.stderr.raw')).write_bytes(r.stderr)
 assert r.returncode==0,'transport_unknown_no_replay'
 return json.loads(r.stdout)
submit="""const inventory=await api('/api/v1/wecom/devices');const rows=inventory.body.devices.filter(d=>d.deviceNumber==='23');if(inventory.http!==200||rows.length!==1||!rows[0].available||!rows[0].online||rows[0].busy)throw Error('device_not_idle');
const result=await api('/api/v1/user/automation/wecom-preview-tasks','POST',INPUT);console.log(JSON.stringify({at:new Date().toISOString(),requestId:REQUEST,...result}));""".replace('INPUT',json.dumps({'deviceId':'adb:LBF6ON55EAIFYLMJ','appSlot':'main','mode':'preview','phoneNumber':number,'requestId':request,'remarkName':'QA预览','description':'接口联调测试'})).replace('REQUEST',json.dumps(request))
try:
 result=run(submit,'submit');print(json.dumps(result,ensure_ascii=False),flush=True)
 assert result['http']in(200,201),'submit_rejected'
 job=result['body']['task']['jobId'];last=None
 for index in range(81):
  result=run("const r=await api('/api/v1/user/automation/wecom-preview-tasks/"+job+"');console.log(JSON.stringify({at:new Date().toISOString(),...r}));",'poll-'+str(index))
  task=result.get('body',{}).get('task',{});key=json.dumps([task.get('status'),task.get('result')])
  if key!=last:print(json.dumps(result,ensure_ascii=False),flush=True);last=key
  if task.get('status')in('succeeded','failed','cancelled','expired','stalled'):break
  time.sleep(3)
 else:print(json.dumps({'status':'observation_deadline_keep_original','jobId':job}),flush=True)
except Exception as e:
 print(json.dumps({'error':str(e) if isinstance(e,AssertionError) else type(e).__name__,'requestId':request,'noResubmit':True}),flush=True)
 raise
