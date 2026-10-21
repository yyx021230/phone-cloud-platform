from pathlib import Path
import json,hashlib,base64,shutil,psutil,datetime,subprocess,ast
root=Path(r'D:\PhoneCloud\agent');sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
listeners=[x for x in psutil.net_connections(kind='tcp') if x.status=='LISTEN' and x.laddr.port==5037];assert len(listeners)==1
adb=psutil.Process(listeners[0].pid);assert adb.username().upper()==r'NT AUTHORITY\SYSTEM';assert adb.exe().lower()==r'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe'.lower()
agent=psutil.Process(14508);assert agent.username().upper()==r'NT AUTHORITY\SYSTEM'
stage=root/'staging/lookup-ocr-probe-pressure-20261020-rc1';backup=root/'backups/lookup-ocr-probe-pressure-20261021-prep1';assert not stage.exists() and not backup.exists();stage.mkdir(parents=True);backup.mkdir(parents=True)
for f,item in PAYLOAD.items():
 rel=Path(f).relative_to('windows-agent/scripts');dest=stage/rel;dest.parent.mkdir(parents=True,exist_ok=True)
 if rel.suffix=='.py':
  assert sha(root/'scripts'/rel)==item['before'];shutil.copy2(root/'scripts'/rel,backup/rel.name)
  acl=subprocess.check_output(['powershell.exe','-NoProfile','-NonInteractive','-Command',"(Get-Acl -LiteralPath '"+str(root/'scripts'/rel)+"').Sddl"],text=True).strip();(backup/(rel.name+'.sddl')).write_text(acl)
 dest.write_bytes(base64.b64decode(item['data']));assert sha(dest)==item['after']
 if rel.suffix=='.py':ast.parse(dest.read_text(encoding='utf-8'))
result={'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':str(stage),'backup':str(backup),'agentPid':agent.pid,'adbPid':adb.pid,'owner':'SYSTEM','files':{f:{k:v for k,v in d.items() if k!='data'} for f,d in PAYLOAD.items()},'configHash':sha(root/'config.json'),'preloadHash':sha(root/'adb-auth-env.cjs'),'agentEntryHash':sha(root/'src/index.mjs'),'productionChanged':False}
(backup/'PREPARED.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
