from pathlib import Path
import subprocess,json,hashlib,time,datetime,os,sys
os.umask(0o077)
p=Path('/opt/phone-cloud-platform');s=p/'staging/lookup-readiness-20261015-rc.8';b=p/'deploy-backups/lookup-readiness-20261015-prep.8-maintenance1'
hashfile=lambda f:hashlib.sha256(Path(f).read_bytes()).hexdigest()
run=lambda args,**kw:subprocess.check_output(args,text=True,**kw)
afile=p/'ACTIVE_PLATFORM_RELEASE.json';initial=afile.read_bytes();a=json.loads(initial);assert a['version']=='lookup-readiness-20261015-deployed.8-agent.1'
proof=json.loads((s/'IMAGE.json').read_text());backup=json.loads((b/'BACKUP.json').read_text());expected=json.loads((s/'EXPECTED.json').read_text())
old=['docker','compose','-p','phone-cloud-platform']
for r in a['activeCompose']:
 assert hashfile(r['path'])==r['sha256'];old+=['-f',r['path']]
for r in backup['configs']:assert hashfile(r['source'])==r['sha256']
layer=s/'compose.pending.json';assert hashfile(layer)==proof['pendingComposeSha256'];new=old+['-f',str(layer)]
x=json.loads(run(old+['config','--format','json'],cwd=p));y=json.loads(run(new+['config','--format','json'],cwd=p))
for name,v in x['services'].items():
 for k in set(v)|set(y['services'][name]):
  if name=='phone-cloud' and k in ['image','labels']:continue
  assert v.get(k)==y['services'][name].get(k),(name,k)
c=json.loads(run(['docker','inspect','phone-cloud-platform']))[0];assert c['Image']==proof['baseImageId']
assert a['agentOverlay']['sourceCommit']=='9d49e66799bfaa3a68d9f57a0fea64052d888ea3'
media=['/tmp/phonecloud-node-v22.22.3-linux-x64/node-v22.22.3-linux-x64/bin/node','deploy/mediamtx-pacing/verify.mjs','--live']
pre=json.loads(run(media,cwd=p));assert pre['verified']=='live'
js="""const h={authorization:'Bearer '+process.env.ADMIN_API_TOKEN};const g=async p=>(await fetch('http://127.0.0.1:8787'+p,{headers:h})).json();const {metrics:m}=await g('/api/v1/metrics/operations');const {pool:p}=await g('/api/v1/admin/lookup-pool');console.log(JSON.stringify({at:new Date(),queue:m.queue,screens:m.realtime.sessions.active,enabled:p.config.enabled,channels:p.channels.length,revision:p.configRevision}));"""
gate=json.loads(run(['docker','exec','-i','phone-cloud-platform','node','--input-type=module'],input=js));q=gate['queue'];assert not gate['enabled'] and gate['channels']==0
if any(q.get(k,0) for k in ['xhsActive','windowsQueued','windowsRunning','windowsStalled']):
 print(json.dumps({'waiting':True,'gate':gate}));sys.exit(3)
