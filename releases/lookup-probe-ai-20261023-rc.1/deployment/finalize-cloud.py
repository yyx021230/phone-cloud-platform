"""Persist verified cloud-only patch release identity; no service operation."""
import pathlib,subprocess,json,hashlib,time,os,fcntl
os.umask(0o077)
s=pathlib.Path(__file__).resolve().parent;r=pathlib.Path('/opt/phone-cloud-platform');p=r/'ACTIVE_PLATFORM_RELEASE.json'
lock=(r/'.deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
raw=p.read_bytes();assert raw==(s/'ACTIVE.before.json').read_bytes();a=json.loads(raw)
prep=json.loads((s/'PREPARATION_RECEIPT.json').read_text());cloud=json.loads((s/'CLOUD_ACTIVATED.json').read_text())
run=lambda args:subprocess.check_output(args,text=True).strip()
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
assert run(['docker','inspect','phone-cloud-platform','--format','{{.Image}}'])==prep['imageId']
assert sha(r/'.env')==a['environmentFileSha256']
code="const fs=require('fs'),c=require('crypto');const f='/app/server/managed-lookup.mjs';if(c.createHash('sha256').update(fs.readFileSync(f)).digest('hex')!=="+json.dumps(prep['cloudFiles']['server/managed-lookup.mjs']['after'])+")throw Error('hash mismatch')"
run(['docker','exec','phone-cloud-platform','node','-e',code])
version='lookup-probe-ai-20261023-deployed.1';receipt=r/'deploy-receipts'/version;receipt.mkdir(exist_ok=False)
for f in ['ACTIVE.before.json','PREPARATION_RECEIPT.json','MAINTENANCE_STARTED.json','CLOUD_ACTIVATED.json']:(receipt/f).write_bytes((s/f).read_bytes())
previous=a['version'];priorReceipt=a.get('receiptDirectory');stamp=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
a.update(version=version,status='deployed-awaiting-real-phone-observation',atUtc=stamp,recordedAtUtc=stamp,branch='codex/lookup-probe-ai-20261023',runtimeCandidateTag=prep['candidate'],runtimeCandidateCommit=prep['sourceCommit'],businessSourceTag=prep['candidate'],businessSourceCommit=prep['sourceCommit'],previousRelease=previous,previousReceiptDirectory=priorReceipt,previousRestartImageId=prep['previousImage'],receiptDirectory=str(receipt),rollbackDirectory=prep['backup'],imageId=prep['imageId'],restartImageId=prep['imageId'],imageTag=prep['imageTag'],restartImageTag=prep['imageTag'],runningContainerId=cloud['containerId'],runningContainerPid=cloud['containerPid'],hotPatchedRuntimeFiles={},productionAcceptanceComplete=False,databaseMigrationsThisRelease=0,remoteGitPushed=False,rollbackPerformed=False,cloudCandidatePending=False,restartedComponents=['cloud phone-cloud service only'],untouchedComponents=['Windows Agent','ADB process/identity/keys/path/port','Windows OS','USB','media service'],mediaVerification=cloud['media'],receiptCommit='',receiptTag='',acceptanceReceiptCommit='',acceptanceReceiptTag='',notVerified=['New probe AI readiness path on production phones pending observation'])
a['activeCompose']=[*a['activeCompose'],{'path':str(s/'compose.pending.json'),'sha256':sha(s/'compose.pending.json')}]
a['cloudRuntimeFiles']={**a['cloudRuntimeFiles'],'server/managed-lookup.mjs':prep['cloudFiles']['server/managed-lookup.mjs']['after']}
a['probeAiOverlay']={'sourceCommit':prep['sourceCommit'],'candidate':prep['candidate'],'baseVersion':previous,'baseImage':prep['previousImage'],'cloudFiles':{f:h['after'] for f,h in prep['cloudFiles'].items()},'includedInRestartImage':True}
a['runtimeSources']={**a.get('runtimeSources',{}),'probeAi':prep['sourceCommit']}
assert p.read_bytes()==raw;tmp=p.with_suffix('.probe-ai.tmp');tmp.write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n');os.replace(tmp,p)
out={'version':version,'sourceCommit':prep['sourceCommit'],'imageId':prep['imageId'],'previousRelease':previous,'atUtc':stamp,'activeSha256':sha(p),'cloudRuntimeFiles':a['probeAiOverlay']['cloudFiles'],'agentChanged':False,'adbChanged':False,'productionAcceptanceComplete':False}
(receipt/'DEPLOYED.json').write_text(json.dumps(out,indent=2)+'\n');(s/'DEPLOYED.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
