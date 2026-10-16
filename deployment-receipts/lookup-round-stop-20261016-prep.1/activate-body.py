# Prepended after user maintenance authorization: approved_numbers, approval_at.
from pathlib import Path
import json,hashlib,subprocess,datetime,time,os,copy
os.umask(0o077)
r=Path('/opt/phone-cloud-platform');p=r/'ACTIVE_PLATFORM_RELEASE.json';raw=p.read_bytes();a=json.loads(raw);stage=r/'staging/lookup-round-stop-20261016-rc.1';m=json.loads((stage/'PREPARED.json').read_text())
h=lambda b:hashlib.sha256(b).hexdigest();run=lambda *cmd,**kw:subprocess.check_output(list(cmd),text=True,**kw).strip()
assert json.loads((stage/'POSTGRES-ISOLATED.json').read_text())['storage']=='postgres';assert h(raw)==m['baselineActiveSha256'];assert json.loads(run('docker','inspect','phone-cloud-platform'))[0]['Id']==m['containerId'];assert run('docker','image','inspect',m['tag'],'--format','{{.Id}}')==m['image']
verify=['/tmp/phonecloud-node-v22.22.3-linux-x64/node-v22.22.3-linux-x64/bin/node',str(r/'deploy/mediamtx-pacing/verify.mjs'),'--live'];mediaBefore=json.loads(run(*verify,cwd=r));assert mediaBefore['verified']=='live'
check="const fs=require('fs'),c=require('crypto');for(const[p,s]of Object.entries(JSON.parse(fs.readFileSync(0,'utf8'))))if(c.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')!==s)throw Error('hash:'+p)"
subprocess.run(['docker','exec','-i','phone-cloud-platform','node','-e',check],input=json.dumps(a['cloudRuntimeFiles']),text=True,check=True)
cmd=['docker','compose','-p','phone-cloud-platform']
for row in a['activeCompose']:
 assert h(Path(row['path']).read_bytes())==row['sha256'];cmd+=['-f',row['path']]
