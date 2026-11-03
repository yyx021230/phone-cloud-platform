import json,re,subprocess
from pathlib import Path
ids=['781489c2-6f52-4448-ac58-c4efa62103e8','278c3012-04bf-4d61-8bf6-f378b322ea93','680a14a8-3988-4eb4-ad45-734bfafa03fd']
rows=[];files=[]
for f in Path('/var/log/nginx').glob('*access*.log'):
 if not f.is_file():continue
 files.append(str(f))
 with f.open('rb')as h:
  h.seek(max(0,f.stat().st_size-4194304));raw=h.read(4194304)
 for l in raw.decode('utf-8','replace').splitlines():
  if any(i in l for i in ids):
   m=re.search(r'\[([^]]+)\]\s+"(GET|POST|DELETE|PUT) ([^ ?]+)(?:[^\x22]*)"\s+([0-9]{3})',l)
   rows.append({'file':str(f),'parsed':{'at':m[1],'method':m[2],'path':m[3],'status':int(m[4])}if m else None})
r=subprocess.run(['docker','logs','--since','2026-11-03T01:18:10Z','--until','2026-11-03T01:18:30Z','--tail','200','phone-cloud-platform'],capture_output=True,timeout=8)
fixed=[]
for l in (r.stdout+r.stderr).decode('utf-8','replace').splitlines():
 if any(i in l for i in ids):
  codes=re.findall(r'wecom_cleanup_[a-z_]+',l);status=re.findall(r'(?i)(?:status|statusCode|httpStatus)[\x22 :]+([0-9]{3})',l)
  fixed.append({'codes':codes,'httpStatus':status,'ids':[i for i in ids if i in l]})
print(json.dumps({'nginxFiles':files,'nginxRows':rows,'businessLogExit':r.returncode,'businessLogMatches':fixed,'readOnly':True}))
