"""Verify the built candidate using disposable, network-isolated PostgreSQL. No activation."""
import os,pathlib,json,secrets,subprocess,time,hashlib
stage=pathlib.Path(__file__).resolve().parent
baseline='sha256:350e2f56909b2a17d5a863a1aef8dcc8e7360c1693422b2ba5198b8dc4457dd2'
tag='phone-cloud-platform:lookup-ai-vision-20261022-rc.1';smoke='pc-lookup-ai-rc1-smoke';pgname='pc-lookup-ai-rc1-pg'
def run(args,**kw):return subprocess.check_output(args,text=True,**kw).strip()
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
 return h.hexdigest()
assert run(['docker','inspect','phone-cloud-platform','--format','{{.Image}}'])==baseline
pgimage=run(['docker','inspect','phone-cloud-postgres','--format','{{.Image}}']);environment=os.environ.copy()
for k in ['ADMIN_PASSWORD','ADMIN_API_TOKEN','WINDOWS_AGENT_TOKEN','DEVICE_AGENT_TOKEN','SCREEN_MEDIA_AUTH_SECRET','POSTGRES_PASSWORD']:environment[k]=secrets.token_urlsafe(32)
environment['DATABASE_URL']='postgresql://smoke:'+environment['POSTGRES_PASSWORD']+'@127.0.0.1:5432/lookup_smoke'
try:
 run(['docker','run','-d','--name',pgname,'--network','none','--memory','512m','--cpus','0.5','--tmpfs','/var/lib/postgresql/data:rw,size=256m','-e','POSTGRES_USER=smoke','-e','POSTGRES_DB=lookup_smoke','-e','POSTGRES_PASSWORD',pgimage],env=environment)
 for i in range(40):
  if subprocess.run(['docker','exec',pgname,'pg_isready','-U','smoke','-d','lookup_smoke'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
  time.sleep(1)
 else:raise RuntimeError('isolated PG readiness failed')
 for f in ['20261013-managed-lookup.sql','20261013-managed-lookup-async.sql']:
  with open(stage/f) as data:subprocess.run(['docker','exec','-i',pgname,'psql','-v','ON_ERROR_STOP=1','-U','smoke','-d','lookup_smoke'],stdin=data,stdout=subprocess.DEVNULL,check=True)
 args=['docker','run','-d','--name',smoke,'--network','container:'+pgname,'--memory','512m','--cpus','0.5','--tmpfs','/app/data:rw,size=128m','-e','STORAGE_BACKEND=postgres','-e','STRUCTURED_WRITES=true','-e','DATABASE_URL','-e','REDIS_URL=','-e','MANAGED_NAME_LOOKUP_ENABLED=true','-e','OPEN_NAME_LOOKUP_API_ENABLED=true','-e','OPEN_NAME_LOOKUP_CLIENTS_JSON=[]','-e','LOOKUP_HUMAN_FEISHU_WEBHOOK=','-e','LOOKUP_HUMAN_FEISHU_WEBHOOK_FILE=','-e','LOOKUP_AI_VISION_ENABLED=true','-e','LOOKUP_AI_VISION_BASE_URL=http://127.0.0.1:9','-e','LOOKUP_AI_VISION_API_KEY=synthetic-smoke-key']
 for k in ['ADMIN_PASSWORD','ADMIN_API_TOKEN','WINDOWS_AGENT_TOKEN','DEVICE_AGENT_TOKEN','SCREEN_MEDIA_AUTH_SECRET']:args+=['-e',k]
 run(args+[tag],env=environment)
 code="(async()=>{for(const p of ['/healthz','/readyz','/lookup-admin.html','/lookup-admin.js','/lookup-admin.css','/api/v1/admin/lookup-pool/console','/api/v1/admin/lookup-pool/console/requests']){const r=await fetch('http://127.0.0.1:8787'+p,{headers:{Authorization:'Bearer '+process.env.ADMIN_API_TOKEN}});if(r.status!==200)throw Error(p+':'+r.status);}const r=await fetch('http://127.0.0.1:8787/api/v1/admin/lookup-pool/console');if(r.status!==401)throw Error('auth');console.log('smoke passed')})().catch(e=>{console.error(e.message);process.exit(1)})"
 for i in range(30):
  result=subprocess.run(['docker','exec',smoke,'node','-e',code],capture_output=True,text=True)
  if result.returncode==0:break
  time.sleep(1)
 else:raise RuntimeError('isolated app smoke failed: '+result.stderr[:300])
 # Validate the exact published runtime payload independently of Docker cache.
 files={f:h for f,h in json.loads((stage/'PRODUCTION_DIFF.json').read_text()).items() if f.startswith(('public/','server/'))}
 code="const fs=require('fs'),c=require('crypto');for(const [f,h]of Object.entries("+json.dumps(files)+")){if(c.createHash('sha256').update(fs.readFileSync('/app/'+f)).digest('hex')!==h.after)throw Error(f)}"
 run(['docker','exec',smoke,'node','-e',code])
finally:
 for name in [smoke,pgname]:subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
active=json.loads(pathlib.Path('/opt/phone-cloud-platform/ACTIVE_PLATFORM_RELEASE.json').read_text());assert active['imageId']==baseline and active['restartImageId']==baseline
assert run(['docker','inspect','phone-cloud-platform','--format','{{.Image}}'])==baseline
media=json.loads(run(['/tmp/phonecloud-node-v22.22.3-linux-x64/node-v22.22.3-linux-x64/bin/node','/opt/phone-cloud-platform/deploy/mediamtx-pacing/verify.mjs','--live']));assert media['verified']=='live'
backup=stage/'rollback';receipt={'candidate':'lookup-ai-vision-20261022-rc.1','sourceCommit':(stage/'SOURCE_COMMIT').read_text().strip(),'status':'prepared-not-activated','imageTag':tag,'imageId':run(['docker','image','inspect',tag,'--format','{{.Id}}']),'previousImage':baseline,'cloudFiles':files,'media':media,'backup':str(backup),'backupFiles':{str(p.relative_to(backup)):sha(p) for p in backup.rglob('*') if p.is_file()},'isolatedSmoke':'passed using production mode and disposable PostgreSQL','productionServiceRestarted':False,'agentChanged':False,'adbChanged':False,'preparedAtUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
(stage/'PREPARATION_RECEIPT.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({'status':receipt['status'],'imageId':receipt['imageId'],'smoke':receipt['isolatedSmoke']}))
