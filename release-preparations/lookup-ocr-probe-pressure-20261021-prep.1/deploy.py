# Execute only for the explicitly approved cloud maintenance window.
from pathlib import Path
import subprocess,json,sys,datetime,ast
p=Path(__file__).resolve().parent
cloud=['ssh','-S','/tmp/pc-maint-20261021-cloud.sock','-o','BatchMode=yes','-o','ConnectTimeout=8','root@47.98.127.132']
win=['ssh','-S','/tmp/pc-maint-20261020-win.sock','-o','BatchMode=yes','-o','ConnectTimeout=8','Administrator@100.93.121.88']
def windows(mode):
 code='MODE='+repr(mode)+'\n'+(p/'windows-activate.py').read_text()
 result=subprocess.run(win+[r'D:\PhoneCloud\tools\python39\python.exe -'],input=code,text=True,capture_output=True,timeout=35)
 if result.returncode:raise RuntimeError('windows_'+mode+'_failed: '+result.stderr[-1000:])
 return json.loads(result.stdout)
pre=windows('check');(p/'WINDOWS-PRESWITCH.json').write_text(json.dumps(pre,indent=2)+'\n');print(json.dumps({'phase':'windows_precheck_passed','workers':pre['workers']}),flush=True)
stage='/opt/phone-cloud-platform/staging/lookup-ocr-probe-pressure-20261020-rc.1'
code=(p/'activate.py').read_text();ast.parse(code)
subprocess.run(cloud+['python3 -c '+"'import sys,pathlib;pathlib.Path(\""+stage+'/activate.py'+"\").write_text(sys.stdin.read())'"],input=code,text=True,check=True,timeout=15)
process=subprocess.Popen(cloud+['python3 -u '+stage+'/activate.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=None,text=True,bufsize=1)
updated=False;events=[]
for line in process.stdout:
 if not line.strip():continue
 event=json.loads(line);events.append(event);print(json.dumps(event),flush=True)
 if event.get('phase')=='cloud_stopped_wait_windows':
  try:
   receipt=windows('apply');updated=True
   (p/'WINDOWS-ACTIVATED.json').write_text(json.dumps(receipt,indent=2)+'\n')
   process.stdin.write(json.dumps({'phase':'windows_updated','receipt':receipt})+'\n');process.stdin.flush()
  except Exception as exc:
   process.stdin.write(json.dumps({'phase':'windows_failed'})+'\n');process.stdin.flush();print(str(exc),file=sys.stderr)
status=process.wait(timeout=10)
(p/'ACTIVATION-EVENTS.json').write_text(json.dumps({'exitCode':status,'windowsUpdated':updated,'events':events},indent=2)+'\n')
if status:raise SystemExit('Deployment interrupted; inspect receipt before any further mutation')
assert updated and events[-1].get('version')=='lookup-ocr-probe-pressure-20261021-deployed.1'
(p/'DEPLOYED.json').write_text(json.dumps(events[-1],indent=2)+'\n')
