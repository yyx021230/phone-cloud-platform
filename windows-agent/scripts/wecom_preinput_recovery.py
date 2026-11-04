"""Read-only maintenance evidence, distinct from the missing original reader.

No UI SDK, ADB CLI/startup, kill, install, forward removal or identity changes.
The trusted operator binds the exact retired producer after an approved drain.
"""
import json
import os
import re
import socket
import sys
import threading
import time
from pathlib import PureWindowsPath
from wecom_cleanup import MAIN,TEST
from wecom_cleanup_contract import validate_binding,CausalLeaseBudget,CAUSAL_PROTOCOL
from wecom_control_pipe import read_line,start
from wecom_host_identity import machine_identity,creation_token
from wecom_physical_verify import HostRef,ReadOnlyAdb,VerifyStop,verify_empty,observe_exited_hosts
from wecom_system_runtime import SystemRuntimeGuard,process_identity,ADB_EXE,AGENT_ENTRY,path_key
from wecom_qa_tcp_runtime import WindowsTcpRuntime
from wecom_cleanup_verify import lease,proof_time

PROTOCOL='wecom-preinput-recovery-v1'
FIELDS={'taskId','deviceId','serial','agentId','serverBaseUrl','agentToken','physicalCleanup','preinputRecovery',
        'verificationId','verificationNonce','verificationTaskId','issuedAt','retiredProducer','causalLease','challenge'}

def producer(value):
    if (not isinstance(value,dict)or set(value)!={'pid','creationToken','machineId'}or type(value['pid'])is not int
        or not 0<value['pid']<=0xffffffff or not isinstance(value['creationToken'],str)
        or not re.fullmatch(r'0x1\.[0-9a-f]{13}p\+\d{1,4}',value['creationToken'])
        or not isinstance(value['machineId'],str)or not re.fullmatch(r'[a-f0-9]{64}',value['machineId'])):
        raise VerifyStop('wecom_cleanup_recovery_producer_invalid')
    return HostRef(value['pid'],float.fromhex(value['creationToken']))


