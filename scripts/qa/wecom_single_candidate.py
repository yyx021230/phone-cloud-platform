"""One controlled pre-send QA: real screen ownership plus durable unlisting.

Not a production task/API test. Never run two phones concurrently. New unknown
state remains unlisted; normal exit alone never restores availability.
"""
import ast
import base64
import concurrent.futures
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
from wecom_single_state import Reader,assert_idle,assert_owned,listing,require,transport
from wecom_qa_proof import current_snapshot

ROOT=Path(__file__).resolve().parents[2]


def candidate_files(ref):
    def read(name):return subprocess.check_output(['git','show',ref+':'+name],cwd=ROOT)
    pending=['wecom_standalone_peer_preview','wecom_standalone_peer_cleanup']
    files={}
    while pending:
        name=pending.pop();path='windows-agent/scripts/'+name+'.py'
        if path in files:continue
        data=read(path);files[path]=data
        for node in ast.walk(ast.parse(data)):
            mods=[node.module]if isinstance(node,ast.ImportFrom)else[a.name for a in node.names]if isinstance(node,ast.Import)else[]
            pending.extend(m for m in mods if m and m.startswith('wecom_') and m!=name)
    for path in ['windows-agent/scripts/wecom_preview_devices.json','scripts/qa/wecom_staging_process.py','scripts/qa/wecom_single_capture.py']:
        files[path]=read(path)
    return files


def capacity():
    return q.win(r"""import psutil,json
from pathlib import Path
config=json.loads(Path(r'D:\PhoneCloud\agent\config.json').read_text(encoding='utf-8-sig'))
names={'xhs_airtest_poco.py','alipay_name_lookup.py','wecom_platform_preview.py','wecom_standalone_preview.py','wecom_standalone_peer_preview.py','xhs_isolated_runner.py'}
rows=[]
for p in psutil.process_iter(['pid','name']):
 try:
  name=p.info.get('name')
  if not isinstance(name,str)or not name:raise RuntimeError('qa_reader_capacity_unknown')
  if not name.lower().startswith('python'):continue
  args=p.cmdline()
  if not isinstance(args,list):raise RuntimeError('qa_reader_capacity_unknown')
  if any(str(a).replace('\\','/').rsplit('/',1)[-1]in names for a in args):rows.append(p.pid)
 except psutil.NoSuchProcess:pass
 except psutil.AccessDenied:raise RuntimeError('qa_reader_capacity_unknown')from None
print(json.dumps({'limit':int(config.get('airtestMaxResidentWorkers',8)),'pids':rows}))""")


def inventory_owned(binding, *, clock=time.monotonic, sleep=time.sleep):
    """Wait for the existing Agent cache; never refresh it or run ADB."""
    target={k:binding[k]for k in('deviceId','serial','deviceNumber','physicalAgentId','sessionId')}
    code=r"""import json,time
from pathlib import Path
t=TARGET
p=Path(r'D:\PhoneCloud\agent\data\device-scan-cache.json')
v=json.loads(p.read_text(encoding='utf-8-sig'));ds=v if isinstance(v,list)else v['devices']
rows=[d for d in ds if str(d.get('deviceId','')).lower()==t['deviceId'].lower()or str(d.get('adb',{}).get('serial','')).lower()==t['serial'].lower()]
age=time.time()-p.stat().st_mtime
ready=False
if len(rows)==1:
 d=rows[0];a=d.get('adb',{});o=d.get('occupancy')or{}
 ready=(d.get('deviceId')==t['deviceId']and str(d.get('deviceName'))==t['deviceNumber']and a.get('serial')==t['serial']and a.get('agentId')==t['physicalAgentId']and a.get('state')=='device'and o.get('kind')=='screen_control'and o.get('sessionId')==t['sessionId']and 0<=age<=90)
print(json.dumps({'ready':ready,'ageSeconds':age,'matchingRows':len(rows)}))
""".replace('TARGET',repr(target))
    until=clock()+20
    while True:
        remaining=until-clock();require(remaining>0,'qa_inventory_wait_timeout')
        result=q.win(code,timeout=min(8,remaining))
        if result.get('ready')is True:return result
        sleep(min(.5,max(0,until-clock())))


