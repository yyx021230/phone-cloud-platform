from pathlib import Path
import json,hashlib,subprocess,datetime,time,os
os.umask(0o077)
root=Path('/opt/phone-cloud-platform');active=root/'ACTIVE_PLATFORM_RELEASE.json';old=active.read_bytes();a=json.loads(old)
assert hashlib.sha256(old).hexdigest()=='be930d6ae36312e945b3ddc754d7d1fa95be5f87df64271f719920bdbecdf49a'
run=lambda *args,**kw:subprocess.check_output(list(args),text=True,**kw).strip()
prod=json.loads(run('docker','inspect','phone-cloud-platform'))[0];baseTag='phone-cloud-platform:lookup-readiness-20261015-rc.13'
assert prod['Image']=='sha256:3102e2fd770ccf6d855e1b2192846965b49d33e3b9a7d9f89b374a8fd6372359'
assert json.loads(run('docker','image','inspect',baseTag))[0]['Id']==prod['Image']
rel='windows-agent/scripts/alipay_name_lookup.py';expected='5d3ff1b512c61cc34fba13b4b8600c3e95b698dcd097753d74ce4cfb46cb6b6c';newhash='8ba90c21e4d3bf9de7e12d02d0f83e05a7e730ea8f4a26d1b817a45b9cbfaf61'
stage=root/'staging/lookup-readiness-20261015-rc.14';backup=root/'deploy-backups/lookup-readiness-20261015-prep.14'
assert (backup/'ACTIVE.before.json').read_bytes()==old
assert hashlib.sha256((backup/'alipay_name_lookup.py').read_bytes()).hexdigest()==expected
assert hashlib.sha256((stage/'alipay_name_lookup.py').read_bytes()).hexdigest()==newhash
(stage/'Dockerfile').write_text('FROM '+baseTag+'\nCOPY alipay_name_lookup.py /app/'+rel+'\nLABEL org.opencontainers.image.revision="e86d414e8f765194132c2ce9cb30da92a92b5957" phonecloud.deployment.candidate="lookup-readiness-20261015-rc.14"\n')
tag='phone-cloud-platform:lookup-readiness-20261015-rc.14'
subprocess.run(['docker','build','--network=none','--pull=false','-t',tag,str(stage)],check=True,stdout=subprocess.DEVNULL,timeout=90)
image=json.loads(run('docker','image','inspect',tag))[0]['Id'];container=None
try:
 boot="import crypto from 'node:crypto';for(const k of ['ADMIN_PASSWORD','ADMIN_API_TOKEN','WINDOWS_AGENT_TOKEN','DEVICE_AGENT_TOKEN','SCREEN_MEDIA_AUTH_SECRET','EVIDENCE_SIGNING_SECRET'])process.env[k]=crypto.randomUUID();await import('./server/index.mjs');"
 container=run('docker','run','-d','--network','none','--tmpfs','/app/data','--env','STORAGE_BACKEND=json','--env','NODE_ENV=test','--env','DATABASE_URL=','--env','REDIS_URL=','--entrypoint','node',image,'--input-type=module','-e',boot)
 for _ in range(20):
  status=run('docker','exec',container,'node','-e',"fetch('http://127.0.0.1:8787/readyz').then(r=>console.log(r.status)).catch(()=>console.log(0))")
  if status=='200':break
  time.sleep(.5)
 assert status=='200';assert run('docker','exec',container,'sha256sum','/app/'+rel).split()[0]==newhash
finally:
 if container:subprocess.run(['docker','rm','-f',container],check=True,stdout=subprocess.DEVNULL)
layer=stage/'compose.pending.json';layer.write_text(json.dumps({'services':{'phone-cloud':{'image':tag,'labels':{'phonecloud.deployment.candidate':'lookup-readiness-20261015-rc.14','phonecloud.deployment.commit':'e86d414e8f765194132c2ce9cb30da92a92b5957'}}}},indent=2)+'\n')
cmd=['docker','compose','-p','phone-cloud-platform']
for row in a['activeCompose']:
 assert hashlib.sha256(Path(row['path']).read_bytes()).hexdigest()==row['sha256'];cmd+=['-f',row['path']]
before=json.loads(run(*cmd,'config','--format','json',cwd=root));after=json.loads(run(*cmd,'-f',str(layer),'config','--format','json',cwd=root))
for name,svc in before['services'].items():
 for key,value in svc.items():
  if name=='phone-cloud' and key in ['image','labels']:continue
  assert after['services'][name][key]==value,(name,key)
assert active.read_bytes()==old;assert json.loads(run('docker','inspect','phone-cloud-platform'))[0]['State']['StartedAt']==prod['State']['StartedAt']
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'candidate':'lookup-readiness-20261015-rc.14','commit':'e86d414e8f765194132c2ce9cb30da92a92b5957','oldImage':prod['Image'],'image':image,'tag':tag,'newHash':newhash,'oldHash':expected,'stage':str(stage),'backup':str(backup),'compose':{'path':str(layer),'sha256':hashlib.sha256(layer.read_bytes()).hexdigest()},'isolatedReady':True,'productionChanged':False}
(stage/'PREPARED.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
