"""Resume only a recorded owned cleanup obligation; never runs a preview."""
import hashlib
import http.server
import json
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
import uuid
import wecom_qa_access as q
from wecom_candidate_live import cloud_state,validate_state,require


def main():
    folder=Path(sys.argv[1]);pending=json.loads((folder/'pending-obligation.json').read_text());receipt=json.loads((folder/'reservation-receipt.json').read_text());answer=json.loads((folder/'native-answer.json').read_text());taskreceipt=json.loads((folder/'task-receipt.json').read_text())
    require(pending['sessionId']==receipt['sessionId']and pending['stage'].startswith('D:/PhoneCloud/staging/wecom-qa-'),'qa_recovery_not_owned')
    require(not answer['pending']and answer['answer']['childExited']and answer['hostExitCode']==0,'qa_original_host_exit_unconfirmed')
    local=json.loads((folder/'data/state.json').read_text());task=next(t for t in local['windowsTasks']if t['taskId']==taskreceipt['taskId']);payload=task['payload'];resources=answer['answer']['resources'];hosts=[answer['node'],answer['native']]
    require(task['type']=='wecom_customer_preview'and payload['mode']=='preview'and payload['previewOnly']is True,'qa_cleanup_preview_only')
    identity=q.attest();target=dict(deviceId=task['deviceId'],serial=task['adbSerial'],deviceNumber=payload['deviceNumber']);session=receipt['sessionId'];state=cloud_state(target,session);require(len(state['locks'])==1,'qa_original_reservation_changed');device=state['devices'][0];lock=state['locks'][0]
    config=dict(taskId=task['taskId'],**target,androidUser=payload['androidUser'],appSlot=payload['appSlot'],remarkName=payload['remarkName'],description=payload['description'],phoneNumber=payload['phoneNumber'],mode='preview',previewOnly=True,agentId=task['agentId'],serverBaseUrl='http://127.0.0.1',agentToken='isolated-local-fixture-only')
    remark=hashlib.sha256(json.dumps([config['remarkName'],config['description']],ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    operation=hashlib.sha256(json.dumps(['preview',remark,config['phoneNumber'],config['deviceId'],config['androidUser']],separators=(',',':')).encode()).hexdigest()
    scope=hashlib.sha256(json.dumps([resources,hosts],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    proof_version=taskreceipt.get('proofVersion',1)
    binding=dict(proofVersion=proof_version,taskId=task['taskId'],**target,appSlot=config['appSlot'],androidUser=config['androidUser'],agentId=task['agentId'],physicalAgentId=device['adb']['agentId'],sessionId=session,lockId=lock['lockId'],ownerUserId=lock['ownerUserId'],operationFingerprint=operation,purpose='cleanup',authorityGeneration=uuid.uuid4().hex,scopeFingerprint=scope,inventoryPath=r'D:\PhoneCloud\agent\data\device-scan-cache.json',brokerToken=secrets.token_urlsafe(36),**{k:identity[k]for k in ('agentPid','agentExe','agentCreatedAt','adbPid','adbExe','adbCreatedAt')})
    validate_state(binding,state);stats=[]
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*a):pass
        def do_POST(self):
            started=time.monotonic()
            try:
                n=int(self.headers.get('Content-Length','0'));require(0<n<1024 and self.path=='/guard','qa_recovery_guard_only')
                r=json.loads(self.rfile.read(n));require(secrets.compare_digest(self.headers.get('Authorization',''),'Bearer '+binding['brokerToken'])and r.get('taskId')==task['taskId']and r.get('proofVersion',1)==proof_version and r.get('purpose')=='cleanup'and r.get('authorityGeneration')==binding['authorityGeneration'],'qa_recovery_binding_changed')
                require(isinstance(r.get('nonce'),str)and len(r['nonce'])==32,'qa_recovery_nonce_invalid')
                current=cloud_state(target,session);expiry=validate_state(binding,current)
                proof={k:binding[k]for k in ('taskId','deviceId','serial','deviceNumber','appSlot','androidUser','agentId','physicalAgentId','sessionId','lockId','ownerUserId','operationFingerprint','purpose','authorityGeneration','scopeFingerprint')}
                proof.update(version=proof_version,**({'ageReference':'request_received'}if proof_version==2 else{}),allowed=True,nonce=r['nonce'],brokerAgeSeconds=0 if proof_version==2 else time.monotonic()-started,expiresInSeconds=expiry,activeLockCount=1,sessionAlive=True,lookupExcluded=True);status=200
            except Exception:proof={'allowed':False};status=409
            stats.append(dict(status=status,proofSupplyMs=round((time.monotonic()-started)*1000)))
            self.send_response(status);self.end_headers();self.wfile.write(json.dumps(proof).encode())
    broker=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=broker.serve_forever,daemon=True).start()
    port=q.win("import socket,json\ns=socket.socket();s.bind(('127.0.0.1',0));print(json.dumps(s.getsockname()[1]));s.close()")
    forward=f'127.0.0.1:{port}:127.0.0.1:{broker.server_port}';r=subprocess.run(q.WINDOWS[:-1]+['-O','forward','-R',forward,q.WINDOWS[-1]],capture_output=True,timeout=5);require(r.returncode==0,'qa_recovery_tunnel_failed');binding['brokerUrl']='http://127.0.0.1:'+str(port)
    envelope=dict(task=config,reservation=binding,resources=resources,originalHosts=hosts)
    code="import subprocess,json\nr=subprocess.run(["+repr(q.PYTHON)+","+repr(pending['stage']+'/windows-agent/scripts/wecom_standalone_cleanup.py')+"],input="+repr(json.dumps(envelope))+"+'\\n',capture_output=True,text=True,encoding='utf-8',timeout=26);print(json.dumps({'exitCode':r.returncode,'result':json.loads(r.stdout)if r.stdout.strip()else None}))"
    try:
        result=q.win(code,timeout=32);saved=dict(result=result,stats=stats,sessionId=session,authorityGeneration=binding['authorityGeneration'],resourcesSha256=scope,purpose='cleanup',phoneActions='owned_reader_cleanup_only')
        name='recovery-cleanup-'+binding['authorityGeneration']+'.json';(folder/name).write_text(json.dumps(saved,indent=2))
        require(result.get('exitCode')==0 and(result.get('result')or{}).get('cleanupConfirmed')is True,'qa_recovery_cleanup_unconfirmed')
        # Adopt only this recorded session after verifying its exact live lock;
        # q.request otherwise refuses deleting sessions owned by another process.
        validate_state(binding,cloud_state(target,session));q.OWN_SESSIONS.add(session)
        released=q.request('/api/v1/screen-sessions/'+session,'DELETE',{});require(released['status']==200,'qa_recovery_release_unknown');after=cloud_state(target,session);require(not after['locks']and after['session']['status']in('closed','failed'),'qa_recovery_release_unconfirmed')
        final=q.attest();require(all(final[k]==identity[k]for k in ('agentPid','agentCreatedAt','adbPid','adbCreatedAt','files')),'qa_recovery_runtime_changed')
        record=dict(cleanupConfirmed=True,sessionReleased=True,sessionId=session,sourceRef=taskreceipt['sourceRef'],originalTaskStillFailed=True,productionUnchanged=True,stats=stats)
        (folder/'recovery-final-receipt.json').write_text(json.dumps(record,indent=2));print(json.dumps(record))
    finally:
        broker.shutdown();subprocess.run(q.WINDOWS[:-1]+['-O','cancel','-R',forward,q.WINDOWS[-1]],capture_output=True,timeout=5)

if __name__=='__main__':main()
