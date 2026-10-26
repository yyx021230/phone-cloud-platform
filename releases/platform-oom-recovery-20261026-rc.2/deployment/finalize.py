"""Record the accepted cloud image only after health, restart and file checks."""
import pathlib,json,subprocess,hashlib,time,fcntl,os,urllib.request
os.umask(0o077)
root=pathlib.Path('/opt/phone-cloud-platform');stage=pathlib.Path(__file__).resolve().parent
lock=(root/'.deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
run=lambda a:subprocess.check_output(a,text=True).strip()
p=stage/'PREPARED.json';prep=json.loads(p.read_text());manifest=json.loads((stage/'MANIFEST.json').read_text());activePath=root/'ACTIVE_PLATFORM_RELEASE.json'
assert sha(activePath)==prep['activeSha256']
a=json.loads(activePath.read_text());c=json.loads(run(['docker','inspect','phone-cloud-platform']))[0]
assert c['State']['Running'] and c['RestartCount']==0 and c['Image']==prep['imageId'] and not c['State']['OOMKilled']
health={}
for route in ['healthz','readyz']:
 with urllib.request.urlopen('http://127.0.0.1:8787/'+route,timeout=10) as r:
  assert r.status==200;health[route]=r.status
code="const fs=require('fs'),c=require('crypto');for(const[f,h]of Object.entries("+json.dumps(manifest['files'])+")){if(c.createHash('sha256').update(fs.readFileSync('/app/'+f)).digest('hex')!==h.after)throw Error(f)}"
run(['docker','exec','phone-cloud-platform','node','-e',code])
media=json.loads(run(['/tmp/phonecloud-node-v22.22.3-linux-x64/node-v22.22.3-linux-x64/bin/node',str(root/'deploy/mediamtx-pacing/verify.mjs'),'--live']));assert media==prep['media']
version='platform-oom-recovery-20261026-deployed.1';out=root/'deploy-receipts'/version;out.mkdir(exist_ok=False)
now=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
receipt={'version':version,'atUtc':now,'sourceCommit':prep['sourceCommit'],'candidateTag':'platform-oom-recovery-20261026-rc.2','imageId':prep['imageId'],'previousRelease':a['version'],'previousImageId':a['imageId'],'replacedFailedImageId':manifest['replacesFailedImage'],'containerId':c['Id'],'containerPid':c['State']['Pid'],'restartCount':c['RestartCount'],'health':health,'files':manifest['files'],'media':media,'backup':prep['backup'],'rollbackDirectory':str(stage/'rollback'),'hostConfigChanged':False,'swapAdded':False,'databaseMigration':False,'agentChanged':False,'adbChanged':False,'pendingFeatureRc5Deployed':False,'productionAcceptanceComplete':False,'readOnlyActualSnapshot':json.loads((stage/'READONLY_SNAPSHOT.json').read_text())}
(out/'DEPLOYED.json').write_text(json.dumps(receipt,indent=2)+'\n');(out/'ACTIVE.before.json').write_bytes(activePath.read_bytes())
a.update(version=version,status='deployed-resource-observation',atUtc=now,recordedAtUtc=now,branch='codex/lookup-oom-recovery-20261026',runtimeCandidateTag='platform-oom-recovery-20261026-rc.2',runtimeCandidateCommit=prep['sourceCommit'],imageId=prep['imageId'],imageTag=prep['imageTag'],restartImageId=prep['imageId'],restartImageTag=prep['imageTag'],runningContainerId=c['Id'],runningContainerPid=c['State']['Pid'],previousRelease=receipt['previousRelease'],previousRestartImageId=receipt['previousImageId'],receiptDirectory=str(out),rollbackDirectory=str(stage/'rollback'),restartedComponents=['cloud'],untouchedComponents=['Windows','Agent','ADB/SYSTEM','USB','media','host configuration'],databaseMigrationsThisRelease=0,productionAcceptanceComplete=False,hotPatchedRuntimeFiles=[],remoteGitPushed=False)
a['activeCompose'].append({'path':str(stage/'compose.pending.json'),'sha256':sha(stage/'compose.pending.json')})
a.setdefault('cloudRuntimeFiles',{}).update({f:h['after'] for f,h in manifest['files'].items()})
a['snapshotStreamingRecovery']=receipt
a['runtimeSources']={'baseProductionCommit':a['businessSourceCommit'],'candidateCommit':prep['sourceCommit'],'candidateTag':'platform-oom-recovery-20261026-rc.2','cloudChangedFiles':list(manifest['files']),'windowsChangedFiles':[],'pendingFeatureRc5Deployed':False}
a['notVerified']=['Long-duration production memory and repeated checkpoint observation still required','Pending lookup rc.5 feature release remains unactivated']
a['userAuthorization']='Urgent platform recovery explicitly requested; user rejected host config/swap changes; only stopped failed cloud container replaced'
tmp=activePath.with_suffix('.tmp');tmp.write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n');tmp.replace(activePath)
(out/'ACTIVE.after.json').write_bytes(activePath.read_bytes());(stage/'DEPLOYED.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
