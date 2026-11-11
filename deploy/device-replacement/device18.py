"""Narrow admin operation: move only the two XHS bindings, archive old inventory."""
import datetime,hashlib,json,os,subprocess,sys,time,uuid
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from urllib.parse import quote
stage=Path('/opt/phone-cloud-staging/device18-replacement-20261111-rc.1')
old_id='adb:2e74c3a20920';new_id='adb:10CF3B074E002N1'
repo_hash='e8d42324f5e67922d5b558abd31bc995c8af796c8e39e439a2556692f415634e'
factory_hash='7073b32ca02e1dd11d150398234ee33d36a9e9fc78e569b2be6876112e06c415'
apply=sys.argv[1:]==['--apply'];assert not sys.argv[1:] or apply
def command(args):return subprocess.check_output(args,text=True,timeout=30).strip()
def digest(v):return hashlib.sha256(json.dumps(v,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def accounts(d):return [{k:a.get(k)for k in('appSlot','label','xhsId','accountName','enabled')}for a in d['xhsAccounts']]
def sims(d):return sorted([{k:s.get(k)for k in('slotIndex','phoneNumber','enabled')}for s in d['sims']],key=lambda s:s['slotIndex'])
def private(path,data):
 with path.open('xb')as f:os.fchmod(f.fileno(),0o600);f.write(data)
def runtime(mode):
 command(['docker','exec','phone-cloud-platform','kill','-USR1','1'])
 time.sleep(.15)
 output=command(['docker','exec','phone-cloud-platform','node','/tmp/device18-runtime.mjs',mode]);return json.loads(output)
c=json.loads(command(['docker','inspect','phone-cloud-platform']))[0];assert c['State']['Pid']==1730700 and c['State']['Health']['Status']=='healthy'
env=dict(v.split('=',1)for v in c['Config']['Env'])
def api(path,method='GET',body=None,token=None):
 h={'Content-Type':'application/json'}
 if token:h['Authorization']='Bearer '+token
 try:
  with urlopen(Request('http://127.0.0.1:8787'+path,data=None if body is None else json.dumps(body).encode(),headers=h,method=method),timeout=15)as r:return r.status,json.load(r)
 except HTTPError as e:return e.code,json.load(e)
status,p=api('/api/v1/auth/login','POST',{'username':env['ADMIN_USERNAME'],'password':env['ADMIN_PASSWORD']});assert status==200;token=p['session']['token']
def put(device,kind,body):
 status,p=api('/api/v1/devices/'+quote(device,safe='')+kind,'PUT',body,token)
 if status!=200:raise RuntimeError('device_update_rejected:'+str(status)+':'+p.get('error','unknown'))
 return p['device']
try:
 status,p=api('/api/v1/devices',token=token);assert status==200
 rows={d['deviceId']:d for d in p['devices']if d['deviceId']in(old_id,new_id)};assert len(rows)==2
 old,new=rows[old_id],rows[new_id]
 assert old['deviceName']==new['deviceName']=='18' and old['adb']['state']!='device' and old['recovery']['physicalPresent']is False and new['adb']['state']=='device'
 assert old['occupancy']is None and new['occupancy']is None and old['listingStatus']=='unlisted'
 assert len([a for a in old['xhsAccounts']if a['xhsId']])==2 and not any(a['xhsId']for a in new['xhsAccounts'])
 assert sims(old)==sims(new),'sim_number_binding_different'
 stage.mkdir(mode=0o700,exist_ok=True)
 if not apply:
  backup={'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'old':old,'new':new}
  private(stage/'devices.before.private.json',json.dumps(backup,ensure_ascii=False,indent=2).encode())
  plan={'operationId':'device18-replacement-'+uuid.uuid4().hex,'auditId':str(uuid.uuid4()),'oldDeviceId':old_id,'newDeviceId':new_id,'repositorySha256':repo_hash,'originalFactorySha256':factory_hash,'accountsSha256':digest(accounts(old)),'simsSha256':digest(sims(new)),'backupSha256':hashlib.sha256((stage/'devices.before.private.json').read_bytes()).hexdigest()}
  (stage/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
  command(['docker','cp',str(stage/'plan.json'),'phone-cloud-platform:/tmp/device18-plan.json'])
  result=runtime('inspect');assert result['bothIdle'] and result['userDeviceReferences']==0
  (stage/'preflight.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'prepared':True,'oldDeviceId':old_id,'newDeviceId':new_id,'xhsAccountsToMove':2,'simNumbersAlreadyMatch':True,'historicalTaskOrSmsChanges':0,'runtime':result}));sys.exit(0)
 backup=json.loads((stage/'devices.before.private.json').read_text());plan=json.loads((stage/'plan.json').read_text())
 assert digest(accounts(old))==plan['accountsSha256'] and digest(sims(new))==plan['simsSha256']
 guard=runtime('activate');assert guard['activated'] and guard['restarted']is False
 (stage/'repository-activated.json').write_text(json.dumps(guard,indent=2)+'\n')
 moved=False;retired=False
 try:
  put(new_id,'',{'listingStatus':'unlisted'})
  status,p=api('/api/v1/devices',token=token);assert status==200
  targets=[d for d in p['devices']if d['deviceId']in(old_id,new_id)];assert len(targets)==2 and all(d['occupancy']is None for d in targets)
  put(old_id,'/xhs-accounts',{'accounts':[]})
  updated=put(new_id,'/xhs-accounts',{'accounts':backup['old']['xhsAccounts']});assert digest(accounts(updated))==plan['accountsSha256'];moved=True
  result=runtime('retire');assert result['archived']and result['removedFromInventory']and result['remainingNumber18']==1;retired=True
  (stage/'retired.json').write_text(json.dumps(result,indent=2)+'\n')
 finally:
  # Do not overwrite any third-party edits or clear a new device's bindings in
  # an error handler. Keep original records and a precise pending phase.
  put(new_id,'',{'listingStatus':backup['new']['listingStatus']})
 status,p=api('/api/v1/devices',token=token);assert status==200
 assert not any(d['deviceId']==old_id for d in p['devices'])
 current=next(d for d in p['devices']if d['deviceId']==new_id);assert digest(accounts(current))==plan['accountsSha256'] and digest(sims(current))==plan['simsSha256']
 report={'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'applied':True,'oldDeviceId':old_id,'newDeviceId':new_id,'bindingsMoved':2,'simBindingsChanged':False,'oldInventoryArchived':retired,'newListed':current['listingStatus']=='listed','newAdbOnline':current['adb']['state']=='device','mainPidUnchanged':1730700,'sharedServicesRestarted':False,'backupSha256':plan['backupSha256'],'retirement':result}
 (stage/'applied.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
finally:api('/api/v1/auth/logout','POST',{},token)
