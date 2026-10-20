from pathlib import Path
import json,hashlib,subprocess,datetime,urllib.request
r=Path('/opt/phone-cloud-platform');stage=r/'staging/lookup-offline-round-stop-20261020-rc.2';p=json.loads((stage/'PREPARED.json').read_text());a=json.loads((r/'ACTIVE_PLATFORM_RELEASE.json').read_text());assert a['version']=='lookup-offline-round-stop-20261020-deployed.1'
sha=lambda b:hashlib.sha256(b).hexdigest();files=[]
for f,digest in p['files'].items():
 if not f.startswith('public/'):continue
 url='http://47.98.127.132/'+f.removeprefix('public/');resp=urllib.request.urlopen(url,timeout=12);data=resp.read();assert resp.status==200 and sha(data)==digest,f;files.append({'path':'/'+f.removeprefix('public/'),'status':200,'sha256':digest})
code=r'''
import crypto from 'node:crypto';
const get=async path=>{const r=await fetch('http://127.0.0.1:8787'+path,{headers:{authorization:'Bearer '+process.env.ADMIN_API_TOKEN}});if(!r.ok)throw Error('readonly_failed');return r.json()};
const health=await get('/healthz'),ready=await get('/readyz'),{devices}=await get('/api/v1/devices'),{agents=[]}=await get('/api/v1/windows-agents'),{pool:p}=await get('/api/v1/admin/lookup-pool');
const clients=JSON.parse(process.env.OPEN_NAME_LOOKUP_CLIENTS_JSON||'[]');const preparation=p.preparations.find(x=>x.stoppedAt!==undefined&&clients.some(c=>c.clientId===x.clientId&&c.secret));
let externalOldPreparation={tested:false};
if(preparation){const client=clients.find(c=>c.clientId===preparation.clientId),key=p.preparationKeys.find(k=>k.clientId===client.clientId&&k.preparationId===preparation.preparationId)?.key;if(key){const route='/api/v1/open/name-lookups/prepare',raw='{}',timestamp=String(Date.now()),nonce=crypto.randomUUID(),signature=crypto.createHmac('sha256',client.secret).update(['POST',route,timestamp,nonce,crypto.createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
 const res=await fetch('http://47.98.127.132'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Client-Id':client.clientId,'X-Timestamp':timestamp,'X-Nonce':nonce,'X-Signature':signature,'Idempotency-Key':key},body:raw});const b=await res.json();externalOldPreparation={tested:true,http:res.status,status:b.status,ready:b.ready,samePreparation:b.preparationId===preparation.preparationId};if(!res.ok||b.status!=='stopped'||!externalOldPreparation.samePreparation)throw Error('external_stopped_verification_failed');}}
const after=(await get('/api/v1/admin/lookup-pool')).pool;
console.log(JSON.stringify({health,ready,deviceCounts:{total:devices.length,listed:devices.filter(d=>d.listingStatus==='listed').length,online:devices.filter(d=>d.adb?.state==='device').length},agents:agents.map(a=>({enabled:a.enabled,lastSeenAt:a.lastSeenAt})),pool:{enabled:p.config.enabled,revision:p.configRevision,registered:p.devices.length,concurrency:p.config.concurrency,channels:after.channels.length,pending:after.requests.filter(r=>!['succeeded','not_found','failed','expired','cancelled'].includes(r.status)).length,stoppingRounds:after.roundStops.filter(r=>r.status==='stopping').length},externalOldPreparation,screenNumbers:devices.filter(d=>d.occupancy?.kind==='screen_control').map(d=>d.deviceName)}));
'''
summary=json.loads(subprocess.check_output(['docker','exec','-i','phone-cloud-platform','node','--input-type=module'],input=code,text=True,stderr=subprocess.PIPE,timeout=35))
container=json.loads(subprocess.check_output(['docker','inspect','phone-cloud-platform'],text=True))[0];assert container['Image']==p['image'];assert sha((r/'.env').read_bytes())==p['envBeforeSha256']
media=json.loads(subprocess.check_output(['/tmp/phonecloud-node-v22.22.3-linux-x64/node-v22.22.3-linux-x64/bin/node',str(r/'deploy/mediamtx-pacing/verify.mjs'),'--live'],text=True));assert media['verified']=='live'
logs=subprocess.check_output(['docker','logs','--tail','200','phone-cloud-platform'],text=True,stderr=subprocess.STDOUT)
keywords=['SyntaxError','ReferenceError','UnhandledPromiseRejection','managed_lookup_persistence_failed','managed_lookup_device_errors'];errors={k:logs.count(k) for k in keywords}
out={'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'publicFiles':files,**summary,'container':{'image':container['Image'],'healthy':container['State'].get('Health',{}).get('Status'),'restartCount':container['RestartCount']},'media':media,'boundedErrorCounts':errors,'agentRestarted':False,'adbTouched':False,'newBusinessSubmitted':0,'newPreparationSubmitted':0}
assert not any(errors.values());dest=r/'deployment-receipts/lookup-offline-round-stop-20261020-deployed.1/VERIFIED.json';dest.write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n');print(json.dumps(out,ensure_ascii=False))
