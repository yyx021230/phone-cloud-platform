# Explicitly authorized on 2026-10-21: lossless JSON column migration and cloud recovery.
from pathlib import Path
import subprocess,json,hashlib,datetime,fcntl,copy,os,time
os.umask(0o077);r=Path('/opt/phone-cloud-platform');p=r/'ACTIVE_PLATFORM_RELEASE.json';lock=(r/'.deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
raw=p.read_bytes();a=json.loads(raw);stage=r/'staging/lookup-snapshot-recovery-20261021-rc.1';m=json.loads((stage/'PREPARED.json').read_text());sha=lambda b:hashlib.sha256(b).hexdigest();run=lambda args:subprocess.check_output(args,text=True).strip()
assert a['status']=='rollback-startup-blocked';old=json.loads(run(['docker','inspect','phone-cloud-platform']))[0];assert not old['State']['Running'];assert old['Image']==m['baselineImage'];assert run(['docker','image','inspect',m['tag'],'--format','{{.Id}}'])==m['image']
verify=['/tmp/phonecloud-node-v22.22.3-linux-x64/node-v22.22.3-linux-x64/bin/node',str(r/'deploy/mediamtx-pacing/verify.mjs'),'--live'];media=json.loads(run(verify));assert media['verified']=='live'
backup=r/'deploy-backups/lookup-ocr-probe-pressure-20261021-prep.1';assert (backup/'postgres.preswitch.dump').stat().st_size>500000000
receipt=r/'deployment-receipts/lookup-snapshot-recovery-20261021-deployed.1';receipt.mkdir();(receipt/'ACTIVE.before.json').write_bytes(raw);env=(r/'.env').read_bytes();assert sha(env)==a['environmentFileSha256']
cmd=['docker','compose','-p','phone-cloud-platform']
for row in a['activeCompose']:assert sha(Path(row['path']).read_bytes())==row['sha256'];cmd+=['-f',row['path']]
compose=stage/'compose.pending.json';compose.write_text(json.dumps({'services':{'phone-cloud':{'image':m['tag']}}},indent=2)+'\n')
before=json.loads(run(cmd+['config','--format','json']));after=json.loads(run(cmd+['-f',str(compose),'config','--format','json']));expected=copy.deepcopy(before);expected['services']['phone-cloud']['image']=m['tag'];assert after==expected
sql="""BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s';
LOCK TABLE phone_cloud_state IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE snapshot_migration_check ON COMMIT DROP AS SELECT state_key, md5(data::text) digest FROM phone_cloud_state;
ALTER TABLE phone_cloud_state ALTER COLUMN data TYPE json USING data::json;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM snapshot_migration_check c FULL JOIN phone_cloud_state s USING(state_key) WHERE c.digest IS DISTINCT FROM md5(s.data::text)) THEN RAISE EXCEPTION 'snapshot content changed'; END IF; END $$;
COMMIT;
SELECT json_build_object('rows',count(*),'textBytes',sum(octet_length(data::text)),'columnType','json','unchangedDigest',true) FROM phone_cloud_state;
"""
print(json.dumps({'phase':'migrating_snapshot_only','atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat()}),flush=True)
result=run(['docker','exec','phone-cloud-postgres','sh','-c','exec psql -X -v ON_ERROR_STOP=1 -A -t -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"','sh',sql]);proof=json.loads([x for x in result.splitlines() if x.startswith('{')][-1]);(receipt/'MIGRATION.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps({'phase':'migration_verified',**proof}),flush=True)
# After this non-destructive migration, never auto-downgrade to jsonb or restore an old database.
subprocess.run(cmd+['-f',str(compose),'up','-d','--no-deps','--pull','never','phone-cloud'],cwd=r,check=True,timeout=60,stdout=subprocess.DEVNULL)
healthy=False
for _ in range(120):
 test=subprocess.run(['docker','exec','phone-cloud-platform','node','-e',"fetch('http://127.0.0.1:8787/readyz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],capture_output=True,timeout=5)
 if test.returncode==0:healthy=True;break
 time.sleep(1)
assert healthy,'recovery_readiness_failed_no_unsafe_db_downgrade'
c=json.loads(run(['docker','inspect','phone-cloud-platform']))[0];assert c['Image']==m['image'];assert c['RestartCount']==0
check="const fs=require('fs'),c=require('crypto');for(const[k,h]of Object.entries(JSON.parse(fs.readFileSync(0,'utf8'))))if(c.createHash('sha256').update(fs.readFileSync('/app/'+k)).digest('hex')!==h)throw Error(k)"
subprocess.run(['docker','exec','-i','phone-cloud-platform','node','-e',check],input=json.dumps(m['expectedRuntimeFiles']),text=True,check=True)
assert (r/'.env').read_bytes()==env;mediaAfter=json.loads(run(verify));assert mediaAfter==media
now=datetime.datetime.now(datetime.timezone.utc).isoformat();previous=a['version'];previousReceipt=a['receiptDirectory']
a.update(version='lookup-snapshot-recovery-20261021-deployed.1',status='deployed-recovery-verified-awaiting-observation',atUtc=now,recordedAtUtc=now,runtimeCandidateTag=m['candidate'],runtimeCandidateCommit=m['commit'],businessSourceTag=m['candidate'],businessSourceCommit=m['commit'],previousRelease=previous,previousReceiptDirectory=previousReceipt,receiptDirectory=str(receipt),rollbackDirectory=str(backup),imageId=m['image'],imageTag=m['tag'],restartImageId=m['image'],restartImageTag=m['tag'],runningContainerId=c['Id'],runningContainerPid=c['State']['Pid'],cloudRuntimeFiles=m['expectedRuntimeFiles'],agentPid=14508,adbPid=8988,databaseMigrationsThisRelease=1,productionAcceptanceComplete=False,restartedComponents=['cloud phone-cloud service'],untouchedComponents=['Windows Agent','ADB','SYSTEM identity','keys','USB','media'],userAuthorization='Explicit user approval for lossless JSON snapshot migration and platform recovery; original OCR candidate deferred',branch='codex/lookup-ocr-probe-pressure-20261020',receiptCommit='',receiptTag='',acceptanceReceiptCommit='',acceptanceReceiptTag='',notVerified=['Original OCR/probe-pressure candidate was rolled back; not deployed','No new physical phone business test during emergency recovery'])
a['snapshotStorage']={'column':'phone_cloud_state.data','type':'json','migrationProof':str(receipt/'MIGRATION.json'),'automaticJsonbDowngradeAllowed':False};a['activeCompose']=[*a['activeCompose'],{'path':str(compose),'sha256':sha(compose.read_bytes())}];a['snapshotRecoveryOverlay']={'commit':m['commit'],'files':{'server/index.mjs':m['expectedRuntimeFiles']['server/index.mjs']},'includedInImage':True}
assert p.read_bytes()==raw;temp=p.with_suffix('.recovery.tmp');temp.write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n');temp.replace(p)
out={'atUtc':now,'version':a['version'],'commit':m['commit'],'image':m['image'],'containerId':c['Id'],'restartCount':c['RestartCount'],'runtimeHashesPassed':len(m['expectedRuntimeFiles']),'migration':proof,'mediaBefore':media,'mediaAfter':mediaAfter,'agentPid':14508,'adbPid':8988,'agentRestarted':False,'adbTouched':False,'originalLookupCandidateDeployed':False,'receipt':str(receipt),'activeSha256':sha(p.read_bytes())};(receipt/'DEPLOYED.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out),flush=True)
