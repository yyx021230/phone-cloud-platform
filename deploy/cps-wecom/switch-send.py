"""Prepare by default; --apply switches only the independent CPS service."""
import datetime, hashlib, json, os, subprocess, sys, time
from pathlib import Path
from urllib.request import urlopen

stage=Path('/opt/phone-cloud-staging/wecom-cps-send-20261111-rc.1')
live=Path('/opt/phone-cloud-staging/wecom-cps-rc3-20261110/bridge.env')
active=Path('/opt/phone-cloud-platform/ACTIVE_PLATFORM_RELEASE.json')
candidate='phone-cloud-cps-wecom-send-candidate-20261111'
rollback='phone-cloud-cps-wecom-preview-rollback-20261111'
image='sha256:4c3823e7aab5328c6e9ecfa37683ea210405fdddb14c0d52f61664812f755b33'
operator='phone-cloud-cps-send-operator:20261111-rc.4'
apply=sys.argv[1:]==['--apply']
assert not sys.argv[1:] or apply
def command(args,**kwargs):return subprocess.check_output(args,text=True,timeout=40,**kwargs).strip()
def inspect(name):return json.loads(command(['docker','inspect',name]))[0]
def sha(b):return hashlib.sha256(b).hexdigest()
def private(path,data):
 if path.exists():assert path.read_bytes()==data,'backup_drift';return
 with path.open('xb')as f:os.fchmod(f.fileno(),0o600);f.write(data)
old=inspect('phone-cloud-cps-wecom');main=inspect('phone-cloud-platform')
assert old['Id']=='13de64066b3d0cd2a5d92e0355b421153ff4328de6ee93406352cd59c9fe97a4' and old['Image']==image
assert main['State']['Pid']==1730700 and main['State']['Health']['Status']=='healthy'
assert sha(active.read_bytes())=='cfd4dcf0bc510ead8ba2556f6c4e3b33d722b0d8114f4f67e26a9394cf85203c'
before=dict(x.split('=',1)for x in old['Config']['Env'])
assert before['CPS_EXECUTION_MODE']=='preview' and before['CPS_STATE_KEY']=='preview-20261110'
new=dict(before,CPS_EXECUTION_MODE='send',CPS_STATE_KEY='production')
assert all('\n'not in v and '\r'not in v for v in new.values())
private(stage/'ACTIVE.before.json',active.read_bytes());private(stage/'bridge.before.env',live.read_bytes())
private(stage/'bridge.send.env',('\n'.join(k+'='+v for k,v in new.items())+'\n').encode())
run=['docker','run','--rm','--network=host','--read-only','--cap-drop=ALL','--pids-limit=32','--memory=256m','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--env-file',str(live),'--entrypoint','node',operator,'/app/activate-send-journal.mjs']
preflight=json.loads(command(run));assert preflight['apply']is False and preflight['oldPreviewJobsReplayed']==0
(stage/'preflight.json').write_text(json.dumps(preflight,indent=2)+'\n')
try:next_container=inspect(candidate)
except subprocess.CalledProcessError:
 command(['docker','create','--name',candidate,'--network=host','--restart','unless-stopped','--env-file',str(stage/'bridge.send.env'),image])
 next_container=inspect(candidate)
assert next_container['State']['Status']=='created' and next_container['Image']==image and next_container['Mounts']==[]
assert dict(x.split('=',1)for x in next_container['Config']['Env'])==new
assert next_container['Config']['Cmd']==old['Config']['Cmd'] and next_container['Config']['Entrypoint']==old['Config']['Entrypoint']
report={'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'applied':False,'imageUnchanged':image,'containerBefore':old['Id'],'containerAfter':next_container['Id'],'modeBefore':'preview','modeAfter':'send','stateKeyAfter':'production','onlyEnvChanges':['CPS_EXECUTION_MODE','CPS_STATE_KEY'],'mainPidUnchanged':1730700,'agentReloaded':False,'adbTouched':False,'preflight':preflight}
pilots=[]
for number in ('200','202'):
 name='phone-cloud-cps-preview-'+number
 pilot=inspect(name);env=dict(x.split('=',1)for x in pilot['Config']['Env'])
 assert pilot['Image']==image and env['CPS_EXECUTION_MODE']=='preview' and env['CPS_STATE_KEY']=='preview-20261110-pilot'+number
 pilots.append({'name':name,'containerId':pilot['Id'],'wasRunning':pilot['State']['Running']})
report['retiredIdlePilotServices']=pilots
if not apply:print(json.dumps(report));sys.exit(0)
started=time.monotonic()
for pilot in pilots:
 if pilot['wasRunning']:command(['docker','stop','-t','20',pilot['name']])
 assert inspect(pilot['name'])['State']['ExitCode']==0,'old_pilot_unclean_exit'
command(['docker','stop','-t','20','phone-cloud-cps-wecom'])
assert inspect('phone-cloud-cps-wecom')['State']['ExitCode']==0,'old_cps_unclean_exit'
name='wecom-cps-send-bootstrap-20261111-retry2'
# This disposable operator has no host mounts or Linux capabilities. Its own
# /receipt must be writable; the production CPS container keeps its node user
# and the database role stays the existing limited CPS role.
command(['docker','create','--name',name,'--user','0:0','--network=host','--cap-drop=ALL','--pids-limit=32','--memory=256m','--env-file',str(live),'--entrypoint','node',operator,'/app/activate-send-journal.mjs','--apply'])
output=command(['docker','start','-a',name]);assert inspect(name)['State']['ExitCode']==0,output
proof=json.loads(output);assert proof['apply']is True and proof['seedLeads']==preflight['seedLeads']
for file in ('journals.before.private.json','send-seed.private.json','journal-activated.json'):
 command(['docker','cp',name+':/receipt/'+file,str(stage/'private'/file)])
 os.chmod(stage/'private'/file,0o600)
command(['docker','rename','phone-cloud-cps-wecom',rollback]);command(['docker','rename',candidate,'phone-cloud-cps-wecom']);command(['docker','start','phone-cloud-cps-wecom'])
deadline=time.monotonic()+20
while True:
 try:
  with urlopen('http://127.0.0.1:8797/healthz',timeout=2)as r:assert r.status==200
  break
 except Exception:
  if time.monotonic()>deadline:raise RuntimeError('send_cps_not_ready')
  time.sleep(.25)
assert live.read_bytes()==(stage/'bridge.before.env').read_bytes()
temporary=live.with_suffix('.env.send-next');private(temporary,(stage/'bridge.send.env').read_bytes());os.replace(temporary,live)
current=inspect('phone-cloud-cps-wecom');unchanged=inspect('phone-cloud-platform')
assert current['Id']==next_container['Id'] and current['Image']==image
assert unchanged['Id']==main['Id'] and unchanged['State']['StartedAt']==main['State']['StartedAt']
report.update(applied=True,completedAtUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),independentCpsSwitchElapsedSeconds=round(time.monotonic()-started,2),journalProof=proof,rollbackContainer=rollback,realInvitationsByOperator=0,formalAcceptanceComplete=False)
(stage/'activated.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
