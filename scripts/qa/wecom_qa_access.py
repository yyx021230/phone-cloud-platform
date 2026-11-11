"""Explicit operator SSH access for the isolated harness; no credentials stored."""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess

CLOUD_SOCKET=os.environ.get('WECOM_QA_CLOUD_SOCKET','/private/tmp/pc-wecom-diag-cloud-20261102.sock')
WINDOWS_SOCKET=os.environ.get('WECOM_QA_WINDOWS_SOCKET','/private/tmp/pc-wecom-diag-windows-20261102.sock')
CLOUD_HOST=os.environ.get('WECOM_QA_CLOUD_HOST','root@47.98.127.132')
WINDOWS_HOST=os.environ.get('WECOM_QA_WINDOWS_HOST','Administrator@100.100.177.27')
PYTHON=r'D:\PhoneCloud\tools\python39\python.exe'
CLOUD=['ssh','-S',CLOUD_SOCKET,'-o','BatchMode=yes','-o','ConnectTimeout=5',CLOUD_HOST]
WINDOWS=['ssh','-S',WINDOWS_SOCKET,'-o','BatchMode=yes','-o','ConnectTimeout=5',WINDOWS_HOST]
API="""
const headers={Authorization:'Bearer '+process.env.ADMIN_API_TOKEN,'Content-Type':'application/json'};
async function api(route,method='GET',body){const response=await fetch('http://127.0.0.1:8787'+route,{method,headers,redirect:'error',signal:AbortSignal.timeout(2000),...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};}
"""
OWN_SESSIONS=set()


def cloud(code,body=None,timeout=7):
    if not Path(CLOUD_SOCKET).is_socket(): raise RuntimeError('qa_cloud_master_missing')
    source="let raw='';for await(const part of process.stdin)raw+=part;const input=JSON.parse(raw||'{}');\n"+API+code
    command='docker exec -i phone-cloud-platform node --input-type=module -e '+shlex.quote(source)
    result=subprocess.run(CLOUD+[command],input=json.dumps(body or {},ensure_ascii=True).encode(),capture_output=True,timeout=timeout)
    if result.returncode: raise RuntimeError('qa_cloud_transport_unknown')
    return json.loads(result.stdout)


def request(route,method='GET',body=None):
    if method=='POST':
        if not re.fullmatch(r'/api/v1/user/devices/[^/]+/screen-sessions',route):raise ValueError('qa_production_post_forbidden')
    elif method=='DELETE':
        if route!='/api/v1/screen-sessions/'+route.rsplit('/',1)[-1] or route.rsplit('/',1)[-1] not in OWN_SESSIONS:
            raise ValueError('qa_not_owned_session')
    elif method!='GET':raise ValueError('qa_production_method_forbidden')
    payload={'route':route,'method':method}
    if method!='GET':payload['body']=body
    value=cloud("const result=await api(input.route,input.method,input.body);console.log(JSON.stringify(result));",payload,timeout=10)
    if method=='POST' and value['status']==201: OWN_SESSIONS.add(value['body']['session']['sessionId'])
    if method=='DELETE' and value['status']==200: OWN_SESSIONS.discard(route.rsplit('/',1)[-1])
    return value


def win(code,timeout=12):
    if not Path(WINDOWS_SOCKET).is_socket(): raise RuntimeError('qa_windows_master_missing')
    source="import sys\nsys.stdout.reconfigure(encoding='utf-8')\n"+code
    result=subprocess.run(WINDOWS+['"'+PYTHON+'" -'],input=source.encode('utf-8'),capture_output=True,timeout=timeout)
    if result.returncode:raise RuntimeError('qa_windows_read_or_execution_failed')
    return json.loads(result.stdout.decode('utf-8-sig'))


