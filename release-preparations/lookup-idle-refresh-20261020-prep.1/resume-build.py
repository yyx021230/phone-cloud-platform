from pathlib import Path
import json,hashlib,subprocess,os,shutil,fcntl,datetime
os.umask(0o077)
r=Path('/opt/phone-cloud-platform'); stage=r/'staging/lookup-idle-refresh-20261020-rc.1'; inp=json.loads((stage/'INPUT.json').read_text()); raw=(r/'ACTIVE_PLATFORM_RELEASE.json').read_bytes();a=json.loads(raw)
h=lambda b:hashlib.sha256(b).hexdigest()
def run(*args,**kw):return subprocess.check_output(args,text=True,**kw).strip()
lock=(r/'.deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
c=json.loads(run('docker','inspect','phone-cloud-platform'))[0]
assert c['Id']==a['runningContainerId'] and c['Image']==a['imageId']
assert run('docker','image','inspect',a['restartImageId'],'--format','{{.Id}}')==a['restartImageId']
expected={**a['cloudRuntimeFiles'],**a.get('recoveryFeedbackOverlay',{}).get('files',{})}
check="const fs=require('fs'),c=require('crypto');const m=JSON.parse(fs.readFileSync(0,'utf8'));for(const[p,s]of Object.entries(m)){const q='/app/'+p;const v=fs.existsSync(q)?c.createHash('sha256').update(fs.readFileSync(q)).digest('hex'):null;if(v!==s)throw Error('hash:'+p)}"
for args in [['docker','exec','-i','phone-cloud-platform','node','-e',check],['docker','run','--rm','--network','none','-i','--entrypoint','node',a['restartImageId'],'-e',check]]:
 subprocess.run(args,input=json.dumps({**expected,**inp['before']}),text=True,check=True,capture_output=True,timeout=40)
for row in a['activeCompose']:assert h(Path(row['path']).read_bytes())==row['sha256']
assert shutil.disk_usage(r).free>4*1024**3,'insufficient_backup_space'
verify=['/tmp/phonecloud-node-v22.22.3-linux-x64/node-v22.22.3-linux-x64/bin/node',str(r/'deploy/mediamtx-pacing/verify.mjs'),'--live'];media=json.loads(run(*verify,cwd=r));assert media['verified']=='live'
backup=r/'deploy-backups/lookup-idle-refresh-20261020-prep.1';assert (backup/'ACTIVE.before.json').read_bytes()==raw;assert (backup/'postgres.dump').stat().st_size>0 and (backup/'previous-restart-image.tar').stat().st_size>0
assert run('docker','image','inspect',a['restartImageTag'],'--format','{{.Id}}')==a['restartImageId']
tag='phone-cloud-platform:lookup-idle-refresh-20261020-rc.1'
(stage/'Dockerfile').write_text('FROM '+a['restartImageTag']+'\nCOPY payload/ /app/\nLABEL org.opencontainers.image.revision="'+inp['commit']+'"\n')
with (stage/'build.log').open('w') as log:subprocess.run(['docker','build','--network','none','--pull=false','-t',tag,str(stage)],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=180)
image=run('docker','image','inspect',tag,'--format','{{.Id}}')
merged={**expected,**inp['files']}
subprocess.run(['docker','run','--rm','--network','none','-i','--entrypoint','node',image,'-e',check],input=json.dumps(merged),text=True,check=True,capture_output=True,timeout=30)
compose=stage/'compose.pending.json';compose.write_text(json.dumps({'services':{'phone-cloud':{'image':tag}}},indent=2)+'\n')
cmd=['docker','compose','-p','phone-cloud-platform']
for row in a['activeCompose']:cmd+=['-f',row['path']]
old=json.loads(run(*cmd,'config','--format','json',cwd=r));new=json.loads(run(*cmd,'-f',str(compose),'config','--format','json',cwd=r));old['services']['phone-cloud']['image']=tag;assert old==new
assert (r/'ACTIVE_PLATFORM_RELEASE.json').read_bytes()==raw
prepared={**inp,'baselineActiveSha256':h(raw),'containerId':c['Id'],'image':image,'tag':tag,'rollbackImage':a['restartImageId'],'rollbackTag':a['restartImageTag'],'backup':str(backup),'compose':{'path':str(compose),'sha256':h(compose.read_bytes())},'envBeforeSha256':h((r/'.env').read_bytes()),'inheritedFiles':expected,'mediaBefore':media,'backupBytes':(backup/'postgres.dump').stat().st_size,'backupSha256':h((backup/'postgres.dump').read_bytes()),'createdAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(stage/'PREPARED.json').write_text(json.dumps(prepared,indent=2)+'\n')
print(json.dumps({'phase':'built_not_activated','image':image,'filesVerified':len(merged),'backupBytes':prepared['backupBytes'],'composeOnlyImageChanged':True}),flush=True)
