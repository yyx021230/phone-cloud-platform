import subprocess,json,pathlib,hashlib,datetime,sys,time
assert sys.argv[1:]==['--root-go-phase1'],'explicit root phase1 gate required'
R=pathlib.Path('/opt/phone-cloud-platform');S=R/'staging/platform-integration-20261102-rc.1'
assert hashlib.sha256((R/'ACTIVE_PLATFORM_RELEASE.json').read_bytes()).hexdigest()=='a0b5b612359d617c2cbe1841189b69d566203fd308a80f46ae149bce51f2bb2a'
app=json.loads(subprocess.check_output(['docker','inspect','phone-cloud-platform']))[0]
assert app['State']['Running'] and app['Image']=='sha256:a4db69c8a61befac7591924e354227146cb97fc6574556da35a2b86b7ddd6b4d'
assert not (S/'receipts/PHASE1_DONE.json').exists(),'phase1 already completed; inspect instead of replaying'
subprocess.run(['/tmp/phonecloud-node-v22.22.3-linux-x64/node-v22.22.3-linux-x64/bin/node',str(R/'deploy/mediamtx-pacing/verify.mjs'),'--live'],check=True,timeout=25)
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
preSql="""SET statement_timeout=15000;BEGIN READ ONLY;
SELECT json_build_object('pool',(select data from phone_cloud_managed_lookup where state_key='default'),'windows',(select coalesce(json_agg(t),'[]') from phone_cloud_windows_tasks t where status not in ('succeeded','failed','cancelled','expired')),'jobs',(select coalesce(json_agg(t),'[]') from phone_cloud_automation_jobs t where status not in ('succeeded','failed','cancelled','expired')),'sessions',(select coalesce(json_agg(t),'[]') from phone_cloud_automation_sessions t where status not in ('ended','failed','expired','cancelled')),'locks',(select coalesce(json_agg(t),'[]') from phone_cloud_device_locks t where status not in ('released','expired')),'batches',(select coalesce(json_agg(t),'[]') from phone_cloud_xhs_batch_records t where starts_with(record_key,'run/') and data->>'status' in ('running','needs_attention')));
COMMIT;"""
pre=subprocess.run(['docker','exec','-i','phone-cloud-postgres','sh','-c','exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],input=preSql,text=True,capture_output=True,timeout=25)
assert pre.returncode==0,'fresh pre-termination backup failed'
json.loads(pre.stdout)
preDest=S/'rollback/pre-termination-records.json';assert not preDest.exists();preDest.write_text(pre.stdout);preDest.chmod(0o600)
code=(S/'pause-and-stop.mjs').read_text()
r=subprocess.run(['docker','exec','-i','phone-cloud-platform','node','--input-type=module','-'],input=code,text=True,capture_output=True,timeout=60)
(S/'receipts/PAUSE_STOP.stdout').write_text(r.stdout)
if r.returncode:
 (S/'receipts/PAUSE_STOP_FAILURE.txt').write_text(r.stderr[:3000]);raise SystemExit('pause/stop failed; gate may be closed; do not continue blindly')
pause=json.loads(r.stdout);(S/'receipts/PAUSE_STOP.json').write_text(json.dumps(pause,indent=2)+'\n')
subprocess.run(['docker','stop','--time','10','phone-cloud-platform-xhs-batch-1'],check=True,timeout=20,stdout=subprocess.DEVNULL)
subprocess.run(['docker','stop','--time','30','phone-cloud-platform'],check=True,timeout=40,stdout=subprocess.DEVNULL)
states={}
for n in ['phone-cloud-platform','phone-cloud-platform-xhs-batch-1']:
 d=json.loads(subprocess.check_output(['docker','inspect',n]))[0];assert not d['State']['Running'];states[n]={'status':d['State']['Status'],'exitCode':d['State']['ExitCode'],'finishedAt':d['State']['FinishedAt'],'image':d['Image']}
sql="""SET statement_timeout=15000;BEGIN READ ONLY;
SELECT json_build_object('pool',(select data from phone_cloud_managed_lookup where state_key='default'),'windows',(select coalesce(json_agg(t),'[]') from phone_cloud_windows_tasks t where updated_at>='CUTOFF'::timestamptz),'jobs',(select coalesce(json_agg(t),'[]') from phone_cloud_automation_jobs t where updated_at>='CUTOFF'::timestamptz),'sessions',(select coalesce(json_agg(t),'[]') from phone_cloud_automation_sessions t where status not in ('ended','failed','expired','cancelled')),'locks',(select coalesce(json_agg(t),'[]') from phone_cloud_device_locks t where status not in ('released','expired')),'batches',(select coalesce(json_agg(t),'[]') from phone_cloud_xhs_batch_records t where starts_with(record_key,'run/') and data->>'status' in ('running','needs_attention')));
COMMIT;""".replace('CUTOFF',started)
r=subprocess.run(['docker','exec','-i','phone-cloud-postgres','sh','-c','exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],input=sql,text=True,capture_output=True,timeout=30);assert r.returncode==0,'cutoff read failed'
cut=json.loads(r.stdout);dest=S/'rollback/cutoff-records.json';dest.write_text(json.dumps(cut,ensure_ascii=False));dest.chmod(0o600)
terminal={'succeeded','failed','cancelled','expired','not_found'}
unfinished=[r for r in cut['pool']['requests'] if r['status'] not in terminal]
blockers=[{'lookupId':r['lookupId'],'status':r['status'],'reason':'missing_cancel_intent'} for r in unfinished if not r.get('cancelRequested')]
for row in cut['windows']:
 d=row.get('data') or {}
 if row['status'] not in terminal and d.get('type')!='alipay_name_stop':blockers.append({'taskId':row['task_id'],'type':d.get('type'),'status':row['status'],'reason':'still_dispatchable_task_requires_review'})
for row in cut['batches']:blockers.append({'recordKey':row['record_key'],'reason':'active_batch_requires_native_stop_marker'})
record={'startedAt':started,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'state':states,'poolEnabled':cut['pool']['config']['enabled'],'unfinishedRequests':len(unfinished),'physicalReservationsRetained':len(cut['pool']['channels']),'blockers':blockers,'cutoffBackup':{'path':str(dest),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'bytes':dest.stat().st_size},'next':'root must review cutoff and authorize Windows/main start; no implicit activation'}
assert record['poolEnabled'] is False
(S/'receipts/PHASE1_DONE.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record))
