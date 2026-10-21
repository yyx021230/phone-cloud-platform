# MODE is prepended by the local deployment coordinator. No phone or ADB commands.
from pathlib import Path
import json,hashlib,psutil,datetime,subprocess,os,ast
root=Path(r'D:\PhoneCloud\agent');backup=root/'backups/lookup-ocr-probe-pressure-20261021-prep1';m=json.loads((backup/'PREPARED.json').read_text());stage=Path(m['stage'])
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
listeners=[x for x in psutil.net_connections(kind='tcp') if x.status=='LISTEN' and x.laddr.port==5037];assert len(listeners)==1
adb=psutil.Process(listeners[0].pid);agent=psutil.Process(m['agentPid'])
assert adb.pid==m['adbPid'] and adb.username().upper()==r'NT AUTHORITY\SYSTEM' and adb.exe().lower()==r'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe'.lower()
assert agent.username().upper()==r'NT AUTHORITY\SYSTEM'
for path,key in [('config.json','configHash'),('adb-auth-env.cjs','preloadHash'),('src/index.mjs','agentEntryHash')]:assert sha(root/path)==m[key]
workers=[]
for proc in psutil.process_iter(['pid','name','cmdline']):
 try:
  args=' '.join(proc.info['cmdline'] or []).lower()
  if ('python' in (proc.info['name'] or '').lower() and any(s in args for s in ['xhs_airtest_poco.py','alipay_name_lookup.py','lookup_ocr_worker.py'])):workers.append(proc.pid)
 except (psutil.NoSuchProcess,psutil.AccessDenied):continue
assert not workers,'automation_worker_present_stop_before_change'
files={k:v for k,v in m['files'].items() if k.endswith('.py')};acls={}
for f,v in files.items():
 name=Path(f).name;live=root/'scripts'/name
 assert sha(live)==v['after' if MODE=='verify' else 'before']
 assert sha(backup/name)==v['before'] and sha(stage/name)==v['after'];ast.parse((stage/name).read_text(encoding='utf-8'))
 acls[name]=subprocess.check_output(['powershell.exe','-NoProfile','-NonInteractive','-Command',"(Get-Acl -LiteralPath '"+str(live)+"').Sddl"],text=True).strip()
 assert acls[name]==(backup/(name+'.sddl')).read_text()
changed=[]
if MODE=='apply':
 try:
  for f,v in files.items():
   name=Path(f).name;dest=root/'scripts'/name;changed.append(name)
   with dest.open('r+b') as stream:stream.seek(0);stream.write((stage/name).read_bytes());stream.truncate();stream.flush();os.fsync(stream.fileno())
   assert sha(dest)==v['after']
  for name in changed:
   acl=subprocess.check_output(['powershell.exe','-NoProfile','-NonInteractive','-Command',"(Get-Acl -LiteralPath '"+str(root/'scripts'/name)+"').Sddl"],text=True).strip();assert acl==acls[name]
 except Exception:
  for name in changed:
   with (root/'scripts'/name).open('r+b') as stream:stream.seek(0);stream.write((backup/name).read_bytes());stream.truncate();stream.flush();os.fsync(stream.fileno())
  raise
out={'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mode':MODE,'agentPid':agent.pid,'adbPid':adb.pid,'owner':'SYSTEM','workers':len(workers),'files':{f:sha(root/'scripts'/Path(f).name) for f in files},'backup':str(backup),'agentRestarted':False,'adbTouched':False,'aclPreserved':True}
if MODE=='apply':(backup/'ACTIVATED.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out))
