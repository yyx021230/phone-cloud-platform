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
ISOLATED_XHS_HASHES=('edb6d11bc1614f75eb33d2c4938f936851b9d3af0b064bfc0891f3417950cb99',
                     '2e86f85094cc6b4a53f564e6ea9fc6e56e7b00095dd6c6217c90ba08151df47b')
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


def bounded_file(path,limit):
    from pathlib import Path
    with Path(path).open('rb')as source:raw=source.read(limit+1)
    if len(raw)>limit:raise ValueError('bounded')
    return raw


def isolated_xhs_other_device(process,args,agent_pid,target_serial,budget):
    """Recognize only the audited, serial-pinned standalone QA runner.

    Unknown versions/modes still fence recovery. Never return or log its config,
    which contains broker credentials; no QA process or phone is changed.
    """
    import hashlib
    try:
        if not target_serial or len(args)!=20:return False
        script=path_key(args[1]);stage=PureWindowsPath(script).parent
        if not re.fullmatch(r'd:/phonecloud/staging/xhs-qa-live-[a-f0-9]{12}-\d{1,4}-app[12]-[a-f0-9]{8}/xhs_isolated_runner\.py',script):return False
        if path_key(process.exe())!='d:/phonecloud/tools/python39/python.exe'or process.username().split('\\')[-1].casefold()!='administrator':return False
        flags={'--serial','--adb','--device-name','--device-cache','--app-slot','--task-id','--cancel-file','--days','--output'}
        if set(args[2::2])!=flags or len(set(args[2::2]))!=9:return False
        values=dict(zip(args[2::2],args[3::2]));serial=values['--serial']
        if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}',serial)or serial.casefold()==target_serial.casefold():return False
        config_path=process.environ().get('XHS_QA_CONFIG','')
        if path_key(config_path)!=path_key(str(stage/'config.json')):return False
        budget();config=json.loads(bounded_file(config_path,65536))
        if not isinstance(config,dict)or any(config.get(k)!=values[v]for k,v in (
                ('serial','--serial'),('deviceName','--device-name'),('appSlot','--app-slot'),('jobId','--task-id'))):return False
        if(config.get('agentPid')!=agent_pid or path_key(config.get('stage',''))!=path_key(str(stage))
            or path_key(config.get('pythonPath',''))!='d:/phonecloud/tools/python39/python.exe'
            or path_key(config.get('adbPath',''))!=ADB_EXE or path_key(values['--adb'])!=ADB_EXE
            or path_key(config.get('inventoryPath',''))!='d:/phonecloud/agent/data/device-scan-cache.json'
            or path_key(values['--device-cache'])!=path_key(config['inventoryPath'])
            or not re.fullmatch(r'http://127\.0\.0\.1:\d{1,5}',config.get('brokerUrl',''))):return False
        cancel=PureWindowsPath(path_key(values['--cancel-file']));output=PureWindowsPath(path_key(values['--output']))
        cache=stage/'cache'/'xhs-data-collection'
        if(cancel.parent!=cache or output.parent!=cache or cancel.suffix!='.cancel'or output.suffix!='.json'
            or cancel.stem!=output.stem or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',cancel.stem)):return False
        if tuple(hashlib.sha256(bounded_file(p,131072)).hexdigest()for p in
                 (args[1],str(stage/'xhs_isolated_guard.py')))!=ISOLATED_XHS_HASHES:return False
        budget();return True
    except VerifyStop:raise
    except Exception:return False


def quiescent_processes(processes,*,self_pid,agent_pid,budget,target_serial=None):
    """Keep unknown Python fenced; identify existing other-phone Agent workers."""
    from psutil import NoSuchProcess
    count=0;agents=[];python={}
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
            elif pid!=self_pid:
                meta=None
                if len(args)>1 and(path_key(args[1])=='d:/phonecloud/agent/scripts/xhs_airtest_poco.py'or args[1]=='-I'):
                    meta={'exe':path_key(process.exe()),'owner':process.username(),'parent':process.ppid(),'created':process.create_time()}
                elif len(args)>1 and PureWindowsPath(str(args[1])).name=='xhs_isolated_runner.py':
                    meta={'isolatedOtherDevice':isolated_xhs_other_device(process,args,agent_pid,target_serial,budget)}
                python[pid]=(args,meta)
        except VerifyStop:raise
        except NoSuchProcess as error:
            if type(error)is not NoSuchProcess:raise VerifyStop('wecom_cleanup_recovery_processes_unconfirmed')from None
            continue
        except Exception:raise VerifyStop('wecom_cleanup_recovery_processes_unconfirmed')from None
    if agents!=[agent_pid]:raise VerifyStop('wecom_cleanup_recovery_producer_unconfirmed')
    def other_phone(pid,seen=()):
        budget()
        if not target_serial or pid in seen or len(seen)>=8 or pid not in python:return False
        args,meta=python[pid]
        try:
            if not meta:return False
            if meta.get('isolatedOtherDevice')is True:return True
            exe=meta['exe']
            if exe not in{'d:/phonecloud/tools/python39/python.exe','d:/phonecloud/agent/runtime/lookup-ocr/scripts/python.exe'}or meta['owner']!=r'NT AUTHORITY\SYSTEM':return False
            parent=meta['parent']
            if len(args)>1 and path_key(args[1])=='d:/phonecloud/agent/scripts/xhs_airtest_poco.py':
                if exe!='d:/phonecloud/tools/python39/python.exe'or parent!=agent_pid or any(args.count(k)!=1 for k in('--serial','--mode','--adb-path')):return False
                def value(key):return args[args.index(key)+1]
                serial=value('--serial')
                return value('--mode')=='worker'and path_key(value('--adb-path'))==ADB_EXE and bool(re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}',serial))and serial.casefold()!=target_serial.casefold()
            # Only the observed isolated OCR executable/script chain may inherit
            # the known worker's other-device scope; arbitrary -I code stays unknown.
            return len(args)==4 and args[1:3]==['-I','-u']and path_key(args[3])=='d:/phonecloud/agent/scripts/lookup_ocr_worker.py'and parent in python and python[parent][1]is not None and python[parent][1]['created']<=meta['created']and other_phone(parent,seen+(pid,))
        except VerifyStop:raise
        except Exception:return False
    for pid,(args,meta)in python.items():
        budget()
        if len(args)>1 and path_key(args[1])in allowed:continue
        if other_phone(pid):continue
        # A failed read-only maintenance check must identify its blocker without
        # copying argv/payloads, phone numbers or credentials into normal logs.
        if os.name=='nt':
            try:
                import tempfile
                from pathlib import Path
                directory=Path(tempfile.gettempdir())/'PhoneCloudWecomRecovery'
                directory.mkdir(exist_ok=True)
                if len(list(directory.glob('blocked-*.json')))<100:
                    report={'observerPid':self_pid,'blockerPid':pid,'targetScopeProvided':target_serial is not None,'script':PureWindowsPath(str(args[1])).name if len(args)>1 else'missing','metadata':meta}
                    path=directory/('blocked-'+str(self_pid)+'.json')
                    with path.open('x',encoding='utf-8')as output:json.dump(report,output)
            except Exception:pass
        raise VerifyStop('wecom_cleanup_recovery_worker_present')
    return True


class PeerSocket:
    """Attest the actual reverse TCP endpoint before every smart-socket send."""
    def __init__(self,wire,identity,runtime,budget,process_guard=None):
        self.wire,self.identity,self.runtime,self.budget=wire,identity,runtime,budget
        self.process_guard=process_guard
        self.endpoints=(tuple(wire.getsockname()),tuple(wire.getpeername()),wire.fileno())
        self.attest()
    def attest(self):
        self.budget()
        if self.process_guard is None:self.identity.check()
        elif self.process_guard()is not True:raise VerifyStop('wecom_cleanup_recovery_processes_unconfirmed')
        self.budget()
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
        quiescent_processes(processes,self_pid=identity.current_pid,agent_pid=identity.agent_pid,budget=budget,target_serial=config['serial']);budget();return True
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
        # Connecting sends no ADB bytes. Keep live identity/producer checks here;
        # PeerSocket rechecks the complete worker set after connect and again
        # before every send, avoiding one identical global scan per socket.
        budget();identity.check();observe_exited_hosts([old],process_created_at)
        if address!=('127.0.0.1',5037):raise VerifyStop('wecom_cleanup_recovery_peer_unconfirmed')
        wire=connect(address,timeout=timeout)
        try:return PeerSocket(wire,identity,runtime,budget,process_guard=local)
        except Exception:wire.close();raise
    # The first-frame authority is also the initial authority: no ADB socket
    # is opened before it. Avoid an identical extra HTTP round-trip here.
    # These commands only read facts. Revalidate server authority before each
    # complete frame and after both; every socket operation still rechecks the
    # current SYSTEM identity, target workers, peer owner and the 3s deadline.
    # PeerSocket owns that single combined send boundary; do not duplicate the
    # same full scan in ReadOnlyAdb.operation_guard before PeerSocket scans again.
    adb=adb_factory(config['serial'],lambda:(budget()or True),budget,connect=peer_connect)
    def frame_pids(package):
        if package==MAIN:authority()
        return adb.pids(package)
    # Every real socket open/send performs local(); frame boundaries also
    # perform authority(). The generic read loop only needs its budget guard.
    frames=verify_empty(serial=config['serial'],hosts=[old],process_created_at=process_created_at,pids=frame_pids,forwards=adb.forwards,
                        guard=lambda:(budget()or True),check_budget=budget,sleep=sleep,clock=clock,wall_clock=wall)
    authority();budget()
    return {'binding':config['physicalCleanup'],**{k:config[k]for k in('verificationId','verificationNonce','verificationTaskId','challenge','retiredProducer')},'observer':observer,
            'snapshots':[{'sequence':i+1,'elapsedMs':(f.captured_at-began)*1000,'observedAt':proof_time(f.observed_at),'packagesAbsent':True,
                          'packageNames':[MAIN,TEST],'serialForwardCount':0,'producerRetired':True,'wecomWorkersAbsent':True}for i,f in enumerate(frames)]}


def main():
    cancelled=threading.Event();started=time.perf_counter();task_id=None
    try:
        value=json.loads(read_line(sys.stdin,32768));task_id=value.get('taskId')if isinstance(value,dict)else None;start(sys.stdin,cancelled)
        result={'ok':True,'proof':execute(value,cancelled=cancelled.is_set)}
    except VerifyStop as error:
        code=str(error)if re.fullmatch(r'[a-z0-9_]{1,100}',str(error))else 'wecom_cleanup_recovery_unconfirmed'
        result={'ok':False,'code':code}
    except Exception:result={'ok':False,'code':'wecom_cleanup_recovery_unconfirmed'}
    if os.name=='nt':
        try:
            import tempfile
            from pathlib import Path
            directory=Path(tempfile.gettempdir())/'PhoneCloudWecomRecovery'
            directory.mkdir(exist_ok=True)
            if isinstance(task_id,str)and re.fullmatch(r'[A-Za-z0-9_-]{1,160}',task_id)and len(list(directory.glob('result-*.json')))<100:
                diagnostic={'taskId':task_id,'ok':result['ok'],'code':result.get('code'),'elapsedMs':round((time.perf_counter()-started)*1000,2),'snapshotElapsedMs':[r['elapsedMs']for r in result.get('proof',{}).get('snapshots',[])]}
                with (directory/('result-'+task_id+'.json')).open('x',encoding='utf-8')as output:json.dump(diagnostic,output)
        except Exception:pass
    print(json.dumps(result),flush=True)

if __name__=='__main__':main()
