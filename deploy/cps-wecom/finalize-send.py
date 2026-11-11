"""Record the CPS-only activation and static docs, without restarting anything."""
import copy,datetime,hashlib,json,os,subprocess
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import urlsplit
stage=Path('/opt/phone-cloud-staging/wecom-cps-send-20261111-rc.1')
receipt=Path('/opt/phone-cloud-staging/wecom-cps-send-20261111-deployed.1')
root=Path('/opt/phone-cloud-platform');active=root/'ACTIVE_PLATFORM_RELEASE.json'
sha=lambda b:hashlib.sha256(b).hexdigest()
def cmd(args,**kw):return subprocess.check_output(args,text=True,timeout=40,**kw).strip()
def inspect(n):return json.loads(cmd(['docker','inspect',n]))[0]
def query(db,sql):return json.loads(cmd(['docker','exec','-i','phone-cloud-postgres','psql','-X','-qAt','-U','phone_cloud','-d',db,'-v','ON_ERROR_STOP=1'],input="BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; "+sql+';COMMIT;'))
raw=active.read_bytes();assert sha(raw)=='cfd4dcf0bc510ead8ba2556f6c4e3b33d722b0d8114f4f67e26a9394cf85203c'
old=json.loads(raw);main=inspect('phone-cloud-platform');cps=inspect('phone-cloud-cps-wecom')
assert main['Id']==old['runningContainerId']and main['State']['Pid']==1730700 and main['State']['StartedAt']==old['mainStartedAt']
assert main['State']['Health']['Status']=='healthy'and cps['Id']=='88703bcbe6da15af62e45258f09320e782f82b6514e6f73fb19d6bbc3b261241'
env=dict(x.split('=',1)for x in cps['Config']['Env']);assert env['CPS_EXECUTION_MODE']=='send'and env['CPS_STATE_KEY']=='production'and cps['Config']['User']=='node'
old_cps=inspect('phone-cloud-cps-wecom-preview-rollback-20261111');before=dict(x.split('=',1)for x in old_cps['Config']['Env'])
assert sorted(k for k in set(before)|set(env)if before.get(k)!=env.get(k))==['CPS_EXECUTION_MODE','CPS_STATE_KEY']
assert cps['Image']==old_cps['Image']=='sha256:4c3823e7aab5328c6e9ecfa37683ea210405fdddb14c0d52f61664812f755b33'
tag='phone-cloud-platform:wecom-cps-send-20261111-rc.5';next_image='sha256:16e06c48a5fb32a92ba14b8d22d9c814341bb143f23c4fe1205426bab6b322d7'
assert cmd(['docker','image','inspect','--format','{{.Id}}',tag])==next_image
script="const fs=require('fs'),c=require('crypto');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const o={};for(const p of JSON.parse(s))o[p]=c.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex');console.log(JSON.stringify(o))})"
paths=json.dumps(list(old['cloudRuntimeFiles']));hashes=json.loads(cmd(['docker','exec','-i','phone-cloud-platform','node','-e',script],input=paths))
diff={k:v for k,v in hashes.items()if old['cloudRuntimeFiles'][k]!=v}
assert diff=={'public/cps-wecom-integration-api.md':'ee761208e5e81707cd246e02f59ed97df08da30291e1540e5049031ccb6f5a6e'}
future=json.loads(cmd(['docker','run','--rm','-i','--network=none','--read-only','--cap-drop=ALL','--pids-limit=32','--memory=256m','--entrypoint=node',tag,'-e',script],input=paths));assert future==hashes
db=urlsplit(env['CPS_DATABASE_URL']).path.lstrip('/');states=query(db,'SELECT jsonb_object_agg(state_key,data) FROM phone_cloud_cps_wecom')
sources=json.loads((stage/'private/journals.before.private.json').read_text());assert all(states[x['key']]==x['data']for x in sources)
seed=json.loads((stage/'private/send-seed.private.json').read_text());formal=states['production'];assert formal['executionMode']=='send'
key=lambda x:(x['appId'],x['leadId']);current={key(x):x for x in formal['leads']};assert all(current[key(x)]==x for x in seed['leads'])
health={}
for port,path,name in [(8787,'healthz','main'),(8787,'readyz','ready'),(8797,'healthz','cps')]:
 with urlopen('http://127.0.0.1:'+str(port)+'/'+path,timeout=5)as r:health[name]=r.status
