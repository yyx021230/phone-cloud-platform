from pathlib import Path
import json,hashlib,subprocess,time,datetime,shutil,os
os.umask(0o077)
p=Path('/opt/phone-cloud-platform');s=p/'staging/lookup-readiness-20261015-rc.3';m=json.loads((s/'BUILD.json').read_text());active=p/'ACTIVE_PLATFORM_RELEASE.json';active_hash=hashlib.sha256(active.read_bytes()).hexdigest();a=json.loads(active.read_text());assert a['version']=='lookup-readiness-20261015-deployed.2'
run=lambda *args,**kw:subprocess.check_output(list(args),text=True,**kw).strip()
prod=json.loads(run('docker','inspect','phone-cloud-platform'))[0];assert prod['Image']==m['baseImageId'];assert json.loads(run('docker','image','inspect','phone-cloud-platform:lookup-readiness-20261015-rc.1'))[0]['Id']==m['baseImageId']
old=subprocess.check_output(['docker','exec','phone-cloud-platform','cat','/app/server/managed-lookup.mjs']);assert hashlib.sha256(old).hexdigest()==m['before'];tag='phone-cloud-platform:'+m['version']
subprocess.run(['docker','build','--network=none','--pull=false','-t',tag,str(s)],check=True,stdout=subprocess.DEVNULL,timeout=90)
i=json.loads(run('docker','image','inspect',tag))[0];assert i['Config']['Labels']['org.opencontainers.image.revision']==m['sourceCommit'];expected=json.loads((s/'EXPECTED.json').read_text());container=None
try:
 bootstrap="import crypto from 'node:crypto';for(const k of ['ADMIN_PASSWORD','ADMIN_API_TOKEN','WINDOWS_AGENT_TOKEN','DEVICE_AGENT_TOKEN','SCREEN_MEDIA_AUTH_SECRET','EVIDENCE_SIGNING_SECRET'])process.env[k]=crypto.randomUUID();await import('./server/index.mjs');"
 container=run('docker','run','-d','--network','none','--tmpfs','/app/data','--env','STORAGE_BACKEND=json','--env','NODE_ENV=test','--env','DATABASE_URL=','--env','REDIS_URL=','--env','OPEN_NAME_LOOKUP_API_ENABLED=true','--env','MANAGED_NAME_LOOKUP_ENABLED=true','--entrypoint','node',i['Id'],'--input-type=module','-e',bootstrap)
 for _ in range(20):
  q=run('docker','exec',container,'node','-e',"fetch('http://127.0.0.1:8787/readyz').then(r=>console.log(r.status)).catch(()=>console.log(0))")
  if q=='200':break
  time.sleep(.5)
 assert q=='200'
 js="const fs=require('fs'),c=require('crypto');const names=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(Object.fromEntries(names.map(n=>[n,c.createHash('sha256').update(fs.readFileSync('/app/'+n)).digest('hex')]))));"
 actual=json.loads(run('docker','exec','-i',container,'node','-e',js,input=json.dumps(list(expected))));assert actual==expected
 routes=['/healthz','/readyz','/api-docs.html','/api-reference.json','/openapi.json','/downloads/name-lookup-integration.zip'];statuses={}
 for path in routes:
  statuses[path]=int(run('docker','exec',container,'node','-e',"fetch('http://127.0.0.1:8787"+path+"').then(r=>console.log(r.status))"));assert statuses[path]==200
 status=int(run('docker','exec',container,'node','-e',"fetch('http://127.0.0.1:8787/api/v1/open/name-lookups/prepare',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log(r.status))"));assert status==401
finally:
 if container:subprocess.run(['docker','rm','-f',container],check=True,stdout=subprocess.DEVNULL)
# A pending Compose layer only; do not call compose up.
layer=s/'compose.pending.json';layer.write_text(json.dumps({'services':{'phone-cloud':{'image':tag,'labels':{'phonecloud.deployment.candidate':m['version'],'phonecloud.deployment.commit':m['sourceCommit']}}}},indent=2)+'\n')
oldcmd=['docker','compose','-p','phone-cloud-platform']
for row in a['activeCompose']:
 assert hashlib.sha256(Path(row['path']).read_bytes()).hexdigest()==row['sha256'];oldcmd+=['-f',row['path']]
before=json.loads(run(*oldcmd,'config','--format','json',cwd=p));after=json.loads(run(*oldcmd,'-f',str(layer),'config','--format','json',cwd=p))
for k,v in before['services'].items():
 for key,val in v.items():
  if k=='phone-cloud' and key in ['image','labels']:continue
  assert after['services'][k][key]==val,(k,key)
assert hashlib.sha256(active.read_bytes()).hexdigest()==active_hash;end=json.loads(run('docker','inspect','phone-cloud-platform'))[0];assert end['Id']==prod['Id'] and end['State']['StartedAt']==prod['State']['StartedAt']
result={'version':m['version'],'sourceCommit':m['sourceCommit'],'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'imageId':i['Id'],'imageTag':tag,'baseImageId':m['baseImageId'],'filesVerified':len(expected),'http':statuses,'unsignedPrepare':status,'isolated':'network=none, tmpfs fixture data, no ports, ephemeral generated credentials','containerRemoved':True,'productionContainerUnchanged':True,'activeReleaseUnchanged':True,'pendingComposeSha256':hashlib.sha256(layer.read_bytes()).hexdigest(),'productionAcceptanceComplete':False,'windowsOverlayRequired':'c559f9604461c1df1d37220d2c0f4e25df85f53c'}
(s/'IMAGE.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