def validate(value):
    if not isinstance(value,dict)or set(value)!=FIELDS or value['preinputRecovery']!=PROTOCOL:raise VerifyStop('wecom_cleanup_recovery_invalid')
    validate_binding(value['physicalCleanup'],value);producer(value['retiredProducer'])
    if value['taskId']!=value['verificationTaskId']or any(not isinstance(value[k],str)or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',value[k])for k in('verificationId','verificationNonce','verificationTaskId')):raise VerifyStop('wecom_cleanup_recovery_invalid')
    CausalLeaseBudget(value['causalLease'])
    c=value['challenge'];ticket=value['causalLease']
    if(ticket['purpose']!='verification'or not isinstance(c,dict)or set(c)!={'protocol','epoch','verificationLeaseId','challengeId'}or c['protocol']!=CAUSAL_PROTOCOL
        or c['epoch']!=ticket['epoch']or c['verificationLeaseId']!=ticket['leaseId']or not isinstance(c['challengeId'],str)or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',c['challengeId'])):raise VerifyStop('wecom_cleanup_causal_context_unconfirmed')
    import urllib.parse
    url=urllib.parse.urlsplit(value['serverBaseUrl'])
    if url.scheme not in('http','https')or not url.hostname or url.username or url.password or url.query or url.fragment:raise VerifyStop('wecom_cleanup_origin_invalid')
    if not isinstance(value['agentToken'],str)or not value['agentToken']or len(value['agentToken'])>16384:raise VerifyStop('wecom_cleanup_credential_missing')
    return value


def quiescent_processes(processes,*,self_pid,agent_pid,budget):
    """Unrecognized Python is unknown, not assumed absent. Lookup is allowed."""
    count=0;agents=[]
    allowed={r'd:/phonecloud/agent/scripts/alipay_name_lookup.py',r'd:/phonecloud/agent/scripts/lookup_ocr_worker.py'}
    for process in processes():
        budget();count+=1
        if count>4096:raise VerifyStop('wecom_cleanup_recovery_processes_unconfirmed')
        try:
            name=process.name().lower();pid=process.pid
            if name not in('python.exe','pythonw.exe','node.exe'):continue
            args=process.cmdline()
            if not isinstance(args,list)or not args:raise ValueError('unknown')
            if name=='node.exe':
                if any(path_key(a)==AGENT_ENTRY for a in args):agents.append(pid)
                continue
            if pid==self_pid:continue
            if len(args)<2 or path_key(args[1])not in allowed:raise VerifyStop('wecom_cleanup_recovery_worker_present')
        except VerifyStop:raise
        except Exception:raise VerifyStop('wecom_cleanup_recovery_processes_unconfirmed')from None
    if agents!=[agent_pid]:raise VerifyStop('wecom_cleanup_recovery_producer_unconfirmed')
    return True


class PeerSocket:
    """Attest the actual reverse TCP endpoint before every smart-socket send."""
    def __init__(self,wire,identity,runtime,budget):
        self.wire,self.identity,self.runtime,self.budget=wire,identity,runtime,budget
        self.endpoints=(tuple(wire.getsockname()),tuple(wire.getpeername()),wire.fileno())
        self.attest()
    def attest(self):
        self.budget();self.identity.check();self.budget()
        local,peer,fd=self.endpoints
        if local[0]!='127.0.0.1'or peer!=('127.0.0.1',5037)or fd<0 or self.endpoints!=(tuple(self.wire.getsockname()),tuple(self.wire.getpeername()),self.wire.fileno()):raise VerifyStop('wecom_cleanup_recovery_peer_unconfirmed')
        owners=[c.pid for c in self.runtime.net_connections(kind='tcp')if c.status=='ESTABLISHED'and tuple(c.laddr)==peer and tuple(c.raddr)==local]
        if owners!=[self.identity.adb.host.pid]or process_identity(self.runtime,owners[0],ADB_EXE)!=self.identity.adb:raise VerifyStop('wecom_cleanup_recovery_peer_unconfirmed')
        self.budget()
    def sendall(self,data):self.attest();return self.wire.sendall(data)
    def recv(self,size):self.budget();return self.wire.recv(size)
    def settimeout(self,value):return self.wire.settimeout(value)
    def close(self):return self.wire.close()


def execute(value,*,cancelled=lambda:False,clock=time.monotonic,wall=time.time,sleep=time.sleep,
            runtime=None,processes=None,process_created_at=None,machine=machine_identity,runtime_factory=SystemRuntimeGuard,
            adb_factory=ReadOnlyAdb,request=None,connect=socket.create_connection):
    config=validate(value);began=clock();old=producer(config['retiredProducer'])
    if runtime is None:runtime=WindowsTcpRuntime()
    if processes is None:
        import psutil
        processes=psutil.process_iter
    if process_created_at is None:
        import psutil
        def process_created_at(pid):
            try:return runtime.Process(pid).create_time()
            except psutil.NoSuchProcess as error:
                if type(error)is not psutil.NoSuchProcess:raise
                return None
    def budget():
        if cancelled():raise VerifyStop('wecom_cleanup_cancelled')
        if clock()-began>=3:raise VerifyStop('wecom_cleanup_verify_timeout')
    budget();identity=runtime_factory(runtime=runtime);machine_id=machine();budget()
    if machine_id!=config['retiredProducer']['machineId']:raise VerifyStop('wecom_cleanup_recovery_machine_mismatch')
    observer={'pid':identity.agent.host.pid,'creationToken':creation_token(identity.agent.host.created_at),'machineId':machine_id}
    if observer==config['retiredProducer']:raise VerifyStop('wecom_cleanup_recovery_producer_not_retired')
    def local():
        budget();identity.check();observe_exited_hosts([old],process_created_at)
        quiescent_processes(processes,self_pid=identity.current_pid,agent_pid=identity.agent_pid,budget=budget);budget();return True
    lease_budget=CausalLeaseBudget(config['causalLease'],clock=clock)
    # Reuse only the bounded authenticated GET transport, with the distinct
    # recovery route; no original host identities are supplied to that transport.
    def authority():
        local()
        def recovery_request(url,token):
            url=url.replace('/lease?','/recovery-lease?')
            if request is not None:return request(url,token)
            import urllib.request
            from wecom_cleanup_verify import NoRedirect
            req=urllib.request.Request(url,headers={'Authorization':'Bearer '+token})
            try:
                with urllib.request.build_opener(NoRedirect).open(req,timeout=2)as response:raw=response.read(2049)
                if len(raw)>2048:raise ValueError('bounded')
                return json.loads(raw)
            except Exception:raise VerifyStop('wecom_cleanup_lease_unconfirmed')from None
        if not lease(config,budget,request=recovery_request,lease_budget=lease_budget):raise VerifyStop('wecom_cleanup_lease_lost')
        local();return True
    def peer_connect(address,timeout):
        local()
        if address!=('127.0.0.1',5037):raise VerifyStop('wecom_cleanup_recovery_peer_unconfirmed')
        wire=connect(address,timeout=timeout)
        try:return PeerSocket(wire,identity,runtime,budget)
        except Exception:wire.close();raise
    authority()
    adb=adb_factory(config['serial'],lambda:(budget()or True),budget,connect=peer_connect,operation_guard=authority)
    frames=verify_empty(serial=config['serial'],hosts=[old],process_created_at=process_created_at,pids=adb.pids,forwards=adb.forwards,
                        guard=local,check_budget=budget,sleep=sleep,clock=clock,wall_clock=wall)
    authority();budget()
    return {'binding':config['physicalCleanup'],**{k:config[k]for k in('verificationId','verificationNonce','verificationTaskId','challenge','retiredProducer')},'observer':observer,
            'snapshots':[{'sequence':i+1,'elapsedMs':(f.captured_at-began)*1000,'observedAt':proof_time(f.observed_at),'packagesAbsent':True,
                          'packageNames':[MAIN,TEST],'serialForwardCount':0,'producerRetired':True,'wecomWorkersAbsent':True}for i,f in enumerate(frames)]}


def main():
    cancelled=threading.Event()
    try:
        value=json.loads(read_line(sys.stdin,32768));start(sys.stdin,cancelled)
        result={'ok':True,'proof':execute(value,cancelled=cancelled.is_set)}
    except VerifyStop as error:
        code=str(error)if re.fullmatch(r'[a-z0-9_]{1,100}',str(error))else 'wecom_cleanup_recovery_unconfirmed'
        result={'ok':False,'code':code}
    except Exception:result={'ok':False,'code':'wecom_cleanup_recovery_unconfirmed'}
    print(json.dumps(result),flush=True)

if __name__=='__main__':main()
