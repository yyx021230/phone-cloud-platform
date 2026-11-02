"""Full local API/actual Node wrapper/native guard/status persistence; zero phone."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid
from wecom_candidate_source import candidate_files,write_stage,ROOT


def main():
    folder=Path(tempfile.mkdtemp(prefix='pc-wecom-e2e-'));os.chmod(folder,0o700)
    api=subprocess.Popen(['node',str(ROOT/'scripts/qa/wecom_candidate_api.mjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(folder/'api-stderr.log').open('w'),text=True)
    def ask(q):
        api.stdin.write(json.dumps(q)+'\n');api.stdin.flush();v=json.loads(api.stdout.readline())
        if 'error'in v:raise RuntimeError(v['error'])
        return v.get('result',v)
    ready=ask(dict(folder=str(folder),deviceNumber='23',serial='LBF6ON55EAIFYLMJ'));assert ready['ready']
    result=None
    try:
        created=ask(dict(op='create',phoneNumber='19900000001',requestId='qa-smoke-'+uuid.uuid4().hex,appSlot='main'));job=created['task']['jobId']
        task=ask(dict(op='next'))['task'];assert task['payload']['automationJobId']==job
        lease=ask(dict(op='lease',taskId=task['taskId']));assert lease['valid']
        # Native identity validation fails on this Mac before any ADB access.
        stage=folder/'staging'/('wecom-qa-local-'+uuid.uuid4().hex);write_stage(stage,candidate_files())
        import http.server,threading
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*a):pass
            def do_POST(self):
                v=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert self.path=='/report' and v['taskId']==task['taskId']
                value=ask(dict(op='report',taskId=task['taskId'],kind=v['kind'],body=v['body']))
                self.send_response(200);self.end_headers();self.wfile.write(json.dumps(value).encode())
        broker=http.server.HTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=broker.serve_forever,daemon=True).start()
        reservation=dict(taskId=task['taskId'],deviceId=task['deviceId'],serial=task['adbSerial'],deviceNumber='23',appSlot='main',androidUser=0,
            agentId=ready['agentId'],physicalAgentId='fixture-only',sessionId='fixture-only',lockId='fixture-only',ownerUserId='fixture-only',operationFingerprint='a'*64,
            purpose='preview',authorityGeneration=uuid.uuid4().hex,scopeFingerprint='a'*64,inventoryPath=r'D:\PhoneCloud\agent\data\device-scan-cache.json',
            brokerUrl='http://127.0.0.1:'+str(broker.server_port),brokerToken='t'*48)
        proc=subprocess.run(['node',str(stage/'scripts/qa/wecom_candidate_host.mjs')],input=json.dumps(dict(task=task,config=dict(pythonCommand=sys.executable,agentId=ready['agentId'],serverBaseUrl='http://127.0.0.1',agentToken='local-fixture-only'),reservation=reservation))+'\n',capture_output=True,text=True,timeout=20)
        (folder/'host-stderr.log').write_text(proc.stderr)
        assert proc.returncode==0,proc.stderr[-1000:]
        native=json.loads(proc.stdout);assert native['childExited']and native['firstJsonAtMs']is not None and native['childCloseAtMs']>=native['firstJsonAtMs']
        result=ask(dict(op='result',jobId=job))['task']
        assert result['result']['code'] in ('adb_listener_unconfirmed','qa_executor_error_no_replay'),result
        rows=[json.loads(line)for line in (stage/'qa-events.jsonl').read_text().splitlines()]
        assert not any(row.get('detail',{}).get('call') in ('adb.connect','adb.socket_connect','rpc.send')for row in rows)
        assert result['result']['invitationSent']is False
        assert result['result']['execution']['failurePhase']=='adb_identity',result
        print(json.dumps(dict(localApi=True,actualAgentFunctions=True,actualNativeIdentityGuard=True,originalJobId=job,code=result['result']['code'],childExited=native['childExited'],firstJsonAtMs=native['firstJsonAtMs'],childCloseAtMs=native['childCloseAtMs'],phoneActions=0,productionActions=0,evidence=str(folder))))
        broker.shutdown()
    finally:
        ask(dict(op='close'));api.wait(timeout=10)

if __name__=='__main__':main()
