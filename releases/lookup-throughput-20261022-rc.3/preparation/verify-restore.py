"""Restore only into a disposable, network-isolated database. Never touches production data."""
import pathlib,json,subprocess,os,secrets,time,hashlib,shutil
stage=pathlib.Path(__file__).resolve().parent
name='pc-lookup-throughput-rc3-restore';data=stage/'restore-check';data.mkdir(mode=0o700,exist_ok=False)
def run(args,**kw):return subprocess.check_output(args,text=True,**kw).strip()
image=run(['docker','inspect','phone-cloud-postgres','--format','{{.Image}}']);env=os.environ.copy();env['POSTGRES_PASSWORD']=secrets.token_urlsafe(32)
available=int(next(line.split()[1] for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))
if available < 3_500_000: raise RuntimeError('Insufficient spare memory for isolated full restore')
started=False
try:
 run(['docker','run','-d','--name',name,'--network','none','--memory','2g','--cpus','0.5','--mount','type=bind,src='+str(data)+',dst=/var/lib/postgresql/data','-e','POSTGRES_USER=restore_check','-e','POSTGRES_DB=restore_check','-e','POSTGRES_PASSWORD',image],env=env);started=True
 for i in range(60):
  if subprocess.run(['docker','exec',name,'pg_isready','-U','restore_check','-d','restore_check'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
  time.sleep(1)
 else:raise RuntimeError('restore database startup timeout')
 with open(stage/'rollback/database.dump','rb') as source,open(stage/'restore-check.log','w') as log:
  subprocess.run(['docker','exec','-i',name,'pg_restore','--no-owner','--no-acl','--exit-on-error','-U','restore_check','-d','restore_check'],stdin=source,stdout=log,stderr=log,check=True)
 # Only aggregate table metadata, never snapshot contents or credentials.
 output=run(['docker','exec',name,'psql','-X','-A','-t','-U','restore_check','-d','restore_check','-c',"SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';"])
 assert int(output)>0
 receipt={'candidate':'lookup-throughput-20261022-rc.3','fullDatabaseRestore':'passed','tableCount':int(output),'databaseImage':image,'network':'none','memoryLimit':'2g','previousAttempt':'512MiB isolated cgroup OOM; no production OOM','productionDatabaseModified':False,'restoredDataRemovedAfterCheck':True}
 (stage/'RESTORE_RECEIPT.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
finally:
 if started:subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
 shutil.rmtree(data)
