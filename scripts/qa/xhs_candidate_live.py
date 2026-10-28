"""Explicitly invoked isolated QA; requires a private access module and real-device authorization.

Only creates target screen sessions via the formal API, writes its own staging
directory, and runs candidate modules there. No shared Agent/files/cache changes.
"""
import base64
import concurrent.futures
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import queue
import shlex
import subprocess
import sys
import threading
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]


def staging_source(stage, blobs):
    # ASCII source over Windows SSH stdin; decoded file names/content stay UTF-8.
    return ('from pathlib import Path\nimport base64,json\np=Path('+ascii(stage)+');p.mkdir()\n'
            'for name,value in '+ascii(blobs)+'.items():\n'
            ' f=p/name;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(base64.b64decode(value))\n'
            'print(json.dumps({"staged":True}))')


def settings_recovery_source(c):
    return '''from pathlib import Path
import json,subprocess,os
if not __debug__:raise RuntimeError('qa_optimized_python_is_forbidden')
c=__QA_CONFIG_LITERAL__
p=Path(c['stage']);folder=p/'cache/xhs-data-collection'
env=dict(os.environ,XHS_QA_CONFIG=str(p/'config.json'),PYTHONIOENCODING='utf-8')
def adb(args):
 r=subprocess.run([c['pythonPath'],str(p/'xhs_isolated_runner.py'),'--qa-adb']+args,capture_output=True,timeout=15,env=env)
 if r.returncode:raise RuntimeError('guarded_settings_recovery_failed')
 return r.stdout.decode('utf-8').strip()
recovered=0
for ledger in folder.glob('*.settings.json'):
 data=json.loads(ledger.read_text());assert data['serial']==c['serial'] and data['taskId']==c['windowsTaskId']
 for item in data['settings']:
  scope,key,value=item['scope'],item['key'],item['original']
  assert (scope,key) in [('system','screen_off_timeout'),('global','enable_screen_on_proximity_sensor')]
  if not value.isdigit():continue
  if adb(['shell','settings','get',scope,key])!=value:
   adb(['shell','settings','put',scope,key,value]);assert adb(['shell','settings','get',scope,key])==value
 ledger.unlink();recovered+=1
print(json.dumps({'recovered':recovered,'pending':len(list(folder.glob('*.settings.json')))}))
'''.replace('__QA_CONFIG_LITERAL__',ascii(c),1)


