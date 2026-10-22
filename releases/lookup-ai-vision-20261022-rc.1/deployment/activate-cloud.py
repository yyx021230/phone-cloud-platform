"""Execute only after this maintenance window is explicitly approved."""
import pathlib,subprocess,json,hashlib,os,time,fcntl,copy,sys
os.umask(0o077)
root=pathlib.Path('/opt/phone-cloud-platform');stage=pathlib.Path(__file__).resolve().parent
lock=(root/'.deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
run=lambda a:subprocess.check_output(a,text=True).strip()
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
prepared=json.loads((stage/'PREPARATION_RECEIPT.json').read_text());originalActiveRaw=(root/'ACTIVE_PLATFORM_RELEASE.json').read_bytes();active=json.loads(originalActiveRaw);baseline=prepared['previousImage']
assert active['version']=='lookup-throughput-20261022-deployed.1' and active['imageId']==active['restartImageId']==baseline
assert run(['docker','image','inspect',prepared['imageTag'],'--format','{{.Id}}'])==prepared['imageId']
for f,h in prepared['backupFiles'].items():assert sha(stage/'rollback'/f)==h,f
args=['docker','compose','-p','phone-cloud-platform']
for row in active['activeCompose']:
 assert sha(row['path'])==row['sha256'];args+=['-f',row['path']]
pending=stage/'compose.pending.json';newArgs=args+['-f',str(pending)]
old=json.loads(run(args+['config','--format','json']));new=json.loads(run(newArgs+['config','--format','json']));expected=copy.deepcopy(old);overlay=json.loads(pending.read_text())['services']['phone-cloud'];svc=expected['services']['phone-cloud'];svc['image']=prepared['imageTag'];svc.setdefault('environment',{}).update(overlay['environment']);svc.setdefault('volumes',[]).extend(overlay['volumes']);assert new==expected,'compose drift'
mediaCmd=['/tmp/phonecloud-node-v22.22.3-linux-x64/node-v22.22.3-linux-x64/bin/node',str(root/'deploy/mediamtx-pacing/verify.mjs'),'--live']
def ready():
 for i in range(90):
  r=subprocess.run(['docker','exec','phone-cloud-platform','node','-e',"fetch('http://127.0.0.1:8787/readyz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],capture_output=True,timeout=5)
  if r.returncode==0:return
  time.sleep(1)
 raise RuntimeError('readiness timeout')
def verify_files(which):
 code="const fs=require('fs'),c=require('crypto');for(const[f,h]of Object.entries("+json.dumps(prepared['cloudFiles'])+")){const p='/app/'+f;const actual=fs.existsSync(p)?c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null;if(actual!==h."+which+")throw Error('drift: '+f)}"
 run(['docker','exec','phone-cloud-platform','node','-e',code])
assert sys.argv[1:] == ['--approved-control-window'], 'explicit current maintenance approval required'
assert not (stage/'CLOUD_ACTIVATED.json').exists()
assert run(['docker','inspect','phone-cloud-platform','--format','{{.Image}}'])==baseline
verify_files('before');media=json.loads(run(mediaCmd));assert media['verified']=='live'
secret=pathlib.Path('/opt/phone-cloud-secrets/lookup-ai-vision.key');assert secret.is_file() and (secret.stat().st_mode&0o777)==0o600
code="(async()=>{const get=async p=>{const r=await fetch('http://127.0.0.1:8787'+p,{headers:{Authorization:'Bearer '+process.env.ADMIN_API_TOKEN}});if(!r.ok)throw Error(p);return r.json()};const[p,d,t]=await Promise.all(['/api/v1/admin/lookup-pool','/api/v1/devices','/api/v1/windows-agent-tasks?limit=200'].map(get));if(p.pool.channels.length||p.pool.requests.some(r=>!['succeeded','not_found','failed','cancelled','expired'].includes(r.status)))throw Error('lookup active');if(d.devices.some(x=>x.occupancy?.kind&&x.occupancy.kind!=='screen_control'))throw Error('business occupied');if(t.tasks.some(x=>['queued','running','pending','claimed','dispatched'].includes(x.status)))throw Error('tasks active');console.log(JSON.stringify({at:new Date().toISOString(),controls:d.devices.filter(x=>x.occupancy?.kind==='screen_control').map(x=>x.deviceName),noActiveBusiness:true}))})().catch(e=>{console.error(e.message);process.exit(1)})"
occupancy=json.loads(run(['docker','exec','phone-cloud-platform','node','-e',code]))
(stage/'MAINTENANCE_STARTED.json').write_text(json.dumps({'atUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'media':media,'occupancy':occupancy,'authorization':'Explicit current control-interruption window; no Agent/ADB/SYSTEM/media changes'},indent=2)+'\n')
try:
 subprocess.run(newArgs+['up','-d','--no-deps','--pull','never','phone-cloud'],cwd=root,check=True,stdout=subprocess.DEVNULL,timeout=60)
 ready();verify_files('after');after=json.loads(run(mediaCmd));assert after==media
 container=json.loads(run(['docker','inspect','phone-cloud-platform']))[0];assert container['Image']==prepared['imageId'] and container['RestartCount']==0
 previous=copy.deepcopy(active);active.update(version='lookup-ai-vision-20261022-deployed.1',status='deployed-awaiting-real-phone-observation',atUtc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),runtimeCandidateTag='lookup-ai-vision-20261022-rc.1',runtimeCandidateCommit=prepared['sourceCommit'],businessSourceTag='lookup-ai-vision-20261022-rc.1',businessSourceCommit=prepared['sourceCommit'],imageId=prepared['imageId'],imageTag=prepared['imageTag'],restartImageId=prepared['imageId'],restartImageTag=prepared['imageTag'],runningContainerId=container['Id'],runningContainerPid=container['State']['Pid'],hotPatchedRuntimeFiles={})
 active['activeCompose'].append({'path':str(pending),'sha256':sha(pending)})
 active['lookupAiOverlay']={'sourceCommit':prepared['sourceCommit'],'cloudFiles':{f:h['after'] for f,h in prepared['cloudFiles'].items()},'baseVersion':previous['version'],'baseImage':baseline,'rollback':str(stage/'rollback'),'wholeAiTimeoutMs':120000,'agentChanged':False,'adbChanged':False,'databaseMigration':False,'media':media,'productionAcceptanceComplete':False}
 temp=root/'ACTIVE_PLATFORM_RELEASE.json.ai-tmp';temp.write_text(json.dumps(active,indent=2)+'\n');os.replace(temp,root/'ACTIVE_PLATFORM_RELEASE.json')
 receipt={k:active[k] for k in ['version','atUtc','runtimeCandidateCommit','imageId','restartImageId','runningContainerId']};receipt.update(media=media,controlsInterrupted=occupancy['controls'],ready=True,sourceDirectory=str(stage),agentChanged=False,adbChanged=False,productionAcceptanceComplete=False)
 (stage/'CLOUD_ACTIVATED.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt),flush=True)
except Exception:
 subprocess.run(args+['up','-d','--no-deps','--pull','never','phone-cloud'],cwd=root,check=True,stdout=subprocess.DEVNULL,timeout=60);ready();verify_files('before')
 assert json.loads(run(mediaCmd))==media
 restore=root/'ACTIVE_PLATFORM_RELEASE.json.ai-rollback';restore.write_bytes(originalActiveRaw);os.replace(restore,root/'ACTIVE_PLATFORM_RELEASE.json')
 (stage/'ROLLED_BACK.json').write_text(json.dumps({'atUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'imageId':baseline,'ready':True,'dataRestored':False})+'\n')
 raise
