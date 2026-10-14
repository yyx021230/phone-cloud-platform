# EXECUTE ONLY AFTER explicit approval for this candidate and service interruption.
from pathlib import Path
import subprocess,json,hashlib,time,urllib.request,shlex,datetime,sys
assert '--approved-maintenance' in sys.argv,'maintenance approval flag required'
p=Path('/opt/phone-cloud-platform');s=p/'staging/lookup-delivery-20261014-rc.1';b=p/'deploy-backups/lookup-delivery-20261014-rc.1'
a=json.loads((p/'ACTIVE_PLATFORM_RELEASE.json').read_text());m=json.loads((s/'ARTIFACTS.json').read_text());proof=json.loads((s/'BUILD-PROOF.json').read_text())
assert a['version']==m['expectedActiveVersion'];current=json.loads(subprocess.check_output(['docker','inspect','phone-cloud-platform']))[0];assert current['Image']==m['cloudBaseImage'];assert proof['isolatedNetworkNoneReady']
old=['docker','compose','-p','phone-cloud-platform']
for row in a['activeCompose']:
 f=Path(row['path']);assert hashlib.sha256(f.read_bytes()).hexdigest()==row['sha256'];old+=['-f',str(f)]
for f,row in m['cloudFiles'].items():assert hashlib.sha256(subprocess.check_output(['docker','exec','phone-cloud-platform','cat','/app/'+f])).hexdigest()==row['before'],f+' drift'
newimage=json.loads(subprocess.check_output(['docker','image','inspect',proof['imageTag']]))[0];assert newimage['Id']==proof['imageId'];assert newimage['Config']['Labels']['org.opencontainers.image.revision']==m['sourceCommit']
layer=s/'compose.delivery.json';layer.write_text(json.dumps({'services':{'phone-cloud':{'image':proof['imageTag'],'labels':{'phonecloud.deployment.candidate':m['version'],'phonecloud.deployment.commit':m['sourceCommit']}}}},indent=2)+'\n');new=old+['-f',str(layer)]
before=json.loads(subprocess.check_output(old+['config','--format','json'],cwd=p));after=json.loads(subprocess.check_output(new+['config','--format','json'],cwd=p))
for name in before['services']:
 if name!='phone-cloud':assert before['services'][name]==after['services'][name]
 else:
  for k in set(before['services'][name])|set(after['services'][name]):
   if k not in ['image','labels']:assert before['services'][name].get(k)==after['services'][name].get(k),k
rollback=b/'ROLLBACK-CLOUD.sh';rollback.write_text('#!/bin/sh\nset -eu\ncd /opt/phone-cloud-platform\n'+shlex.join(old+['up','-d','--no-deps','--no-build','phone-cloud'])+'\n');rollback.chmod(0o700)
subprocess.run(new+['up','-d','--no-deps','--no-build','phone-cloud'],cwd=p,check=True,timeout=90)
ok=False
for i in range(30):
 try:
  with urllib.request.urlopen('http://127.0.0.1:8787/readyz',timeout=3) as r:ok=r.status==200
  if ok:break
 except Exception:pass
 time.sleep(2)
if not ok:
 subprocess.run(old+['up','-d','--no-deps','--no-build','phone-cloud'],cwd=p,check=True,timeout=90);raise RuntimeError('readiness failed, previous cloud image restored')
c=json.loads(subprocess.check_output(['docker','inspect','phone-cloud-platform']))[0];assert c['Image']==proof['imageId']
receipt={'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'version':m['version'],'sourceCommit':m['sourceCommit'],'image':c['Image'],'container':c['Id'],'startedAt':c['State']['StartedAt'],'ready':ok,'activeCompose':a['activeCompose']+[{'path':str(layer),'sha256':hashlib.sha256(layer.read_bytes()).hexdigest()}]}
(s/'ACTIVATION.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