def main():
    incoming=json.loads(sys.stdin.readline());number=incoming['deviceNumber'];phone=incoming['phoneNumber'];ref=incoming['sourceRef']
    require(number in ('59','25','145'),'qa_target_not_in_this_round')
    require(len(phone)==11 and phone.isdigit()and phone.endswith('6441'),'qa_recipient_scope')
    require(len(ref)==40 and all(c in'0123456789abcdef'for c in ref),'qa_source_not_immutable')
    files=candidate_files(ref)
    folder=Path('/private/tmp')/('pc-wecom-single-'+uuid.uuid4().hex);folder.mkdir(mode=0o700)
    def save(name,value):
        p=folder/name;data=json.dumps(value,ensure_ascii=True,indent=2).encode();tmp=p.with_suffix(p.suffix+'.tmp')
        with tmp.open('wb')as stream:os.chmod(tmp,0o600);stream.write(data);stream.flush();os.fsync(stream.fileno())
        os.replace(tmp,p)
    # No SSH password fallback or alternate launch identity when a master expires.
    q.WINDOWS=['ssh','-F','/dev/null','-S',q.WINDOWS_SOCKET,'-o','ControlMaster=no','-o','BatchMode=yes','-o','ProxyCommand=/usr/bin/false','-T',q.WINDOWS_HOST]
    q.CLOUD=['ssh','-F','/dev/null','-S',q.CLOUD_SOCKET,'-o','ControlMaster=no','-o','BatchMode=yes','-o','ProxyCommand=/usr/bin/false','-T',q.CLOUD_HOST]
    identity=q.attest();save('identity-before.json',identity)
    cap=capacity();save('capacity-before.json',cap);require(len(cap['pids'])+1<=cap['limit'],'qa_reader_capacity_full')
    cfg=json.loads(files['windows-agent/scripts/wecom_preview_devices.json']);serial=cfg[number]['serial']
    target=dict(deviceId='adb:'+serial,serial=serial,deviceNumber=number)
    reader=Reader(target);first=reader.state();d=assert_idle(target,first);save('preflight.json',first)
    original=dict(listingStatus=d['listingStatus'],unlistedAt=d.get('unlistedAt'),updatedAt=d.get('updatedAt'))
    fullsource=(ROOT/'verification/wecom-native-rate-20261103/collect.mjs').read_text()
    full=transport(fullsource,{},timeout=30);require(full.get('status')=='observed_not_admitted','qa_global_read_unknown');save('global-before.json',full)
    scope='qa-'+uuid.uuid4().hex;session=None;marker=None;unlist_attempted=False;keeper=None;broker=None;stage=None;physical_safe=False;created_owner=None
    stop=threading.Event();gate=threading.Lock();context={};cache={};revoked=False;forward=None
    first_observation_failure=None
    native_delivery_unknown=False
    fingerprint=hashlib.sha256(json.dumps(['preview',hashlib.sha256(json.dumps(['QA预览','接口联调测试'],ensure_ascii=False,separators=(',',':')).encode()).hexdigest(),phone,target['deviceId'],0],separators=(',',':')).encode()).hexdigest()
    payload=dict(taskId=scope,**target,appSlot='main',androidUser=0,phoneNumber=phone,remarkName='QA预览',description='接口联调测试',mode='preview',previewOnly=True,agentId=scope,serverBaseUrl='http://127.0.0.1',agentToken='not-production-qa-only')
    def journal(phase,**extra):save('maintenance-journal.json',dict(phase=phase,scope=scope,target=target,sourceRef=ref,sessionId=session,unlistedAt=marker,original=original,productionTask=False,unknownMustStayUnlisted=True,**extra))
    try:
        journal('screen_create_intent')
        r=q.request('/api/v1/user/devices/'+target['deviceId']+'/screen-sessions','POST',{});require(r['status']==201,'qa_screen_acquisition_unknown')
        session=r['body']['session']['sessionId'];created_owner=r['body']['session'].get('userId');require(isinstance(created_owner,str)and created_owner,'qa_created_owner_unknown');journal('screen_acquired')
        keepercode="import{WebSocket}from'ws';const w=new WebSocket('ws://127.0.0.1:8787/realtime/v1/sessions/'+"+json.dumps(session)+"+'/control?token='+encodeURIComponent("+json.dumps(r['body']['browserToken'])+"));w.on('open',()=>console.log('ready'));w.on('error',()=>process.exit(1));w.on('close',()=>process.exit(0));"
        keeper=subprocess.Popen(q.CLOUD+['docker exec -i phone-cloud-platform node --input-type=module'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
        keeper.stdin.write(keepercode);keeper.stdin.close();ready=queue.Queue()
        threading.Thread(target=lambda:ready.put(keeper.stdout.readline()),daemon=True).start();require(ready.get(timeout=10).strip()=='ready','qa_keeper_unknown')
        for _ in range(12):
            state=reader.state(session)
            if state.get('session',{}).get('status')in('ready','streaming'):break
            time.sleep(.25)
        require(len(state['locks'])==1,'qa_screen_lock_unknown');lock=state['locks'][0]
        core=dict(taskId=scope,**target,appSlot='main',androidUser=0,agentId=scope,physicalAgentId=d['adb']['agentId'],sessionId=session,lockId=lock['lock_id'],ownerUserId=created_owner,operationFingerprint=fingerprint)
        assert_owned(core,state);save('screen-before-unlist.json',state)
        journal('unlist_intent')
        unlist_attempted=True
        unlisted=listing(target,'unlisted');marker=unlisted.get('unlistedAt');require(isinstance(marker,str)and marker,'qa_unlisted_marker_unknown');journal('unlisted_ack')
        state=reader.state(session);assert_owned(core,state,marker=marker);save('maintenance-confirmed.json',state)
        # This normal device mutation is the restart-surviving manual hold. All
        # cooperating operators must exclude this serial; admin tasks bypass it.
        def fact(generation):
            s=Reader(target).state(session)
            try:expiry=assert_owned(core,s,marker=marker)
            except Exception:
                if not (folder/'first-observed-denial-state.json').exists():save('first-observed-denial-state.json',s)
                raise
            return dict(at=s['readStartedMono'],expiry=expiry,allowed=True,generation=generation)
        def observation_failure(error):
            nonlocal revoked,first_observation_failure
            code=str(error)if isinstance(error,RuntimeError)and str(error).startswith('qa_')else 'qa_observation_unknown'
            transient=code in('qa_read_unknown','qa_transport_unknown','qa_cloud_master_missing')
            with gate:
                if first_observation_failure is None:
                    first_observation_failure=dict(code=code,transient=transient)
                    save('first-observation-failure.json',first_observation_failure)
                cache.clear()
                if not transient:revoked=True
            return transient
        def refresh():
            nonlocal revoked
            while not stop.is_set():
                with gate:generation=context.get('authorityGeneration')
                try:
                    snapshot=fact(generation)
                    with gate:
                        if not revoked and generation and context.get('authorityGeneration')==generation:cache.update(snapshot)
                except Exception as error:observation_failure(error)
                stop.wait(.6)
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                nonlocal revoked
                received=time.monotonic()
                try:
                    n=int(self.headers.get('Content-Length','0'));require(0<n<4096,'qa_guard_input')
                    request=json.loads(self.rfile.read(n))
                    with gate:c=dict(context);fact=dict(cache);denied=revoked
                    require(self.path=='/guard'and c and not denied and keeper.poll()is None,'qa_guard_denied')
                    require(secrets.compare_digest(self.headers.get('Authorization',''),'Bearer '+c['brokerToken']),'qa_guard_denied')
                    require(all(request.get(k)==c[k]for k in('taskId','purpose','authorityGeneration','proofVersion'))and isinstance(request.get('nonce'),str)and len(request['nonce'])==32,'qa_guard_scope')
                    def cached():
                        with gate:return dict(cache)
                    def fresh():
                        try:return fact_snapshot(c['authorityGeneration'])
                        except Exception as error:
                            observation_failure(error);raise
                    snapshot,_,allowed,via=current_snapshot(cached,c['authorityGeneration'],fresh,cache_max_age=2)
                    require(allowed,'qa_guard_stale')
                    with gate:require(not revoked and context.get('authorityGeneration')==c['authorityGeneration'],'qa_guard_revoked')
                    age=max(0,received-snapshot['at'])
                    body={k:c[k]for k in('taskId','deviceId','serial','deviceNumber','appSlot','androidUser','agentId','physicalAgentId','sessionId','lockId','ownerUserId','operationFingerprint','purpose','authorityGeneration','scopeFingerprint')}
                    body.update(version=2,ageReference='request_received',allowed=True,nonce=request['nonce'],brokerAgeSeconds=age,expiresInSeconds=snapshot['expiry']-age,activeLockCount=1,sessionAlive=True,lookupExcluded=True)
                    raw=json.dumps(body).encode();self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
                except Exception as error:
                    if isinstance(error,OSError):return  # No scope change from a closed response socket.
                    code=str(error)if isinstance(error,RuntimeError)else ''
                    temporary=code in('qa_read_unknown','qa_transport_unknown','qa_cloud_master_missing','qa_guard_stale')
                    with gate:
                        if not temporary:revoked=True;cache.clear()
                    raw=b'{"allowed":false}';self.send_response(503 if temporary else 409);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        fact_snapshot=fact
        broker=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=broker.serve_forever,daemon=True).start();threading.Thread(target=refresh,daemon=True).start()
        port=q.win("import socket,json\ns=socket.socket();s.bind(('127.0.0.1',0));print(json.dumps(s.getsockname()[1]));s.close()")
        forward=f'127.0.0.1:{port}:127.0.0.1:{broker.server_port}'
        routed=subprocess.run(q.WINDOWS[:-1]+['-O','forward','-R',forward,q.WINDOWS[-1]],capture_output=True,timeout=6);require(routed.returncode==0,'qa_tunnel_unknown')
        binding=dict(core,proofVersion=2,purpose='preview',authorityGeneration=uuid.uuid4().hex,scopeFingerprint=fingerprint,inventoryPath=r'D:\PhoneCloud\agent\data\device-scan-cache.json',brokerUrl='http://127.0.0.1:'+str(port),brokerToken=secrets.token_urlsafe(36),**{k:identity[k]for k in('agentPid','agentExe','agentCreatedAt','adbPid','adbCreatedAt','adbExe')})
        def activate(value):
            nonlocal revoked
            with gate:require(not revoked,'qa_guard_revoked');context.clear();context.update(value)
            for _ in range(30):
                with gate:fact=dict(cache);denied=revoked
                require(not denied,'qa_guard_revoked')
                if fact.get('allowed')and fact.get('generation')==value['authorityGeneration']and time.monotonic()-fact['at']<2:return
                time.sleep(.1)
            raise RuntimeError('qa_fresh_guard_unavailable')
        activate(binding)
        stage='D:/PhoneCloud/staging/wecom-qa-peer-'+ref[:8]+'-'+uuid.uuid4().hex[:8]
        blobs={n:base64.b64encode(b).decode()for n,b in files.items()}
        upload="import base64,hashlib,json\nfrom pathlib import Path\ns=Path("+repr(stage)+");assert not s.exists();s.mkdir(parents=True)\nf="+repr(blobs)+"\nfor n,b in f.items():\n p=s/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(base64.b64decode(b))\nprint(json.dumps({n:hashlib.sha256((s/n).read_bytes()).hexdigest()for n in f}))"
        hashes=q.win(upload,timeout=20);require(hashes=={n:hashlib.sha256(b).hexdigest()for n,b in files.items()},'qa_staged_hash_changed');save('staged-hashes.json',hashes)
        cache_fact=inventory_owned(core);save('inventory-before-native.json',cache_fact)
        fresh=q.attest();require(all(fresh[k]==identity[k]for k in('agentPid','agentCreatedAt','adbPid','adbCreatedAt','files')),'qa_runtime_changed')
        cap=capacity();require(len(cap['pids'])+1<=cap['limit'],'qa_reader_capacity_changed')
        state=reader.state(session);assert_owned(core,state,marker=marker);journal('native_start_intent',stage=stage)
        run=r"""import subprocess,json,psutil,sys,os
sys.path.insert(0,STAGE+'/scripts/qa')
from wecom_single_capture import capture_owned,original_hosts
controller={'pid':os.getpid(),'createdAt':psutil.Process().create_time()}
p=subprocess.Popen([PYTHON,STAGE+'/windows-agent/scripts/wecom_standalone_peer_preview.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
native={'pid':p.pid,'createdAt':psutil.Process(p.pid).create_time()}
original_hosts(STAGE,[controller,native])
p.stdin.write(ENVELOPE+chr(10));p.stdin.flush()
r=capture_owned(p,STAGE,[controller,native])
r['originalHosts']=[controller,native]
if not r['pending']:
 r['answer']=json.loads(r.pop('stdout'))if r['pipeDrainComplete']and r.get('stdout','').strip()else None
print(json.dumps(r))
""".replace('STAGE',repr(stage)).replace('PYTHON',repr(q.PYTHON)).replace('ENVELOPE',repr(json.dumps(dict(task=payload,reservation=binding))))
        native_delivery_unknown=True
        answer=q.win(run,timeout=305);save('native-answer.json',answer);require(not answer.get('pending')and answer.get('hostExitCode')==0 and answer.get('pipeDrainComplete')and not answer.get('resourceRecordFailure'),'qa_native_exit_unknown')
        native=answer.get('answer')or{};resources=(native.get('isolation')or{}).get('resources');require(resources is not None,'qa_resources_unknown')
        hosts=answer['originalHosts'];journal('native_closed_cleanup_pending',stage=stage,originalHosts=hosts,resources=resources)
        # The fixed scope algorithm is pure: original resources + process births.
        fingerprint_cleanup=hashlib.sha256(json.dumps([resources,hosts],sort_keys=True,separators=(',',':')).encode()).hexdigest()
        cleanupbinding=dict(binding,purpose='cleanup',authorityGeneration=uuid.uuid4().hex,brokerToken=secrets.token_urlsafe(36),scopeFingerprint=fingerprint_cleanup)
        activate(cleanupbinding)
        cleanenv=dict(task=payload,reservation=cleanupbinding,resources=resources,originalHosts=hosts)
        clean="import subprocess,json\nr=subprocess.run(["+repr(q.PYTHON)+","+repr(stage+'/windows-agent/scripts/wecom_standalone_peer_cleanup.py')+"],input="+repr(json.dumps(cleanenv))+"+chr(10),capture_output=True,text=True,encoding='utf-8',timeout=25);print(json.dumps({'exitCode':r.returncode,'result':json.loads(r.stdout)if r.stdout.strip()else None}))"
        proofs=[]
        for _ in range(2):
            cleanup=q.win(clean,timeout=30);proofs.append(cleanup);require(cleanup.get('exitCode')==0 and(cleanup.get('result')or{}).get('cleanupConfirmed')is True,'qa_cleanup_unknown');time.sleep(.2)
        save('cleanup-proofs.json',proofs);physical_safe=True
        stop.set()
        final=q.attest();require(all(final[k]==identity[k]for k in('agentPid','agentCreatedAt','adbPid','adbCreatedAt','files')),'qa_runtime_changed_after');save('identity-after.json',final)
        state=reader.state(session);assert_owned(core,state,marker=marker)
        full=transport(fullsource,{},timeout=30);require(full.get('status')=='observed_not_admitted','qa_global_after_unknown');save('global-after.json',full)
        released=q.request('/api/v1/screen-sessions/'+session,'DELETE',{});require(released['status']==200,'qa_release_unknown');journal('screen_released_still_unlisted',stage=stage)
        after=Reader(target).state();require(not any(after.get(k)for k in('locks','tasks','jobs','sessions'))and after['lookupExcluded'],'qa_release_not_clear')
        d=after['devices'][0];require(d.get('listingStatus')=='unlisted'and d.get('unlistedAt')==marker,'qa_marker_changed_before_restore')
        restored=listing(target,original['listingStatus']);save('listing-restored.json',restored)
        after=Reader(target).state();require(after['devices'][0].get('listingStatus')=='listed','qa_restore_unconfirmed');save('final-state.json',after)
        journal('complete_restored',stage=stage)
        print(json.dumps({'deviceNumber':number,'status':native.get('previewStatus'),'code':native.get('previewCode'),'invitationSent':False,'cleanupConfirmed':True,'listingRestored':True,'evidence':str(folder),'productionApiAccepted':False}),flush=True)
    except Exception as error:
        code=str(error)if isinstance(error,RuntimeError)and str(error).startswith('qa_')else 'qa_single_execution_unknown'
        if session and not unlist_attempted and not native_delivery_unknown:
            try:
                current=q.request('/api/v1/screen-sessions/'+session)
                value=current.get('body',{}).get('session',{})
                require(current['status']==200 and value.get('sessionId')==session and value.get('deviceId')==target['deviceId']
                        and created_owner and value.get('userId')==created_owner,'qa_unstarted_screen_owner_changed')
                closed=q.request('/api/v1/screen-sessions/'+session,'DELETE',{});require(closed['status']==200,'qa_unstarted_screen_close_unknown')
                journal('known_not_started_screen_closed',code=code)
                print(json.dumps({'deviceNumber':number,'code':code,'nativeStarted':False,'screenClosed':True,'listingChanged':False,'noRetry':True,'evidence':str(folder)}),flush=True)
                return
            except Exception:pass
        if marker is not None and not native_delivery_unknown:
            # Preparation made no native invocation. A fresh independent read
            # can prove this exact maintenance marker and owned screen still
            # exist; there is no reader/process to invent a cleanup proof for.
            try:
                stop.set()
                fresh=Reader(target).state(session);assert_owned(core,fresh,marker=marker)
                released=q.request('/api/v1/screen-sessions/'+session,'DELETE',{})
                require(released['status']==200,'qa_unstarted_release_unknown')
                fresh=Reader(target).state();device=fresh['devices'][0]
                require(not any(fresh.get(k)for k in('locks','tasks','jobs','sessions'))and fresh['lookupExcluded']
                        and device.get('listingStatus')=='unlisted'and device.get('unlistedAt')==marker,'qa_unstarted_restore_not_owned')
                save('listing-restored.json',listing(target,original['listingStatus']))
                journal('known_not_started_restored',code=code)
                print(json.dumps({'deviceNumber':number,'code':code,'nativeStarted':False,'listingRestored':True,'noRetry':True,'evidence':str(folder)}),flush=True)
                return
            except Exception:
                pass  # A failed ownership/ACK check retains the manual hold.
        journal('unknown_keep_unlisted',stage=stage,code=code,physicalCleanup=physical_safe)
        print(json.dumps({'deviceNumber':number,'code':code,'sessionId':session,'keepUnlisted':unlist_attempted,'noRetry':True,'evidence':str(folder)}),flush=True)
    finally:
        stop.set()
        if broker:broker.shutdown();broker.server_close()
        # A keeper may stop here; the persisted unlisted marker remains the
        # manual hold on every failure. Never restore in a generic finally.
        if keeper and keeper.poll()is None:keeper.terminate();keeper.wait(timeout=5)
        if forward is not None:
            try:
                cancelled=subprocess.run(q.WINDOWS[:-1]+['-O','cancel','-R',forward,q.WINDOWS[-1]],capture_output=True,timeout=5)
                save('tunnel-release.json',dict(exitCode=cancelled.returncode,ownedForward=forward))
            except Exception:save('tunnel-release.json',dict(status='unknown_no_retry'))


if __name__=='__main__':main()
