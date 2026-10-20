from pathlib import Path
import subprocess,json,time
r=Path('/opt/phone-cloud-platform');stage=r/'staging/lookup-idle-refresh-20261020-rc.1';m=json.loads((stage/'PREPARED.json').read_text())
name='lookup-idle-refresh-pg-20261020'
def run(*args,**kw):return subprocess.check_output(args,text=True,**kw).strip()
# Schema only: no production rows or credentials enter the isolated test.
with (stage/'schema-only.sql').open('wb') as out:subprocess.run(['docker','exec','phone-cloud-postgres','sh','-c','exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s'],stdout=out,check=True,timeout=60)
created=False
try:
 run('docker','run','-d','--name',name,'--network','none','--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine');created=True
 for i in range(40):
  if subprocess.run(['docker','exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'],capture_output=True).returncode==0:break
  time.sleep(.5)
 else:raise RuntimeError('isolated_pg_not_ready')
 with (stage/'schema-only.sql').open('rb') as src:subprocess.run(['docker','exec','-i',name,'psql','-h','127.0.0.1','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],stdin=src,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True,timeout=30)
 cmd=['docker','run','--rm','--network','container:'+name,'--mount','type=bind,src='+str(stage/'round-idle-http.mjs')+',dst=/app/verification/round-idle-http.mjs,readonly','--mount','type=bind,src='+str(r/'staging/lookup-round-stop-20261016-rc.1/test-sql')+',dst=/app/deploy/sql,readonly','--mount','type=bind,src='+str(r/'staging/lookup-round-stop-20261016-rc.1/test-managed-lookup-delivery.mjs')+',dst=/app/windows-agent/src/managed-lookup-delivery.mjs,readonly','-e','MANAGED_LOOKUP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres','--entrypoint','node',m['image'],'/app/verification/round-idle-http.mjs']
 out=run(*cmd,timeout=180);result=json.loads(out.splitlines()[-1]);assert result['storage']=='postgres' and result['drained']
 (stage/'POSTGRES-ISOLATED.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
finally:
 if created:subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,check=True)
