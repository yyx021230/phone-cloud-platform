"""Authorized five-minute window, cloud only; no database migration or ADB calls."""
import pathlib,subprocess,json,hashlib,os,sys,time,fcntl,copy
os.umask(0o077)
root=pathlib.Path('/opt/phone-cloud-platform');stage=pathlib.Path(__file__).resolve().parent
lock=(root/'.deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
run=lambda a:subprocess.check_output(a,text=True).strip()
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
activePath=root/'ACTIVE_PLATFORM_RELEASE.json';raw=activePath.read_bytes();active=json.loads(raw)
prepared=json.loads((stage/'PREPARATION_RECEIPT.json').read_text());baseline=prepared['previousImage']
assert active['version']=='lookup-recovery-20261023-deployed.1'
assert active['imageId']==baseline and active['restartImageId']==baseline
assert run(['docker','inspect','phone-cloud-platform','--format','{{.Image}}'])==baseline
assert run(['docker','image','inspect',prepared['imageTag'],'--format','{{.Id}}'])==prepared['imageId']
for f,h in prepared['backupFiles'].items():assert sha(stage/'rollback'/f)==h,f
args=['docker','compose','-p','phone-cloud-platform']
for row in active['activeCompose']:
 assert sha(row['path'])==row['sha256'];args+=['-f',row['path']]
pending=stage/'compose.pending.json'
old=json.loads(run(args+['config','--format','json']));new=json.loads(run(args+['-f',str(pending),'config','--format','json']))
expected=copy.deepcopy(old);expected['services']['phone-cloud']['image']=prepared['imageTag'];assert new==expected
mediaCmd=['/tmp/phonecloud-node-v22.22.3-linux-x64/node-v22.22.3-linux-x64/bin/node',str(root/'deploy/mediamtx-pacing/verify.mjs'),'--live']
assert '--approved-current-maintenance' in sys.argv, 'Current maintenance authorization required'
if sys.argv[1]=='stop':
 media=json.loads(run(mediaCmd));assert media['verified']=='live'
 files=prepared['cloudFiles'];code="const fs=require('fs'),c=require('crypto');for(const[f,h]of Object.entries("+json.dumps(files)+")){const p='/app/'+f;const a=fs.existsSync(p)?c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null;if(a!==h.before)throw Error('drift '+f)}"
 run(['docker','exec','phone-cloud-platform','node','-e',code])
 # Check current process state; historical SQL nonterminal rows are not a live queue.
 code="(async()=>{const get=async p=>{const r=await fetch('http://127.0.0.1:8787'+p,{headers:{Authorization:'Bearer '+process.env.ADMIN_API_TOKEN}});if(!r.ok)throw Error(p);return r.json()};const[p,d,t]=await Promise.all(['/api/v1/admin/lookup-pool','/api/v1/devices','/api/v1/windows-agent-tasks?limit=200'].map(get));if(p.pool.channels.some(c=>c.aiVision?.status==='reading'))throw Error('AI still reading');if(p.pool.config.enabled!==false)throw Error('lookup admission must be paused');if(d.devices.some(x=>x.occupancy?.kind&&!['screen_control','alipay_name_lookup'].includes(x.occupancy.kind)))throw Error('other business occupied');if(t.tasks.some(x=>['queued','running','pending','claimed','dispatched'].includes(x.status)))throw Error('tasks active');console.log(JSON.stringify({at:new Date().toISOString(),controls:d.devices.filter(x=>x.occupancy?.kind==='screen_control').map(x=>x.deviceName),noExecutingWindowsTasks:true,lookupPaused:true,preservedLookupRequests:p.pool.requests.filter(r=>r.purpose!=='readiness_probe'&&!['succeeded','not_found','failed','cancelled','expired'].includes(r.status)).map(r=>r.lookupId)}))})().catch(e=>{console.error(e.message);process.exit(1)})"
 occupancy=json.loads(run(['docker','exec','phone-cloud-platform','node','-e',code]))
 assert not (stage/'MAINTENANCE_STARTED.json').exists()
 (stage/'ACTIVE.before.json').write_bytes(raw)
 (stage/'MAINTENANCE_STARTED.json').write_text(json.dumps({'atUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'media':media,'occupancy':occupancy,'authorization':'User explicitly approved this five-minute control interruption window including new control connections; no ADB/SYSTEM change'},indent=2)+'\n')
 run(['docker','stop','--time','15','phone-cloud-platform'])
 print('Cloud stopped for approved maintenance',flush=True)
elif sys.argv[1]=='start':
 assert (stage/'MAINTENANCE_STARTED.json').exists()
 subprocess.run(args+['-f',str(pending),'up','-d','--no-deps','--pull','never','phone-cloud'],cwd=root,check=True,stdout=subprocess.DEVNULL,timeout=60)
 for i in range(90):
  r=subprocess.run(['docker','exec','phone-cloud-platform','node','-e',"fetch('http://127.0.0.1:8787/readyz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],capture_output=True,timeout=5)
  if r.returncode==0:break
  time.sleep(1)
 else:raise RuntimeError('Candidate not ready; preserve data and use previous image rollback')
 container=json.loads(run(['docker','inspect','phone-cloud-platform']))[0];assert container['Image']==prepared['imageId'] and container['RestartCount']==0
 code="const fs=require('fs'),c=require('crypto');for(const[f,h]of Object.entries("+json.dumps(prepared['cloudFiles'])+")){if(c.createHash('sha256').update(fs.readFileSync('/app/'+f)).digest('hex')!==h.after)throw Error(f)}"
 run(['docker','exec','phone-cloud-platform','node','-e',code])
 media=json.loads(run(mediaCmd));assert media['verified']=='live'
 before=json.loads((stage/'MAINTENANCE_STARTED.json').read_text())['media'];assert media==before
 receipt={'status':'cloud-active-awaiting-final-verification','atUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'sourceCommit':prepared['sourceCommit'],'imageId':prepared['imageId'],'containerId':container['Id'],'containerPid':container['State']['Pid'],'restartCount':container['RestartCount'],'runtimeHashCount':len(prepared['cloudFiles']),'media':media,'databaseMigrated':False}
 (stage/'CLOUD_ACTIVATED.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt),flush=True)
else:raise RuntimeError('Expected stop or start')
