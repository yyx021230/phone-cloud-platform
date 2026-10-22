"""Bind verified running/restart components to the release receipt; no restart."""
import pathlib,json,hashlib,subprocess,fcntl,time,os
os.umask(0o077)
root=pathlib.Path('/opt/phone-cloud-platform');stage=pathlib.Path(__file__).resolve().parent
lock=(root/'.deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
path=root/'ACTIVE_PLATFORM_RELEASE.json';raw=path.read_bytes();assert raw==(stage/'ACTIVE.before.json').read_bytes()
a=json.loads(raw);p=json.loads((stage/'PREPARATION_RECEIPT.json').read_text());c=json.loads((stage/'CLOUD_ACTIVATED.json').read_text());w=json.loads((stage/'WINDOWS_ACTIVATED.json').read_text());maintenance=json.loads((stage/'MAINTENANCE_STARTED.json').read_text())
run=lambda args:subprocess.check_output(args,text=True).strip()
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
assert run(['docker','inspect','phone-cloud-platform','--format','{{.Image}}'])==p['imageId']
assert sha(root/'.env')==a['environmentFileSha256']
files={**a.get('cloudRuntimeFiles',{}),**{f:h['after'] for f,h in p['cloudFiles'].items()}}
code="const fs=require('fs'),c=require('crypto');for(const[f,h]of Object.entries("+json.dumps(files)+")){if(c.createHash('sha256').update(fs.readFileSync('/app/'+f)).digest('hex')!==h)throw Error(f)}"
run(['docker','exec','phone-cloud-platform','node','-e',code])
previous=a['version'];version='lookup-throughput-20261022-deployed.1';receipt=root/'deploy-receipts'/version;receipt.mkdir()
for f in ['ACTIVE.before.json','PREPARATION_RECEIPT.json','MAINTENANCE_STARTED.json','CLOUD_ACTIVATED.json','WINDOWS_ACTIVATED.json','HELPER_GRANTED.json','COMPOSE_PREVIEW.json']:(receipt/f).write_bytes((stage/f).read_bytes())
now=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
a.update(version=version,status='deployed-awaiting-real-phone-observation',atUtc=now,recordedAtUtc=now,branch='codex/lookup-unavailable-20261022',runtimeCandidateTag='lookup-throughput-20261022-rc.4',runtimeCandidateCommit=p['sourceCommit'],businessSourceTag='lookup-throughput-20261022-rc.4',businessSourceCommit=p['sourceCommit'],previousRelease=previous,previousReceiptDirectory=a['receiptDirectory'],previousRestartImageId=p['previousImage'],receiptDirectory=str(receipt),rollbackDirectory=str(stage/'rollback'),windowsRollbackDirectory='D:\\PhoneCloud\\staging\\lookup-throughput-20261022-rc.4-prep.1\\rollback',imageId=p['imageId'],restartImageId=p['imageId'],imageTag=p['imageTag'],restartImageTag=p['imageTag'],runningContainerId=c['containerId'],runningContainerPid=c['containerPid'],previousAgentPid=w['previousAgentPid'],agentPid=w['agentPid'],adbPid=w['adbPid'],adbServerPid=w['adbPid'],cloudRuntimeFiles=files,cloudFilesVerified=len(files),hotPatchedRuntimeFiles={},productionAcceptanceComplete=False,databaseMigrationsThisRelease=0,remoteGitPushed=False,rollbackPerformed=False,noProductionServiceRestart=False,cloudCandidatePending=False,restartedComponents=['cloud phone-cloud service','Windows Agent via unchanged SYSTEM scheduled task'],untouchedComponents=['ADB process/identity/keys/path/port','Windows OS','USB','media service'],mediaVerification=c['media'],maintenanceWindowControlDisconnectAuthorized=True,maintenanceActualNumbers=maintenance['occupancy']['controls'],maintenanceApprovalAt=maintenance['atUtc'],userAuthorization=maintenance['authorization'],receiptCommit='',receiptTag='',acceptanceReceiptCommit='',acceptanceReceiptTag='',notVerified=['No new physical-phone business queries during release','Natural cooldown/handoff and production queue improvements require live observations','Existing device HTTP 401 root cause not resolved'])
a['activeCompose']=[*a['activeCompose'],{'path':str(stage/'compose.pending.json'),'sha256':sha(stage/'compose.pending.json')}]
a['agentFiles']={**a.get('agentFiles',{}),**{'windows-agent/'+f:h['after'] for f,h in w['files'].items()}}
a['lookupThroughputOverlay']={'sourceCommit':p['sourceCommit'],'candidate':'lookup-throughput-20261022-rc.4','cloudFiles':{f:h['after'] for f,h in p['cloudFiles'].items()},'windowsFiles':{f:h['after'] for f,h in w['files'].items()},'helperGrantReceipt':str(receipt/'HELPER_GRANTED.json'),'includedInRestartImage':True}
a['runtimeSources']={**a.get('runtimeSources',{}),'lookupThroughput':p['sourceCommit']}
assert path.read_bytes()==raw;tmp=path.with_suffix('.rc4.tmp');tmp.write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n');tmp.replace(path)
out={'version':version,'atUtc':now,'sourceCommit':p['sourceCommit'],'imageId':p['imageId'],'runtimeHashesPassed':len(files),'changedCloudFiles':len(p['cloudFiles']),'windowsFiles':len(w['files']),'agentPid':w['agentPid'],'adbPid':w['adbPid'],'media':c['media'],'activeSha256':sha(path),'previousVersion':previous,'rollbackDirectory':str(stage/'rollback'),'maintenanceStartedAt':maintenance['atUtc'],'cloudReadyAt':c['atUtc'],'helperGrants':10,'productionAcceptanceComplete':False}
(receipt/'DEPLOYED.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