def attest():
    return win(r'''
import psutil,json,hashlib,datetime
from pathlib import Path
ids={c.pid for c in psutil.net_connections(kind='tcp')if c.status=='LISTEN'and c.laddr.port==5037}
assert len(ids)==1,'adb_listener_unconfirmed'
adb=psutil.Process(next(iter(ids)))
assert adb.username()==r'NT AUTHORITY\SYSTEM'and Path(adb.exe())==Path(r'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe'),'adb_identity_unconfirmed'
agents=[];readers=[];staged=[]
for proc in psutil.process_iter(['pid','ppid','name','cmdline','exe','username','create_time']):
 try:
  d=proc.info;args=d['cmdline']or[];parts=[str(a).replace('\\','/').lower()for a in args]
  if (d['name']or'').lower()=='node.exe'and any(a.endswith('src/index.mjs')for a in parts):agents.append(d)
  if any('poco' in a or 'alipay_name' in a or 'wecom_standalone' in a for a in parts):readers.append({'pid':d['pid'],'parent':d['ppid'],'kind':'native_candidate_or_lookup'})
  if any('/staging/' in a and ('wecom-' in a or 'xhs-' in a)for a in parts):staged.append({'pid':d['pid'],'parent':d['ppid']})
 except(psutil.NoSuchProcess,psutil.AccessDenied):pass
assert len(agents)==1 and agents[0]['username']==r'NT AUTHORITY\SYSTEM','agent_identity_unconfirmed'
a=agents[0];files={}
for name in ['src/index.mjs','src/wecom-preview-task.mjs','scripts/wecom_platform_preview.py']:
 files[name]=hashlib.sha256((Path(r'D:\PhoneCloud\agent')/name).read_bytes()).hexdigest()
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'agentPid':a['pid'],'agentExe':a['exe'],'agentCreatedAt':a['create_time'],'adbPid':adb.pid,'adbCreatedAt':adb.create_time(),'adbExe':adb.exe(),'readers':readers,'staged':staged,'files':files}))
''')


class CloudReader:
    """One owned, bounded read-only SSH client. Failed/late streams never reused."""
    def __init__(self):
        import queue
        import threading
        self.rows=queue.Queue(maxsize=2);self.lock=threading.Lock();self.sequence=0;self.failed=False
        if not Path(CLOUD_SOCKET).is_socket():raise RuntimeError('qa_cloud_master_missing')
        source=Path(__file__).with_name('wecom_cloud_reader.mjs').read_text()
        command='docker exec -i phone-cloud-platform node --input-type=module -e '+shlex.quote(source)
        self.child=subprocess.Popen(CLOUD+[command],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
        def read():
            try:
                while True:
                    raw=self.child.stdout.readline(65537)
                    if not raw:break
                    if len(raw)>65536:raise ValueError()
                    self.rows.put_nowait(json.loads(raw))
            except Exception:pass
            finally:
                try:self.rows.put_nowait({'error':'qa_cloud_reader_closed'})
                except queue.Full:pass
        threading.Thread(target=read,daemon=True).start()
        try:
            ready=self.rows.get(timeout=5)
            if ready!={'ready':True}:raise ValueError()
        except Exception:
            self.close();raise RuntimeError('qa_cloud_reader_not_ready')
    def state(self,target,session=None):
        import queue
        import time
        started=time.monotonic()
        if not self.lock.acquire(timeout=2.7):
            self.failed=True
            if self.child.poll()is None:self.child.terminate()
            raise RuntimeError('qa_cloud_reader_delivery_unknown')
        try:
            if self.failed:raise RuntimeError('qa_cloud_reader_delivery_unknown')
            self.sequence+=1
            try:
                remaining=2.7-(time.monotonic()-started)
                if remaining<=0:raise queue.Empty()
                self.child.stdin.write(json.dumps(dict(seq=self.sequence,target=target,session=session))+'\n');self.child.stdin.flush()
                row=self.rows.get(timeout=remaining)
                if self.failed or row.get('seq')!=self.sequence or 'result'not in row:raise ValueError()
                return row['result']
            except Exception:
                self.failed=True
                if self.child.poll()is None:self.child.terminate()
                raise RuntimeError('qa_cloud_reader_delivery_unknown')
        finally:self.lock.release()
    def close(self):
        self.failed=True
        if getattr(self,'child',None)is None:return
        if self.child.stdin and not self.child.stdin.closed:
            try:self.child.stdin.close()
            except OSError:pass
        try:self.child.wait(timeout=3)
        except subprocess.TimeoutExpired:self.child.terminate();self.child.wait(timeout=3)
        self.child.stdout.close()
