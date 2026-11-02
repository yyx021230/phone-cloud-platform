"""Explicit single-phone isolated preview. Source pinned; no shared service load.
Phone and authority secrets arrive via stdin, never source files or arguments.
Unknown exit/cleanup retains the real reservation obligation, blocks further runs.
"""
import base64
import concurrent.futures
import datetime
import hashlib
import http.server
import json
import os
from pathlib import Path
import queue
import secrets
import subprocess
import sys
import threading
import time
import uuid
import wecom_qa_access as q
from wecom_candidate_source import ROOT,candidate_files
from wecom_qa_proof import current_snapshot


def require(ok,code):
    if not ok:raise RuntimeError(code)


class LocalAPI:
    def __init__(self,folder,number,serial):
        self.lock=threading.Lock()
        self.child=subprocess.Popen(['node',str(ROOT/'scripts/qa/wecom_candidate_api.mjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(folder/'api-stderr.log').open('w'),text=True)
        self.ready=self.ask(dict(folder=str(folder),deviceNumber=number,serial=serial));require(self.ready.get('ready'),'qa_local_api_not_ready')
    def ask(self,value):
        with self.lock:
            self.child.stdin.write(json.dumps(value)+'\n');self.child.stdin.flush();raw=self.child.stdout.readline()
            require(bool(raw),'qa_local_api_closed');r=json.loads(raw)
            require('error'not in r,r.get('error','qa_local_api_failed'))
            return r.get('result',r)
    def close(self):
        self.ask(dict(op='close'));self.child.wait(timeout=10)


def cloud_state(target,session=None,reader=None):
    if reader is not None:return reader.state(target,session)
    return q.cloud('''const t=input.target;const v=await Promise.all([api('/api/v1/devices'),api('/api/v1/device-locks'),api('/api/v1/admin/lookup-pool'),...(input.session?[api('/api/v1/screen-sessions/'+input.session)]:[])]);
if(v.some(x=>x.status!==200))throw Error('qa_state_read_failed');const pool=v[2].body.pool;
const ds=v[0].body.devices.filter(d=>d.deviceId===t.deviceId&&d.adb?.serial===t.serial);
const locks=v[1].body.locks.filter(l=>l.deviceId===t.deviceId&&l.status==='active');
console.log(JSON.stringify({devices:ds,locks,session:v[3]?.body.session||null,lookupExcluded:!pool.devices.some(d=>d.enabled&&d.deviceId===t.deviceId)&&!pool.channels.some(d=>d.deviceId===t.deviceId),lookupCounts:pool.counts}));''',dict(target=target,session=session),timeout=5)


def validate_state(binding,state,now=None):
    now=time.time()if now is None else now
    require(state['lookupExcluded']and len(state['devices'])==1,'qa_lookup_or_identity_conflict')
    d=state['devices'][0];a=d['adb'];require(a['state']=='device'and a['agentId']==binding['physicalAgentId'],'qa_target_offline_or_agent_changed')
    require(len(state['locks'])==1,'qa_not_exclusive');lock=state['locks'][0];session=state['session']
    require(lock['lockId']==binding['lockId']and lock['taskId']==binding['sessionId']and lock['lockType']=='screen_control'and lock['ownerUserId']==binding['ownerUserId'],'qa_lock_changed')
    require(session and session['sessionId']==binding['sessionId']and session['deviceId']==binding['deviceId']and session['status']in('ready','streaming'),'qa_session_not_alive')
    require((d.get('occupancy')or{}).get('sessionId')==binding['sessionId'],'qa_occupancy_changed')
    expiry=min(datetime.datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()for v in (lock['expiresAt'],session['expiresAt']))-now
    require(expiry>20,'qa_expiry_too_close');return expiry


def reader_capacity(identity):
    # Count unique native Poco hosts (not OCR grandchildren). Staging hosts count
    # against the SAME configured budget; check room for one slot before live execution (not an atomic reservation).
    return q.win(r'''
import psutil,json
from pathlib import Path
config=json.loads(Path(r'D:\PhoneCloud\agent\config.json').read_text(encoding='utf-8-sig'))
rows=[]
for p in psutil.process_iter(['pid','cmdline','name']):
 try:
  scripts=[str(a).replace('\\','/').rsplit('/',1)[-1].lower()for a in(p.info['cmdline']or[])if str(a).endswith('.py')]
  if any(x in scripts for x in ('xhs_airtest_poco.py','alipay_name_lookup.py','wecom_platform_preview.py','wecom_standalone_preview.py','xhs_isolated_runner.py')):rows.append({'pid':p.pid,'scripts':scripts})
 except (psutil.NoSuchProcess,psutil.AccessDenied):pass
print(json.dumps({'limit':int(config.get('airtestMaxResidentWorkers',8)),'residentHosts':rows,'observedCount':len(rows)}))''')


def main():
    require(__debug__ and not os.environ.get('PYTHONOPTIMIZE'),'qa_optimized_python_forbidden')
    incoming=json.loads(sys.stdin.readline());number=incoming['deviceNumber'];phone=incoming['phoneNumber'];ref=incoming['sourceRef']
    require(number in ('23','25','43','59','93','145'),'qa_number_not_allowed')
    require(len(phone)==11 and phone.isdigit(),'qa_invalid_phone')
    require(len(ref)==40 and all(c in '0123456789abcdef'for c in ref),'qa_source_not_immutable')
    files=candidate_files(ref);folder=Path('/private/tmp')/('pc-wecom-live-'+uuid.uuid4().hex);folder.mkdir(mode=0o700)
    def save(name,value):
        p=folder/name;p.write_text(json.dumps(value,ensure_ascii=True,indent=2));p.chmod(0o600)
    identity=q.attest();save('identity-before.json',identity);capacity=reader_capacity(identity);save('capacity-before.json',capacity)
    require(capacity['observedCount']+1<=capacity['limit'],'qa_no_reader_capacity')
    devices=json.loads(files['windows-agent/scripts/wecom_preview_devices.json']);serial=devices[number]['serial']
    target=dict(deviceId='adb:'+serial,serial=serial,deviceNumber=number)
    reader=q.CloudReader()
    read_state=lambda target,session=None:cloud_state(target,session,reader=reader)
    first=read_state(target);require(len(first['devices'])==1 and first['lookupExcluded']and not first['locks']and not first['devices'][0].get('occupancy')and first['devices'][0]['adb']['state']=='device','qa_target_not_idle')
    save('preflight.json',dict(number=number,lookupCounts=first['lookupCounts'],capacity=capacity))
    api=LocalAPI(folder,number,serial);lock=threading.Lock();stop=threading.Event();cache={};ctx={};stats=dict(snapshots=0,proofs=0,readFailures=0)
    native_answer=None;session=None;keeper=None;physical_safe=False;staged=False
    created=api.ask(dict(op='create',appSlot='main',phoneNumber=phone,requestId='isolated-'+uuid.uuid4().hex,remarkName='QA',description='QA'))
    job=created['task']['jobId'];task=api.ask(dict(op='next'))['task'];require(task['payload']['automationJobId']==job,'qa_wrong_local_task')
    taskid=task['taskId'];locallease=api.ask(dict(op='lease',taskId=taskid));require(locallease['valid'],'qa_local_lease_invalid')
    core=dict(taskId=taskid,**target,appSlot='main',androidUser=0,agentId=api.ready['agentId'],physicalAgentId=first['devices'][0]['adb']['agentId'])
    save('task-receipt.json',dict(sourceRef=ref,number=number,jobId=job,taskId=taskid,mode='preview',phoneTail=phone[-4:],productionWindowsTask=False,proofVersion=2))
    def refresh():
        while not stop.is_set():
            with lock:c=dict(ctx)
            if c:
                started=time.monotonic()
                try:
                    with concurrent.futures.ThreadPoolExecutor(max_workers=2)as ex:
                        sf=ex.submit(read_state,target,c['sessionId'])
                        lf=ex.submit(api.ask,dict(op='lease',taskId=taskid))if c['purpose']=='preview'else None
                        s=sf.result();expiry=validate_state(c,s)
                        if lf:
                            l=lf.result();require(l.get('valid')is True and l.get('taskId')==taskid and l.get('deviceId')==target['deviceId']and l.get('operationFingerprint',c['operationFingerprint'])==c['operationFingerprint'],'qa_local_lease_lost')
                    with lock:
                        if ctx.get('authorityGeneration')==c['authorityGeneration'] and not(cache.get('generation')==c['authorityGeneration']and cache.get('allowed')is False) and started>=cache.get('at',0):
                            cache.update(at=started,expiry=expiry,allowed=True,generation=c['authorityGeneration'])
                    stats['snapshots']+=1
                except RuntimeError as e:
                    if str(e).startswith(('qa_lock_','qa_lookup_','qa_local_lease_lost','qa_target_offline','qa_session_','qa_occupancy_','qa_not_exclusive')):
                        with lock:cache.update(at=started,allowed=False,generation=c['authorityGeneration'])
                    stats['readFailures']+=1
                except Exception:stats['readFailures']+=1
            stop.wait(.6)
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            received=time.monotonic()
            try:
                n=int(self.headers.get('Content-Length','0'));require(0<n<65536,'qa_request_size')
                request=json.loads(self.rfile.read(n))
                with lock:c=dict(ctx);snapshot=dict(cache)
                require(c and secrets.compare_digest(self.headers.get('Authorization',''),'Bearer '+c['brokerToken'])and request.get('taskId')==taskid,'qa_request_denied')
                if self.path=='/guard':
                    require(request.get('proofVersion')==c['proofVersion'] and request.get('purpose')==c['purpose']and request.get('authorityGeneration')==c['authorityGeneration']and isinstance(request.get('nonce'),str)and len(request['nonce'])==32,'qa_generation_changed')
                    def read_snapshot():
                        with lock:return dict(cache)
                    def fetch_current():
                        began=time.monotonic()
                        actual=read_state(target,c['sessionId']);expiry=validate_state(c,actual)
                        if c['purpose']=='preview':
                            local=api.ask(dict(op='lease',taskId=taskid))
                            require(local.get('valid')is True and local.get('operationFingerprint')==c['operationFingerprint'],'qa_local_lease_lost')
                        return dict(at=began,expiry=expiry,allowed=True,generation=c['authorityGeneration'])
                    snapshot,age,allowed,via=current_snapshot(read_snapshot,c['authorityGeneration'],fetch_current)
                    with (folder/'proof-supply.jsonl').open('a')as log:
                        log.write(json.dumps(dict(index=stats['proofs'],purpose=c['purpose'],via=via,allowed=allowed,ageAtSendMs=round(age*1000),ageBeforeRequestMs=round(max(0,received-snapshot.get('at',received))*1000),generation=c['authorityGeneration']))+'\n')
                    body={k:c[k]for k in ('taskId','deviceId','serial','deviceNumber','appSlot','androidUser','agentId','physicalAgentId','sessionId','lockId','ownerUserId','operationFingerprint','purpose','authorityGeneration','scopeFingerprint')}
                    body.update(version=2,ageReference='request_received',allowed=allowed,nonce=request['nonce'],brokerAgeSeconds=max(0,received-snapshot.get('at',received)),expiresInSeconds=snapshot.get('expiry',0),activeLockCount=1,sessionAlive=allowed,lookupExcluded=allowed);stats['proofs']+=1
                elif self.path=='/report':
                    require(c['purpose']=='preview'and request.get('kind')in('events','status'),'qa_report_denied')
                    body=api.ask(dict(op='report',taskId=taskid,kind=request['kind'],body=request['body']))
                else:raise RuntimeError('qa_route_denied')
                self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(body).encode())
            except Exception as error:
                reason=str(error)if isinstance(error,RuntimeError)and str(error).startswith(('qa_lock_','qa_lookup_','qa_local_lease_','qa_target_','qa_session_','qa_occupancy_','qa_not_exclusive','qa_expiry_','qa_generation_'))else 'qa_proof_read_failed'
                with (folder/'proof-supply.jsonl').open('a')as log:log.write(json.dumps(dict(allowed=False,deniedReason=reason))+'\n')
                self.send_response(409);self.end_headers();self.wfile.write(b'{"allowed":false}')
    broker=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=broker.serve_forever,daemon=True).start();threading.Thread(target=refresh,daemon=True).start()
    port=q.win("import socket,json\ns=socket.socket();s.bind(('127.0.0.1',0));print(json.dumps(s.getsockname()[1]));s.close()")
    forward=f'127.0.0.1:{port}:127.0.0.1:{broker.server_port}'
    tunneled=subprocess.run(q.WINDOWS[:-1]+['-O','forward','-R',forward,q.WINDOWS[-1]],capture_output=True,timeout=6)
    require(tunneled.returncode==0,'qa_tunnel_failed')
    stage='D:/PhoneCloud/staging/wecom-qa-'+ref[:8]+'-'+uuid.uuid4().hex[:10]
    def activate(binding):
        with lock:ctx.clear();ctx.update(binding);cache.clear()
        for _ in range(60):
            with lock:snap=dict(cache)
            if snap.get('allowed')and snap.get('generation')==binding['authorityGeneration']and time.monotonic()-snap['at']<2.2:return
            time.sleep(.1)
        raise RuntimeError('qa_fresh_proof_unavailable')
    def inventory_owned():
        return q.win("from pathlib import Path\nimport json,time\np=Path(r'D:\\PhoneCloud\\agent\\data\\device-scan-cache.json');v=json.loads(p.read_text(encoding='utf-8-sig'));ds=v if isinstance(v,list)else v['devices'];d=next(d for d in ds if d['deviceId']=="+repr(target['deviceId'])+");print(json.dumps({'age':time.time()-p.stat().st_mtime,'occupancy':d.get('occupancy')}))")
    try:
        current=read_state(target);require(current['lookupExcluded']and not current['locks']and not current['devices'][0].get('occupancy'),'qa_target_became_busy')
        r=q.request('/api/v1/user/devices/'+target['deviceId']+'/screen-sessions','POST',{});require(r['status']==201,'qa_screen_acquisition_failed');session=r['body']['session']['sessionId']
        save('reservation-receipt.json',dict(sessionId=session,deviceNumber=number,deviceId=target['deviceId'],sourceRef=ref,obligation='retain_until_exit_and_cleanup_proved'))
        keepercode="import {WebSocket}from'ws';const w=new WebSocket('ws://127.0.0.1:8787/realtime/v1/sessions/'+"+json.dumps(session)+"+'/control?token='+encodeURIComponent("+json.dumps(r['body']['browserToken'])+"));w.on('open',()=>console.log('ready'));w.on('error',()=>process.exit(1));w.on('close',()=>process.exit(0));"
        keeper=subprocess.Popen(q.CLOUD+['docker exec -i phone-cloud-platform node --input-type=module'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True);keeper.stdin.write(keepercode);keeper.stdin.close()
        ready=queue.Queue();threading.Thread(target=lambda:ready.put(keeper.stdout.readline()),daemon=True).start();require(ready.get(timeout=10).strip()=='ready','qa_keeper_failed')
        for _ in range(30):
            s=read_state(target,session)
            if s['session']['status']in('ready','streaming'):break
            time.sleep(.3)
        l=s['locks'][0];core.update(sessionId=session,lockId=l['lockId'],ownerUserId=l['ownerUserId'],operationFingerprint=locallease['operationFingerprint'])
        binding=dict(core,proofVersion=2,purpose='preview',authorityGeneration=uuid.uuid4().hex,scopeFingerprint=core['operationFingerprint'],inventoryPath=r'D:\PhoneCloud\agent\data\device-scan-cache.json',brokerUrl='http://127.0.0.1:'+str(port),brokerToken=secrets.token_urlsafe(36),**{k:identity[k]for k in ('agentPid','agentExe','agentCreatedAt','adbPid','adbCreatedAt','adbExe')})
        activate(binding)
        for _ in range(70):
            inv=inventory_owned()
            if inv['age']<90 and(inv['occupancy']or{}).get('sessionId')==session:break
            time.sleep(.5)
        else:raise RuntimeError('qa_inventory_not_owned')
        cap=reader_capacity(identity);require(cap['observedCount']+1<=cap['limit'],'qa_reader_capacity_changed')
        fresh=q.attest();require(all(fresh[k]==identity[k]for k in ('agentPid','agentCreatedAt','adbPid','adbCreatedAt','files')),'qa_runtime_changed')
        blobs={n:base64.b64encode(b).decode()for n,b in files.items()}
        upload="import base64,hashlib,json\nfrom pathlib import Path\nstage=Path("+repr(stage)+");assert not stage.exists();stage.mkdir(parents=True)\nfiles="+repr(blobs)+"\nfor name,blob in files.items():\n p=stage/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(base64.b64decode(blob))\nprint(json.dumps({n:hashlib.sha256((stage/n).read_bytes()).hexdigest()for n in files}))"
        hashes=q.win(upload,timeout=20);require(hashes=={n:hashlib.sha256(b).hexdigest()for n,b in files.items()},'qa_staged_hash_changed');staged=True;save('staged-source-hashes.json',hashes)
        config=dict(pythonCommand=q.PYTHON,agentId=api.ready['agentId'],serverBaseUrl='http://127.0.0.1',agentToken='isolated-local-fixture-only')
        envelope=dict(task=task,config=config,reservation=binding)
        run="""import subprocess,json,psutil,sys
sys.path.insert(0,STAGE+'/scripts/qa')
from wecom_staging_process import capture_process
p=subprocess.Popen([NODE,STAGE+'/scripts/qa/wecom_candidate_host.mjs'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
p.stdin.write(ENVELOPE+'\\n');p.stdin.flush()
def inspect(pid):return {'pid':pid,'createdAt':psutil.Process(pid).create_time()}
def observe(pid):
 try:
  for child in psutil.Process(pid).children(recursive=True):
   if any(str(a).endswith('wecom_standalone_preview.py')for a in child.cmdline()):return inspect(child.pid)
 except(psutil.NoSuchProcess,psutil.AccessDenied):pass
r=capture_process(p,observe_native=observe,inspect_node=inspect)
if not r['pending']:
 r['answer']=json.loads(r.pop('stdout'))if r['pipeDrainComplete']and r.get('stdout','').strip()else None
print(json.dumps(r))
""".replace('NODE',repr(identity['agentExe'])).replace('STAGE',repr(stage)).replace('ENVELOPE',repr(json.dumps(envelope,ensure_ascii=True)))
        # This source is stdin only. No phone, token or envelope in argv/files.
        answer=q.win(run,timeout=305);save('native-answer.json',answer);require(not answer.get('pending'),'qa_host_exit_unknown_retain_reservation')
        native_answer=answer.get('answer');require(answer['hostExitCode']==0 and native_answer and native_answer.get('childExited'),'qa_host_failed_retain_reservation')
        resources=native_answer.get('resources');require(resources is not None,'qa_resources_unconfirmed_retain_reservation')
        original_hosts=[answer['node'],answer['native']];require(all(original_hosts),'qa_host_identity_missing')
        payload=dict(taskId=taskid,deviceId=task['deviceId'],serial=task['adbSerial'],deviceNumber=number,androidUser=0,appSlot='main',remarkName=task['payload']['remarkName'],description=task['payload']['description'],phoneNumber=phone,previewOnly=True,mode='preview',agentId=api.ready['agentId'],serverBaseUrl='http://127.0.0.1',agentToken='isolated-local-fixture-only')
        scope=hashlib.sha256(json.dumps([resources,original_hosts],sort_keys=True,separators=(',',':')).encode()).hexdigest()
        cleanupbinding=dict(binding,purpose='cleanup',authorityGeneration=uuid.uuid4().hex,brokerToken=secrets.token_urlsafe(36),scopeFingerprint=scope)
        activate(cleanupbinding)
        cleanenv=dict(task=payload,reservation=cleanupbinding,resources=resources,originalHosts=original_hosts)
        cleanupcode="import subprocess,json\nr=subprocess.run(["+repr(q.PYTHON)+","+repr(stage+'/windows-agent/scripts/wecom_standalone_cleanup.py')+"],input="+repr(json.dumps(cleanenv)) +"+'\\n',capture_output=True,text=True,encoding='utf-8',timeout=25);print(json.dumps({'exitCode':r.returncode,'result':json.loads(r.stdout)if r.stdout.strip()else None}))"
        cleanup=q.win(cleanupcode,timeout=30);save('cleanup-result.json',cleanup);require(cleanup.get('exitCode')==0 and(cleanup.get('result')or{}).get('cleanupConfirmed')is True,'qa_cleanup_unconfirmed_retain_reservation')
        physical_safe=True
        result=api.ask(dict(op='result',jobId=job));save('local-result.json',result)
        journal=q.win('from pathlib import Path\nimport json\nprint(json.dumps(Path('+repr(stage+'/qa-events.jsonl')+').read_text(encoding="utf-8")))');(folder/'qa-events.jsonl').write_text(journal)
        closes=[json.loads(x)for x in journal.splitlines()if json.loads(x).get('kind')=='child_close'];require(len(closes)==1,'qa_child_close_evidence_missing')
        released=q.request('/api/v1/screen-sessions/'+session,'DELETE',{});require(released['status']==200,'qa_release_not_confirmed')
        after=read_state(target,session);require(not after['locks']and after['session']['status']in('closed','failed'),'qa_release_proof_missing')
        save('release-proof.json',dict(session=after['session']['sessionId'],status=after['session']['status'],activeLocks=len(after['locks'])))
        final=q.attest();save('identity-after.json',final);require(all(final[k]==identity[k]for k in ('agentPid','agentCreatedAt','adbPid','adbCreatedAt','files')),'qa_runtime_changed_after')
        r=result['task'];passed=r['status']=='succeeded'and closes[0]['code']==0 and(native_answer.get('nativeResult')or{}).get('previewStatus')=='ready_before_send'and physical_safe
        save('outcome.json',dict(passed=passed,number=number,sourceRef=ref,jobId=job,status=r['status'],code=r['result']['code'],nativeExitCode=closes[0]['code'],physicalCleanup=physical_safe,sessionReleased=True,productionUnchanged=True,stats=stats))
        print(json.dumps(dict(passed=passed,number=number,code=r['result']['code'],status=r['status'],cleanup=physical_safe,sessionReleased=True,evidence=str(folder))))
    except Exception as error:
        code=str(error)if isinstance(error,RuntimeError)and str(error).startswith('qa_')else 'qa_isolated_execution_failed'
        save('pending-obligation.json',dict(code=code,sessionId=session,deviceNumber=number,sourceRef=ref,stage=stage,physicalCleanup=physical_safe,staged=staged,doNotStartAnother=True))
        print(json.dumps(dict(passed=False,code=code,sessionId=session,evidence=str(folder),needsScopedContinuation=True)),flush=True)
        # A live reservation must not disappear in a generic finally. Keep the
        # broker, original local task, and WS keeper available for scoped recovery.
        if session and not physical_safe:
            while True:
                save('obligation-liveness.json',dict(at=time.time(),stats=stats,holderPid=os.getpid(),protection='active_broker_and_keeper_no_timed_release'));time.sleep(1)
    finally:
        if session is None or physical_safe:
            stop.set();broker.shutdown()
            if keeper and keeper.poll()is None:keeper.terminate();keeper.wait(timeout=5)
            subprocess.run(q.WINDOWS[:-1]+['-O','cancel','-R',forward,q.WINDOWS[-1]],capture_output=True,timeout=5)
            api.close()
            reader.close()

if __name__=='__main__':main()
