from pathlib import Path
import json,psutil,hashlib,base64,shutil,datetime,subprocess
root=Path(r'D:\PhoneCloud\agent');target=root/'scripts/alipay_name_lookup.py';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
ls=[c for c in psutil.net_connections(kind='tcp') if c.status=='LISTEN' and c.laddr.port==5037];assert len(ls)==1
adb=psutil.Process(ls[0].pid);assert adb.pid==634172 and adb.username().upper()==r'NT AUTHORITY\SYSTEM';assert adb.exe().lower()==r'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe'.lower()
a=psutil.Process(650400);assert a.username().upper()==r'NT AUTHORITY\SYSTEM'
assert sha(target)=='5d3ff1b512c61cc34fba13b4b8600c3e95b698dcd097753d74ce4cfb46cb6b6c'
assert sha(root/'src/index.mjs')=='31f551f6e817bf61cd8f8a799fd43cd4b3e635b4a81e0967c1cc08863a05e2a9'
assert sha(root/'config.json')=='ee61ff30debd1b1077a1964ebd3946a0f36d8c4a221777be219890896c865b52'
assert sha(root/'adb-auth-env.cjs')=='9c3aa5affb9243f255f2bf74376ee7bb01c9f9171989f5477146263ee7e2bb4d'
backup=root/'backups/lookup-readiness-20261015-prep14';stage=root/'staging/lookup-readiness-20261015-rc14';assert not backup.exists() and not stage.exists();backup.mkdir();stage.mkdir()
shutil.copy2(target,backup/'alipay_name_lookup.py');(stage/'alipay_name_lookup.py').write_bytes(base64.b64decode(PAYLOAD));assert sha(stage/'alipay_name_lookup.py')=='8ba90c21e4d3bf9de7e12d02d0f83e05a7e730ea8f4a26d1b817a45b9cbfaf61'
# Persist only ACL metadata; no credentials/config values copied.
ps="$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath '"+str(target)+"').Sddl"
acl=subprocess.check_output(['powershell.exe','-NoProfile','-NonInteractive','-Command',ps],text=True).strip();(backup/'runner-acl.sddl').write_text(acl)
children=[]
for child in a.children(recursive=True):
 try:
  if child.name().lower()=='python.exe':children.append({'pid':child.pid,'worker':any('xhs_airtest_poco.py' in s for s in child.cmdline())})
 except psutil.NoSuchProcess:pass
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'backup':str(backup),'stage':str(stage),'oldHash':sha(target),'newHash':sha(stage/'alipay_name_lookup.py'),'agentPid':a.pid,'adbPid':adb.pid,'owner':'SYSTEM','configHash':sha(root/'config.json'),'preloadHash':sha(root/'adb-auth-env.cjs'),'pythonChildren':children,'productionChanged':False}
(backup/'PREPARED.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
