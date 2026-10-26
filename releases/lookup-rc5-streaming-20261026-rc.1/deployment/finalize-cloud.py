"""Record the verified cloud + Windows deployment; never reload a service."""
import pathlib,json,hashlib,subprocess,fcntl,time,os
os.umask(0o077)
r=pathlib.Path('/opt/phone-cloud-platform');s=pathlib.Path(__file__).resolve().parent
lock=(r/'.deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
p=r/'ACTIVE_PLATFORM_RELEASE.json';raw=p.read_bytes();assert raw==(s/'ACTIVE.before.json').read_bytes()
a=json.loads(raw);prep=json.loads((s/'PREPARATION_RECEIPT.json').read_text());cloud=json.loads((s/'CLOUD_ACTIVATED.json').read_text());win=json.loads((s/'WINDOWS_ACTIVATED.json').read_text(encoding='utf-8-sig'));m=json.loads((s/'MAINTENANCE_STARTED.json').read_text())
run=lambda args:subprocess.check_output(args,text=True).strip()
sha=lambda path:hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
assert run(['docker','inspect','phone-cloud-platform','--format','{{.Image}}'])==prep['imageId']
assert win['sourceCommit']==prep['featureCommit'] and win['adbUnchanged'] and win['agentOwner']=='NT AUTHORITY\\SYSTEM'
assert sha(r/'.env')==a['environmentFileSha256']
code="const fs=require('fs'),c=require('crypto');for(const[f,h]of Object.entries("+json.dumps(prep['cloudFiles'])+")){if(c.createHash('sha256').update(fs.readFileSync('/app/'+f)).digest('hex')!==h.after)throw Error(f)}"
run(['docker','exec','phone-cloud-platform','node','-e',code])
version='lookup-rc5-streaming-20261026-deployed.1';receipt=r/'deploy-receipts'/version;receipt.mkdir(exist_ok=False)
for f in ['ACTIVE.before.json','PREPARATION_RECEIPT.json','MAINTENANCE_STARTED.json','CLOUD_ACTIVATED.json','WINDOWS_ACTIVATED.json']:(receipt/f).write_bytes((s/f).read_bytes())
now=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime());previous=a['version'];previousReceipt=a.get('receiptDirectory')
a.update(version=version,status='deployed-awaiting-real-phone-observation',atUtc=now,recordedAtUtc=now,branch='codex/lookup-oom-recovery-20261026',runtimeCandidateTag='lookup-rc5-streaming-20261026-rc.1',runtimeCandidateCommit=prep['sourceCommit'],businessSourceTag='lookup-ai-coverage-20261025-rc.5',businessSourceCommit=prep['featureCommit'],previousRelease=previous,previousReceiptDirectory=previousReceipt,previousRestartImageId=prep['previousImage'],receiptDirectory=str(receipt),rollbackDirectory=str(s/'rollback'),windowsRollbackDirectory='D:\\PhoneCloud\\staging\\lookup-ai-coverage-20261026-rc5\\rollback',imageId=prep['imageId'],restartImageId=prep['imageId'],imageTag=prep['imageTag'],restartImageTag=prep['imageTag'],runningContainerId=cloud['containerId'],runningContainerPid=cloud['containerPid'],previousAgentPid=win['previousAgentPid'],agentPid=win['agentPid'],adbPid=win['adbPid'],adbServerPid=win['adbPid'],hotPatchedRuntimeFiles={},productionAcceptanceComplete=False,databaseMigrationsThisRelease=0,remoteGitPushed=False,rollbackPerformed=False,noProductionServiceRestart=False,cloudCandidatePending=False,restartedComponents=['cloud phone-cloud service','Windows Agent via unchanged SYSTEM scheduled task'],untouchedComponents=['ADB process/identity/keys/path/port','Windows OS','USB','media service'],mediaVerification=cloud['media'],maintenanceWindowControlDisconnectAuthorized=True,maintenanceActualNumbers=m['occupancy']['controls'],maintenanceApprovalAt=m['atUtc'],userAuthorization=m['authorization'],receiptCommit='',receiptTag='',acceptanceReceiptCommit='',acceptanceReceiptTag='',notVerified=['Combined external API to native Agent, persisted cooldown, automatic handoff, cards and notifications require post-deployment gray verification','112 application network failure and intermittent transport causes remain unproven','No guarantee of all production failure branches covered'])
a['activeCompose']=[*a['activeCompose'],{'path':str(s/'compose.pending.json'),'sha256':sha(s/'compose.pending.json')}]
a['agentFiles']={**a.get('agentFiles',{}),**{'windows-agent/'+f:h['after'] for f,h in win['files'].items()}}
a['cloudRuntimeFiles']={**a.get('cloudRuntimeFiles',{}),**{f:h['after'] for f,h in prep['cloudFiles'].items()}}
a['lookupRecoveryOverlay']={'sourceCommit':prep['sourceCommit'],'candidate':'lookup-ai-coverage-20261025-rc.5','baseVersion':previous,'baseImage':prep['previousImage'],'cloudFiles':{f:h['after'] for f,h in prep['cloudFiles'].items()},'windowsFiles':{f:h['after'] for f,h in win['files'].items()},'includedInRestartImage':True,'iconExperimentIncluded':False}
a['runtimeSources']={**a.get('runtimeSources',{}),'candidateCommit':prep['sourceCommit'],'candidateTag':'lookup-rc5-streaming-20261026-rc.1','lookupRecovery':prep['featureCommit'],'storageRecovery':'e16fc3333ea6ce6401083694909e1eef47da8d9c','pendingFeatureRc5Deployed':True}
a['snapshotStreamingRecovery']['carriedByCommit']=prep['sourceCommit']
a['snapshotStreamingRecovery']['includedInRestartImage']=True
assert p.read_bytes()==raw
pending=p.with_suffix('.final-rc1.tmp');pending.write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n');os.replace(pending,p)
out={'version':version,'atUtc':now,'sourceCommit':prep['sourceCommit'],'imageId':prep['imageId'],'changedCloudFiles':len(prep['cloudFiles']),'windowsFiles':len(win['files']),'agentPid':win['agentPid'],'adbPid':win['adbPid'],'media':cloud['media'],'activeSha256':sha(p),'previousVersion':previous,'rollbackDirectory':str(s/'rollback'),'productionAcceptanceComplete':False,'iconExperimentIncluded':False}
(receipt/'DEPLOYED.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