def main():
    if not __debug__ or os.environ.get('PYTHONOPTIMIZE'):
        raise RuntimeError('qa_optimized_python_is_forbidden')
    names=sys.argv[1:]
    assert 1<=len(names)<=2 and len(set(names))==len(names) and not set(names)&{'18','152','155','185'}
    spec=importlib.util.spec_from_file_location('access',os.environ['XHS_QA_ACCESS_FILE'])
    access=importlib.util.module_from_spec(spec);spec.loader.exec_module(access);q=access.q
    phase='live-'+uuid.uuid4().hex[:12]
    folder=access.R/phase;folder.mkdir(mode=0o700)
    def save(name,value):
        p=folder/name;p.write_text(json.dumps(value,ensure_ascii=False,indent=2));p.chmod(0o600)
    identity=q.attest();save('identity-before.json',identity)
    inventory=q.request('/api/v1/devices')['body']['devices']
    approved=json.loads(Path(os.environ['XHS_QA_TARGETS_FILE']).read_text())['targets']
    targets=[]
    for name in names:
        t=next(t for t in approved if t['deviceName']==name and t['appSlot']=='app1')
        d=next(d for d in inventory if d['deviceId']==t['deviceId'])
        assert d['adb']['state']=='device' and not d.get('occupancy')
        a=next(a for a in d['xhsAccounts'] if a['appSlot']==t['appSlot'])
        assert a['xhsId']==t['xhsId'] and a['accountName']==t['accountName'] and a['enabled']
        targets.append(dict(t,serial=d['adb']['serial'],model=d.get('model','QA')))
    save('targets-private.json',targets)
    database='xhs_batch_test_'+phase.replace('-','_')
    subprocess.run(['/opt/homebrew/opt/postgresql@16/bin/createdb','-h','127.0.0.1','-p','57503','-U','xhs_test',database],check=True,capture_output=True)
    save('local-private.json',{'targets':targets,'databaseUrl':'postgresql://xhs_test@127.0.0.1:57503/'+database})
    api=subprocess.Popen(['node',str(ROOT/'scripts/qa/xhs_candidate_api.mjs'),str(folder/'local-private.json')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(folder/'api-stderr.log').open('w'),text=True)
    def api_call(value):
        api.stdin.write(json.dumps(value)+'\n');api.stdin.flush()
        row=json.loads(api.stdout.readline());assert 'error' not in row,row
        return row.get('result',row)
    assert json.loads(api.stdout.readline())['ready']
    configs={};keepers={};proof_count=0;proof_failures=[];proof_cache={};proof_stop=threading.Event();snapshot_count=0
    cloud_api=q.qa.API.replace('15000','2000')
    def cloud_state(t,session=None):
        code=cloud_api+'''const t=TARGET;
const values=await Promise.all([api('/api/v1/devices'),api('/api/v1/device-locks'),api('/api/v1/admin/lookup-pool')SESSION]);
if(values.some(x=>x.status!==200))throw Error('state_read_failed');
const devices=values[0].body.devices.filter(x=>x.deviceId===t.deviceId&&x.adb?.serial===t.serial);
const locks=values[1].body.locks.filter(x=>x.deviceId===t.deviceId&&x.status==='active');
const session=values[3]?.body.session||null;
console.log(JSON.stringify({devices,locks,lockExpiryValid:locks.every(x=>Date.parse(x.expiresAt)>Date.now()),sessionExpiryValid:!!session&&Date.parse(session.expiresAt)>Date.now(),lookupReserved:values[2].body.pool.channels.some(x=>x.deviceId===t.deviceId),session}));'''
        code=code.replace('TARGET',json.dumps(t)).replace('SESSION',",api('/api/v1/screen-sessions/"+session+"')" if session else '')
        return q.cloud(code,timeout=5)
    def validate_cloud(c,s):
        assert len(s['devices'])==1 and not s['lookupReserved'],'qa_target_changed_or_lookup_reserved'
        d=s['devices'][0];assert d['adb']['state']=='device','qa_device_offline'
        assert len(s['locks'])==1 and s['lockExpiryValid'] and s['sessionExpiryValid'],'qa_not_unique_live_lock'
        lock=s['locks'][0];session=s['session']
        assert lock['lockId']==c['lockId'] and lock['taskId']==c['sessionId'] and lock['ownerUserId']==c['ownerUserId'] and lock['lockType']=='screen_control','qa_lock_changed'
        assert session and session['sessionId']==c['sessionId'] and session['deviceId']==c['deviceId'] and session['status'] in ('ready','streaming'),'qa_session_not_alive'
        assert (d.get('occupancy') or {}).get('sessionId')==c['sessionId'],'qa_device_occupancy_changed'
        a=next(a for a in d['xhsAccounts'] if a['appSlot']==c['appSlot'])
        assert a['xhsId']==c['xhsId'] and a['accountName']==c['accountName'] and a['enabled'],'qa_account_changed'
        return {**{k:c[k] for k in ('deviceId','serial','deviceName','appSlot','xhsId','accountName','jobId','sessionId','lockId','ownerUserId')},'allowed':True,'activeLockCount':1,'sessionAlive':True,'lookupReserved':False}
    def prove(c):
        return validate_cloud(c,cloud_state(c,c['sessionId']))
    def refresh_proofs():
        nonlocal snapshot_count
        while not proof_stop.is_set():
            current=list(configs.values())
            if current:
                started=time.monotonic()
                try:
                    code=cloud_api+'''const targets=TARGETS;
const values=await Promise.all([api('/api/v1/devices'),api('/api/v1/device-locks'),api('/api/v1/admin/lookup-pool'),...targets.map(t=>api('/api/v1/screen-sessions/'+t.sessionId))]);
if(values.slice(0,3).some(x=>x.status!==200))throw Error('state_read_failed');
console.log(JSON.stringify(targets.map((t,i)=>{const locks=values[1].body.locks.filter(x=>x.deviceId===t.deviceId&&x.status==='active');const session=values[3+i].body.session||null;return {devices:values[0].body.devices.filter(d=>d.deviceId===t.deviceId&&d.adb?.serial===t.serial),locks,session,lookupReserved:values[2].body.pool.channels.some(x=>x.deviceId===t.deviceId),lockExpiryValid:locks.every(x=>Date.parse(x.expiresAt)>Date.now()),sessionExpiryValid:!!session&&Date.parse(session.expiresAt)>Date.now()};})));'''.replace('TARGETS',json.dumps([{k:c[k] for k in ('deviceId','serial','sessionId')} for c in current]))
                    states=q.cloud(code,timeout=4);snapshot_count+=1
                    for c,s in zip(current,states):
                        try:proof_cache[c['jobId']]={'at':started,'proof':validate_cloud(c,s)}
                        except (AssertionError,KeyError,StopIteration) as e:proof_cache[c['jobId']]={'denied':str(e) or 'identity_changed'}
                except Exception as e:
                    proof_failures.append(type(e).__name__+':'+str(e)[:100])
                if snapshot_count%20==0:save('proof-stats.json',{'snapshots':snapshot_count,'guardRequests':proof_count,'transientReadFailures':len(proof_failures)})
            proof_stop.wait(.75)
    proof_thread=threading.Thread(target=refresh_proofs,daemon=True);proof_thread.start()
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_POST(self):
            nonlocal proof_count
            try:
                assert self.path=='/guard' and int(self.headers.get('Content-Length','0'))<=256
                req=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                c=configs[req['jobId']];assert self.headers.get('Authorization')=='Bearer '+c['brokerToken']
                assert isinstance(req.get('nonce'),str) and len(req['nonce'])==32
                proof_count+=1;cached=proof_cache.get(c['jobId'])
                if cached and 'denied' in cached:raise RuntimeError('qa_lease_lost:'+cached['denied'])
                if not cached or time.monotonic()-cached['at']>2.5:
                    result={'allowed':False};status=503
                else:
                    result=dict(cached['proof'],brokerProofAgeSeconds=time.monotonic()-cached['at'],nonce=req['nonce']);status=200
            except Exception as e:
                proof_failures.append(type(e).__name__+':'+str(e)[:200]);result={'allowed':False};status=409
            self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(result).encode())
    broker=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=broker.serve_forever,daemon=True).start()
    remote_port=q.win("import socket,json\ns=socket.socket();s.bind(('127.0.0.1',0));print(json.dumps(s.getsockname()[1]));s.close()")
    forward=f'127.0.0.1:{remote_port}:127.0.0.1:{broker.server_port}'
    save('forward.json',{'spec':forward,'remotePort':remote_port,'localPort':broker.server_port})
    tunnel_command=q.qa.WINDOWS[:-1]+['-O','forward','-R',forward,q.qa.WINDOWS[-1]]
    tunnel=subprocess.run(tunnel_command,capture_output=True,timeout=10)
    (folder/'tunnel.log').write_bytes(tunnel.stderr)
    leases=[];run_id=None;results=[]
    def stage_and_run(t,task):
        c=dict(t,jobId=task['payload']['automationJobId'],windowsTaskId=task['taskId'])
        initial=cloud_state(t);assert not initial['locks'] and not initial['lookupReserved'] and not initial['devices'][0].get('occupancy'),'qa_target_became_busy'
        created=q.request('/api/v1/user/devices/'+t['deviceId']+'/screen-sessions','POST',{})
        assert created['status']==201,created.get('body',{}).get('error')
        session=created['body']['session'];session_id=session['sessionId'];leases.append(session_id)
        # Uses the existing WS connection solely to keep this formal lease alive.
        keeper_code="import {WebSocket} from 'ws';const w=new WebSocket('ws://127.0.0.1:8787/realtime/v1/sessions/'+"+json.dumps(session_id)+"+'/control?token='+encodeURIComponent("+json.dumps(created['body']['browserToken'])+"));w.on('open',()=>console.log('ready'));w.on('error',()=>process.exit(1));w.on('close',()=>process.exit(0));setTimeout(()=>{w.close();process.exit(0)},25*60*1000);"
        p=subprocess.Popen(q.qa.CLOUD+['docker exec -i phone-cloud-platform node --input-type=module'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(folder/('keeper-'+t['deviceName']+'.log')).open('w'),text=True)
        p.stdin.write(keeper_code);p.stdin.close();keepers[session_id]=p
        ready=queue.Queue();threading.Thread(target=lambda:ready.put(p.stdout.readline()),daemon=True).start();assert ready.get(timeout=10).strip()=='ready'
        for _ in range(20):
            s=cloud_state(t,session_id)
            assert not s['lookupReserved'] and len(s['locks'])==1 and s['locks'][0]['taskId']==session_id,'qa_shared_lock_refused'
            if s['session']['status'] in ('ready','streaming'):break
            time.sleep(.5)
        lock=s['locks'][0];c.update(sessionId=session_id,lockId=lock['lockId'],ownerUserId=lock['ownerUserId'])
        stage='D:/PhoneCloud/staging/xhs-qa-'+phase+'-'+t['deviceName']
        c.update(stage=stage,adbPath=identity['adbExe'],adbPid=identity['adbPid'],agentPid=identity['agentPid'],agentCreatedAt=identity['agentCreatedAt'],
                 inventoryPath='D:/PhoneCloud/agent/data/device-scan-cache.json',pythonPath='D:/PhoneCloud/tools/python39/python.exe',
                 brokerUrl=f'http://127.0.0.1:{remote_port}',brokerToken=uuid.uuid4().hex+uuid.uuid4().hex)
        files={'xhs_isolated_guard.py':ROOT/'scripts/qa/xhs_isolated_guard.py','xhs_isolated_runner.py':ROOT/'scripts/qa/xhs_isolated_runner.py',
               'host.mjs':ROOT/'scripts/qa/xhs_candidate_host.mjs','xhs-data-collection.mjs':ROOT/'windows-agent/src/xhs-data-collection.mjs',
               'scripts/小红书数据同步.py':ROOT/'windows-agent/scripts/小红书数据同步.py','scripts/xhs_native_window.py':ROOT/'windows-agent/scripts/xhs_native_window.py',
               'scripts/native/xhs-native-window.jar':ROOT/'windows-agent/scripts/native/xhs-native-window.jar'}
        c.update(collectorPath=stage+'/scripts/小红书数据同步.py',collectorSha256=hashlib.sha256(files['scripts/小红书数据同步.py'].read_bytes()).hexdigest(),
                 nativeHelperSha256=hashlib.sha256(files['scripts/xhs_native_window.py'].read_bytes()).hexdigest(),nativeAsset=stage+'/scripts/native/xhs-native-window.jar',
                 nativeAssetSha256=hashlib.sha256(files['scripts/native/xhs-native-window.jar'].read_bytes()).hexdigest())
        configs[c['jobId']]=c;save('config-'+t['deviceName']+'-private.json',c)
        blobs={name:base64.b64encode(p.read_bytes()).decode() for name,p in files.items()}
        blobs['config.json']=base64.b64encode(json.dumps(c).encode()).decode();blobs['task.json']=base64.b64encode(json.dumps(task).encode()).decode()
        q.win(staging_source(stage,blobs),timeout=20)
        # Wait for the real Agent inventory to show our screen session; never synthesize it.
        for _ in range(70):
            state=q.win("from pathlib import Path\nimport json,time\np=Path("+repr(c['inventoryPath'])+");j=json.loads(p.read_text(encoding='utf-8-sig'));ds=j if isinstance(j,list) else j['devices'];d=next(d for d in ds if d['deviceId']=="+repr(c['deviceId'])+");print(json.dumps({'age':time.time()-p.stat().st_mtime,'occupancy':d.get('occupancy')}))")
            if state['age']<90 and (state['occupancy'] or {}).get('sessionId')==session_id:break
            prove(c);time.sleep(1)
        else:raise RuntimeError('real_inventory_never_showed_own_lease')
        prove(c);assert q.attest()==identity,'SYSTEM identity changed'
        # Find the existing Agent Node executable read-only, avoiding a new runtime.
        node=q.win('import psutil,json\nprint(json.dumps(psutil.Process('+str(identity['agentPid'])+').exe()))')
        command=subprocess.list2cmdline([node,stage+'\\host.mjs',stage+'\\config.json',stage+'\\task.json'])
        start=time.time();raw=q.qa.execute(q.qa.WINDOWS+[command],'',timeout=1250);answer=json.loads(raw)
        pending=q.win('from pathlib import Path\nimport json\np=Path('+repr(stage)+');print(json.dumps({"ledgers":len(list((p/"cache/xhs-data-collection").glob("*.settings.json")))}))')
        save('result-'+t['deviceName']+'-private.json',answer)
        return {'target':t,'task':task,'answer':answer,'pendingLedgers':pending['ledgers'],'elapsedSeconds':time.time()-start,'sessionId':session_id}
    try:
        assert tunnel.returncode==0,'reverse tunnel failed'
        run_id=api_call({'op':'create','requestId':phase})['batch']['runId']
        tasks=[]
        deadline=time.time()+40
        while len(tasks)<len(targets) and time.time()<deadline:
            picked=api_call({'op':'next'}).get('task')
            if picked:
                assert picked['type']=='xhs_data_collect','unexpected local task';tasks.append(picked)
            else:time.sleep(1)
        assert len(tasks)==len(targets),'local batch did not dispatch'
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(targets)) as pool:
            futures=[pool.submit(stage_and_run,next(t for t in targets if t['serial']==task['adbSerial']),task) for task in tasks]
            for f in futures:
                result=f.result();results.append(result);a=result['answer']
                payload={'status':'succeeded','result':a['result']} if a['ok'] and not result['pendingLedgers'] else {'status':'failed','error':a.get('error','settings_recovery_pending'),'result':{'message':a.get('error','settings_recovery_pending')}}
                api_call({'op':'complete','taskId':result['task']['taskId'],'payload':payload})
        for _ in range(30):
            data=api_call({'op':'result','runId':run_id})
            if data['complete']:break
            time.sleep(1)
        pages=[api_call({'op':'result','runId':run_id,'offset':i}) for i in range(len(targets))]
        for r,page in zip(results,pages):
            # Match identity independently of completion/order; raw notes are
            # compared with the existing API's documented field normalization.
            matching=[p['items'][0] for p in pages if p.get('items') and p['items'][0]['xhsId']==r['target']['xhsId']]
            assert len(matching)==1,'api_account_identity_missing'
            item=matching[0];assert item['accountName']==r['target']['accountName']
            if r['answer']['ok']:
                raw=r['answer']['result']['collection'];actual=item['data']
                assert item['status']=='succeeded' and actual['complete'] and raw['complete'],'api_collection_not_complete'
                assert len(raw['notes'])==len(actual['notes']),'api_note_count_changed'
                for src,dst in zip(raw['notes'],actual['notes']):
                    assert dst['title']==src['title'][:180]
                    for key in ('published_date','list_view_count','list_like_count','list_comment_count'):assert dst[key]==src[key],'api_note_field_changed'
            else:assert item['status']!='succeeded','failed_candidate_was_reported_success'
        save('api-pages-private.json',pages);api_call({'op':'restart'})
        restored=[api_call({'op':'result','runId':run_id,'offset':i}) for i in range(len(targets))]
        assert [p['items'] for p in pages]==[p['items'] for p in restored],'persisted results changed on restart'
        save('api-after-restart-private.json',restored)
    finally:
        # Retry only this candidate's exact settings ledger while the same lease
        # is still proven. A changed owner blocks the guarded commands below.
        for c in configs.values():
            try:
                prove(c)
                recovery=q.win(settings_recovery_source(c),timeout=80)
                save('settings-final-'+c['deviceName']+'.json',recovery)
            except Exception as e:
                save('settings-final-'+c['deviceName']+'.json',{'recoveryUnproven':True,'error':str(e)[:300]})
        # Close only leases created here. No broad release, process or ADB command.
        for session_id in leases:
            try:q.request('/api/v1/screen-sessions/'+session_id,'DELETE',{})
            except Exception as e:save('release-error-'+session_id+'.json',{'error':str(e)})
        if run_id:
            try:api_call({'op':'stop','runId':run_id})
            except Exception:pass
        try:api_call({'op':'close'})
        except Exception:pass
        api.stdin.close()
        try:api.wait(timeout=30)
        except subprocess.TimeoutExpired:api.terminate();api.wait(timeout=10)
        proof_stop.set();proof_thread.join(timeout=5);broker.shutdown()
        cancelled=subprocess.run(q.qa.WINDOWS[:-1]+['-O','cancel','-R',forward,q.qa.WINDOWS[-1]],capture_output=True,timeout=10)
        forwarding=q.win('import psutil,json\nprint(json.dumps({"remainingListeners":sum(1 for c in psutil.net_connections(kind="tcp") if c.status=="LISTEN" and c.laddr.port=='+str(remote_port)+')}))')
        save('forward-cleanup.json',{'returncode':cancelled.returncode,'stderr':cancelled.stderr.decode(errors='replace'),**forwarding})
        for p in keepers.values():
            try:p.wait(timeout=10)
            except subprocess.TimeoutExpired:p.terminate()
        save('identity-after.json',q.attest())
        summary={'phase':phase,'results':[{'name':r['target']['deviceName'],'model':r['target']['model'],'ok':r['answer']['ok'],'notes':len(r['answer'].get('result',{}).get('collection',{}).get('notes',[])),
                  'complete':r['answer'].get('result',{}).get('collection',{}).get('complete'), 'pendingLedgers':r['pendingLedgers'],'settingsRestored':r['answer'].get('settingsRestored',False),'elapsedSeconds':r['elapsedSeconds'],'error':r['answer'].get('error')} for r in results],
                 'proofs':proof_count,'cloudSnapshots':snapshot_count,'proofFailures':proof_failures,'productionSharedFilesChanged':False}
        save('summary.json',summary);print(json.dumps(summary,ensure_ascii=False),flush=True)


if __name__=='__main__': main()
