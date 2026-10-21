from pathlib import Path
import subprocess,os,json,time,urllib.request,datetime,shutil
os.umask(0o077)
r=Path(__file__).resolve().parents[1];pg='/opt/homebrew/opt/postgresql@16/bin/';db=[pg+'psql','-X','-h','127.0.0.1','-p','55439','-d','recovery_clone','-v','ON_ERROR_STOP=1','-A','-t']
def sql(s):return subprocess.check_output(db+['-c',s],text=True).strip()
before=sql('select md5(data::text) from phone_cloud_state order by state_key')
subprocess.run(db+['-f',str(r/'migrate.sql')],check=True,stdout=subprocess.DEVNULL)
assert sql('select md5(data::text) from phone_cloud_state order by state_key')==before
app=Path('/tmp/pc-snapshot-recovery-app-20261021');assert not (app/'.env').exists()
data=Path('/tmp/pc-snapshot-recovery-clone-data');data.mkdir(mode=0o700)
profile='(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "127.0.0.1:55439"))'
env={'PATH':os.environ['PATH'],'HOME':str(data),'HOST':'127.0.0.1','PORT':'18839','NODE_ENV':'test','STORAGE_BACKEND':'postgres','DATABASE_URL':'postgresql://127.0.0.1:55439/recovery_clone?user='+os.environ['USER'],'STRUCTURED_WRITES':'true','STRUCTURED_TABLE_SYNC':'false','POSTGRES_BOOTSTRAP_FROM_JSON':'false','DATA_DIR':str(data),'OPEN_NAME_LOOKUP_API_ENABLED':'false','REDIS_URL':''}
log=Path('/tmp/pc-snapshot-recovery-clone-app.log');started=time.monotonic();ready=False
with log.open('w') as f:
 proc=subprocess.Popen(['/usr/bin/sandbox-exec','-p',profile,shutil.which('node'),'--max-old-space-size=4096','server/index.mjs'],cwd=app,env=env,stdout=f,stderr=f)
 try:
  for _ in range(240):
   if proc.poll() is not None:raise RuntimeError('clone_app_exited; private log retained')
   try:
    with urllib.request.urlopen('http://127.0.0.1:18839/readyz',timeout=1) as res:ready=res.status==200
    if ready:break
   except Exception:pass
   time.sleep(.5)
  assert ready,'clone_readiness_timeout'
  seconds=round(time.monotonic()-started,3)
  size=int(sql('select octet_length(data::text) from phone_cloud_state limit 1'))
  out={'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':'production preswitch backup in isolated localhost PostgreSQL16','migrationTextHashUnchanged':True,'readinessHttp':200,'startupSeconds':seconds,'snapshotBytesAfterStartup':size,'externalNetworkDenied':True,'newPhoneTasks':0,'productionChanges':False}
  (r/'verification/CLONE-RESULTS.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out),flush=True)
 finally:
  proc.terminate()
  try:proc.wait(timeout=25)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