assert h(Path(m['compose']['path']).read_bytes())==m['compose']['sha256']
gate="const allowed=JSON.parse(process.argv[1]),h={authorization:'Bearer '+process.env.ADMIN_API_TOKEN};const get=async p=>{const r=await fetch('http://127.0.0.1:8787'+p,{headers:h});if(!r.ok)throw Error('read_failed');return r.json()};const{devices}=await get('/api/v1/devices');const{pool:p}=await get('/api/v1/admin/lookup-pool');const{tasks}=await get('/api/v1/windows-agent-tasks?limit=200');const occupied=devices.filter(d=>d.occupancy);if(occupied.some(d=>d.occupancy.kind!=='screen_control'||!allowed.includes(String(d.deviceName))))throw Error('occupancy_changed');if(p.configRevision!==57||p.channels.length||p.requests.some(r=>!['succeeded','not_found','failed','expired','cancelled'].includes(r.status))||tasks.some(t=>['queued','leased','running','stalled'].includes(t.status)))throw Error('active_work');console.log(JSON.stringify({numbers:occupied.map(d=>d.deviceName),revision:p.configRevision,channels:0,pending:0}))"
occupancy=json.loads(run('docker','exec','phone-cloud-platform','node','--input-type=module','-e',gate,json.dumps(approved_numbers)))
envfile=r/'.env';oldenv=envfile.read_bytes();assert h(oldenv)==m['envBeforeSha256']
beforecfg=json.loads(run(*cmd,'config','--format','json',cwd=r))
receipt=r/'deployment-receipts/lookup-round-stop-20261016-deployed.1';receipt.mkdir();(receipt/'ACTIVE.before.json').write_bytes(raw)
# New bounded backup immediately before switching; never restore it automatically.
fresh=Path(m['backup'])/'postgres.preswitch.dump'
with fresh.open('wb') as f:subprocess.run(['docker','exec','phone-cloud-postgres','sh','-c','exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --lock-wait-timeout=5s'],stdout=f,check=True,timeout=180)
with fresh.open('rb') as f:subprocess.run(['docker','exec','-i','phone-cloud-postgres','pg_restore','--file=/dev/null'],stdin=f,stdout=subprocess.DEVNULL,check=True,timeout=180)
# Backup takes time: the last gate must happen after it.
occupancy=json.loads(run('docker','exec','phone-cloud-platform','node','--input-type=module','-e',gate,json.dumps(approved_numbers)))
assert p.read_bytes()==raw and envfile.read_bytes()==oldenv
started=datetime.datetime.now(datetime.timezone.utc).isoformat();print(json.dumps({'phase':'switching_cloud_only','atUtc':started,'occupied':occupancy}),flush=True)
switched=False
try:
 aftercfg=json.loads(run(*cmd,'-f',m['compose']['path'],'config','--format','json',cwd=r));expectedcfg=copy.deepcopy(beforecfg);expectedcfg['services']['phone-cloud']['image']=m['tag']
 assert aftercfg==expectedcfg,'unexpected_compose_change'
 switched=True;subprocess.run(cmd+['-f',m['compose']['path'],'up','-d','--no-deps','--pull','never','phone-cloud'],cwd=r,check=True,timeout=90,stdout=subprocess.DEVNULL)
 for _ in range(90):
  x=subprocess.run(['docker','exec','phone-cloud-platform','node','-e',"fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],capture_output=True)
  if x.returncode==0:break
  time.sleep(1)
 else:raise RuntimeError('readiness_timeout')
 c=json.loads(run('docker','inspect','phone-cloud-platform'))[0];assert c['Image']==m['image']
 expected={**a['cloudRuntimeFiles'],**m['files']};subprocess.run(['docker','exec','-i','phone-cloud-platform','node','-e',check],input=json.dumps(expected),text=True,check=True)
 assert envfile.read_bytes()==oldenv
except Exception as e:
 if switched:
  subprocess.run(cmd+['up','-d','--no-deps','--pull','never','phone-cloud'],cwd=r,check=True,timeout=90,stdout=subprocess.DEVNULL)
  restored=json.loads(run('docker','inspect','phone-cloud-platform'))[0]
  assert restored['Image']==m['rollbackImage']
  subprocess.run(['docker','exec','-i','phone-cloud-platform','node','-e',check],input=json.dumps(a['cloudRuntimeFiles']),text=True,check=True)
  rollback_active=copy.deepcopy(a);rollback_active.update(imageId=restored['Image'],imageTag=a['restartImageTag'],runningContainerId=restored['Id'],runningContainerPid=restored['State']['Pid'],status='rollback-awaiting-health-verification')
  rollback_active['lastFailedDeployment']={'candidate':m['candidate'],'receipt':str(receipt),'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'databaseRestored':False}
  assert p.read_bytes()==raw
  p.write_text(json.dumps(rollback_active,ensure_ascii=False,indent=2)+'\n')
 (receipt/'FAILED.json').write_text(json.dumps({'reason':type(e).__name__,'rolledBack':switched,'databaseRestored':False})+'\n');raise RuntimeError('deployment_failed_see_sanitized_receipt') from None
mediaAfter=json.loads(run(*verify,cwd=r));assert mediaAfter==mediaBefore,'media_baseline_changed_stop_no_auto_repair'
now=datetime.datetime.now(datetime.timezone.utc).isoformat();previous=a['version'];priorReceipt=a['receiptDirectory']
a.update(version='lookup-round-stop-20261016-deployed.1',status='deployed-awaiting-external-api-gray',atUtc=now,recordedAtUtc=now,runtimeCandidateTag=m['candidate'],runtimeCandidateCommit=m['commit'],businessSourceTag=m['candidate'],businessSourceCommit=m['commit'],previousRelease=previous,previousReceiptDirectory=priorReceipt,receiptDirectory=str(receipt),rollbackDirectory=m['backup'],imageId=m['image'],imageTag=m['tag'],restartImageId=m['image'],restartImageTag=m['tag'],productionAcceptanceComplete=False,noProductionServiceRestart=False,restartedComponents=['cloud phone-cloud service'],untouchedComponents=['Windows Agent','ADB','SYSTEM identity','ADB keys','Windows','USB','media'],databaseMigrationsThisRelease=0,cloudCandidatePending=False,userAuthorization='Round stop API candidate and external API validation authorized; maintenance scope approved separately',maintenanceApprovalAt=approval_at,maintenanceApprovedNumbers=approved_numbers)
a['environmentFileSha256']=h(oldenv);a['runningContainerId']=c['Id'];a['runningContainerPid']=c['State']['Pid'];a['branch']='codex/lookup-round-stop-20261016';a['activeCompose']=[*a['activeCompose'],m['compose']];a['cloudRuntimeFiles']=expected;a['hotPatchedRuntimeFiles']=[]
a['roundStopOverlay']={'version':'lookup-round-stop-20261016-deployed.1','commit':m['commit'],'files':m['files'],'includedInImage':True}
for k in ['acceptanceReceiptCommit','acceptanceReceiptTag','receiptCommit','receiptTag']:a[k]=''
a['notVerified']=['Round-stop production ACK, preserved results and next-round external API real-device acceptance pending; prior platform gaps remain']
assert p.read_bytes()==raw;tmp=p.with_suffix('.round-stop.tmp');tmp.write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n');tmp.replace(p)
result={'atUtc':now,'startedAtUtc':started,'version':a['version'],'commit':m['commit'],'runtimeCommit':m['runtimeCommit'],'image':m['image'],'previousImage':m['rollbackImage'],'containerId':c['Id'],'containerStartedAt':c['State']['StartedAt'],'activeSha256':h(p.read_bytes()),'runtimeHashesPassed':len(expected),'occupancyBefore':occupancy,'mediaBefore':mediaBefore,'mediaAfter':mediaAfter,'agentRestarted':False,'adbTouched':False,'databaseRestored':False,'environmentUnchanged':True,'freshBackupBytes':fresh.stat().st_size,'freshBackupSha256':h(fresh.read_bytes()),'receipt':str(receipt)}
(receipt/'DEPLOYED.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