assert afile.read_bytes()==initial
receipt_dir=p/'deployment-receipts/lookup-readiness-20261015-deployed.8';receipt_dir.mkdir(exist_ok=False);(receipt_dir/'ACTIVE.before.json').write_bytes(initial);(receipt_dir/'GATE.json').write_text(json.dumps(gate,indent=2)+'\n')
try:
 subprocess.run(new+['up','-d','--no-deps','--no-build','phone-cloud'],cwd=p,check=True,timeout=60,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 for _ in range(120):
  chk=subprocess.run(['docker','exec','phone-cloud-platform','node','-e',"fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
  if chk.returncode==0:break
  time.sleep(1)
 assert chk.returncode==0,'ready failed'
 c2=json.loads(run(['docker','inspect','phone-cloud-platform']))[0];assert c2['Image']==proof['imageId']
 js2="const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries(JSON.parse(fs.readFileSync(0,'utf8')).map(n=>[n,c.createHash('sha256').update(fs.readFileSync('/app/'+n)).digest('hex')]))));"
 actual=json.loads(run(['docker','exec','-i','phone-cloud-platform','node','-e',js2],input=json.dumps(list(expected))));assert actual==expected
 post=json.loads(run(media,cwd=p));assert post==pre
except Exception:
 subprocess.run(old+['up','-d','--no-deps','--no-build','phone-cloud'],cwd=p,check=True,timeout=60,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 (receipt_dir/'ROLLBACK.json').write_text(json.dumps({'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'oldImage':proof['baseImageId'],'dataRestored':False})+'\n');raise
r=dict(a);r.update(version='lookup-readiness-20261015-deployed.8',status='deployed-gray-incomplete',atUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),runtimeCandidateTag=proof['version'],runtimeCandidateCommit=proof['sourceCommit'],businessSourceTag=proof['version'],businessSourceCommit=proof['sourceCommit'],imageId=proof['imageId'],imageTag=proof['imageTag'],restartImageId=proof['imageId'],restartImageTag=proof['imageTag'],runningContainerId=c2['Id'],runningContainerPid=c2['State']['Pid'],activeCompose=a['activeCompose']+[{'path':str(layer),'sha256':hashfile(layer)}],previousRelease=a['version'],previousReceiptCommit=a['receiptCommit'],previousRestartImageId=a['imageId'],previousReceiptDirectory=a['receiptDirectory'],receiptDirectory=str(receipt_dir),rollbackDirectory=str(b),userAuthorization='2026-10-15 14:41: user approved current ten-minute maintenance for shared Agent/ADB, exact162 driver and drained cloud rc8; no Windows/Hub/media restart',databaseMigrationsThisRelease=[],noProductionServiceRestart=False,restartedComponents=['cloud business container','Windows Agent','ADB server'],untouchedComponents=['Windows','USB Hub','media service'],targetedIdleLookupWorkersRefreshed=[],mediaVerification=post,cloudFilesVerified=len(expected),maintenanceGate=gate,productionAcceptanceComplete=False,notVerified=['Remaining21 unauthorized devices after ADB restart','Initial physical USB loss root cause','Other phone driver collision migration','Alternate162 USB mode','155 historical worker exit cause','Natural limit transfer and eight-hour cooling expiry this run'])
r['cloudRuntimeFiles']=dict(a['cloudRuntimeFiles'])
for name in ['server/managed-lookup.mjs','server/lookup-readiness.mjs','server/lookup-device-availability.mjs','public/lookup-pool.js','public/lookup-pool.html']:
 if name in expected:r['cloudRuntimeFiles'][name]=expected[name]
r['managedLookup']=dict(a['managedLookup'],configRevision=gate['revision'],poolEnabled=False,activeGrayChannels=0)
r['grayResult']=dict(a['grayResult'],pendingCloudFix=None)
r['cloudCandidatePending']=None
r['apiDocsDeploymentCaveat']='Prepared lookup API and three-failure quarantine deployed; full pool remains disabled; remaining gray had5 completed and162 timeout, not full acceptance'
r['agentPid']=634228
r.pop('adbServerPidUnchanged',None)
r['adbServerPid']=634172
r['previousAdbServerPid']=312588
r['agentOverlay']=dict(a['agentOverlay'],sharedAgentRestarted=True)
r['windowsDriverRemediation']={'deviceNumber':162,'sourceCommit':'2b0c5fc448adebccb6801a51952c71cc78378616','inf':'winusb.inf','section':'ADB','needReboot':False,'backupDirectory':r'D:\PhoneCloud\agent\backups\adb-driver-162-20261015-prep1','allDevicesRemediated':False}
r['agentFiles']['windows-agent/adb-auth-env.cjs']='9c3aa5affb9243f255f2bf74376ee7bb01c9f9171989f5477146263ee7e2bb4d'
r['agentAuthPreload']={'sourceCommit':'bf4ed5355613c418faa49b501a05248c29379607','path':r'D:\PhoneCloud\agent\adb-auth-env.cjs','existingKeyFiles':2,'privateKeysModified':False,'unauthorizedDevicesRemaining':21,'scheduledTaskBackup':r'D:\PhoneCloud\agent\backups\adb-driver-162-20261015-prep1\AGENT-TASK.before.xml'}
r.pop('receiptCommit',None);r.pop('receiptTag',None)
(receipt_dir/'DEPLOYMENT.json').write_text(json.dumps(r,indent=2)+'\n');tmp=afile.with_suffix('.tmp');tmp.write_text(json.dumps(r,indent=2)+'\n');tmp.replace(afile)
print(json.dumps({'activated':True,'version':r['version'],'imageId':r['imageId'],'gate':gate,'filesVerified':len(expected),'media':post,'receiptDirectory':str(receipt_dir)}))