assert all(x==200 for x in health.values())
with urlopen('http://47.98.127.132/cps-wecom-integration-api.md',timeout=5)as r:assert r.status==200 and sha(r.read(131072))==diff['public/cps-wecom-integration-api.md']
media=json.loads(cmd(['/proc/1730700/root/lib/ld-musl-x86_64.so.1','--library-path','/proc/1730700/root/lib:/proc/1730700/root/usr/lib','/proc/1730700/root/usr/local/bin/node',str(root/'deploy/mediamtx-pacing/verify.mjs'),'--live']))
assert media['verified']=='live'and media['pid']==2503525 and media['bitsPerSecond']==8000000 and media['packetsPerGroup']==2
receipt.mkdir(mode=0o700,exist_ok=True);(receipt/'ACTIVE.before.json').write_bytes(raw)
overlay=receipt/'compose.pending.json';overlay.write_text(json.dumps({'services':{'phone-cloud':{'image':tag}}},indent=2)+'\n')
def compose(files):
 args=['docker','compose','--project-directory',str(root)]
 for p in files:args+=['-f',p]
 return json.loads(cmd(args+['config','--no-interpolate','--no-env-resolution','--format','json']))
b=compose(old['activeCompose']);a=compose(old['activeCompose']+[str(overlay)]);assert a['services']['phone-cloud']['image']==tag;a['services']['phone-cloud']['image']=b['services']['phone-cloud']['image'];assert a==b
at=datetime.datetime.now(datetime.timezone.utc).isoformat();activation=json.loads((stage/'activated.json').read_text())
r={'version':'wecom-cps-send-20261111-deployed.1','atUtc':at,'branch':'codex/wecom-cps-send-20261111','candidateTag':'wecom-cps-send-20261111-rc.5','codeCommit':'6116477bdb12fa56169e7dab7051db44de4917d9','previousActiveSha256':sha(raw),'activation':activation,'mode':'send','stateKey':'production','formalAdmissionOpen':True,'formalAcceptanceComplete':False,'oldPreviewLeadsRetained':len(seed['leads']),'recipientGuardsRetained':len(seed['recipients']),'oldSourcesAndLeadsUnchanged':True,'newFormalLeadsObserved':len(formal['leads'])-len(seed['leads']),'oldPreviewsReplayed':0,'callbackAttemptsOnOldPreviews':0,'mainContainerId':main['Id'],'mainPid':1730700,'mainStartedAt':main['State']['StartedAt'],'mainReloads':0,'agentReloads':0,'adbChanges':0,'cpsImageId':cps['Image'],'cpsUser':'node','cpsContainerId':cps['Id'],'cpsStartedAt':cps['State']['StartedAt'],'runningMainImageId':main['Image'],'nextMainImageId':next_image,'nextMainImageTag':tag,'cloudRuntimeFilesVerified':len(hashes),'cloudChangedFiles':diff,'health':health,'mediaVerification':media,'publicSignedDeviceQuery':{'http':200,'targetsOnlineAvailable':['200','202'],'legacyCorpMemberIdsAbsent':True},'publicMalformedDispatch':{'http':200,'code':2003,'taskCreated':False},'callbackTlsHead':200,'callbackBusinessPostTested':False,'configSha256':sha(Path('/opt/phone-cloud-staging/wecom-cps-rc3-20261110/bridge.env').read_bytes()),'testSummary':{'localPassed':59,'localSkippedOptionalPg':1,'localFailed':0,'sourceSeedGuardCases':11,'realDbReadOnlyPreflight':True,'realDbTransactionalSeed':True},'rollbackDirectory':str(stage),'notVerified':['First fresh CPS lead actual invitation, confirmation and automatic business callback','202 new non-contact remark/send-page path'],'receiptCommitPending':True}
(receipt/'deployment.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
d=copy.deepcopy(old);d['previousCpsSendBaseline']={'version':old['version'],'activeSha256':sha(raw),'restartImageId':old['restartImageId'],'receiptCommit':old['receiptCommit']}
d.update(version=r['version'],status='formal_cps_admission_open_pending_first_lead',atUtc=at,branch=r['branch'],runtimeCandidateTag=r['candidateTag'],runtimeCandidateCommit=r['codeCommit'],restartImageId=next_image,restartImageTag=tag,receiptDirectory=str(receipt),receiptDirectoryInRepository='releases/wecom-cps-send-20261111-deployed.1',receiptBindingStatus='pending_receipt_commit',userAuthorization='Existing production activation authorization; user requested actual CPS integration; independent CPS only',restartedComponents=['independent CPS bridge only; idle pilot preview services retired'],productionAcceptanceComplete=False)
d['cloudRuntimeFiles']=hashes;d['activeCompose'].append(str(overlay));d['cpsFormalActivation']=r;d['cpsExecutorOverlay']['formalSendEnabled']=True
assert active.read_bytes()==raw
temporary=active.with_suffix('.json.send-tmp')
with temporary.open('x')as f:json.dump(d,f,ensure_ascii=False,indent=2);f.write('\n')
os.replace(temporary,active);r['activeBeforeReceiptBindingSha256']=sha(active.read_bytes());(receipt/'deployment.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'version':r['version'],'mode':'send','formalAdmissionOpen':True,'activeSha256':sha(active.read_bytes()),'nextMainImageId':next_image,'health':health,'newFormalLeadsObserved':r['newFormalLeadsObserved']}))
