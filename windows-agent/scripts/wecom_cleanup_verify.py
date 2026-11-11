"""Dedicated read-only v1 task. The parent sends proof only AFTER OS close."""
import datetime
import json
import math
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from wecom_cleanup import MAIN,TEST
from wecom_cleanup_contract import validate_binding,CausalLeaseBudget,CAUSAL_PROTOCOL
from wecom_control_pipe import read_line,start
from wecom_host_identity import original_hosts_closed,utc_iso
from wecom_physical_verify import HostRef,ReadOnlyAdb,VerifyStop,verify_empty
from wecom_system_runtime import SystemRuntimeGuard

FIELDS={'taskId','deviceId','serial','agentId','serverBaseUrl','agentToken','physicalCleanup','verificationId','verificationNonce','verificationTaskId','issuedAt','expiresAt','pickedAt','hosts','causalLease','challenge'}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def timestamp(value):
    if not isinstance(value,str)or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z',value):raise VerifyStop('wecom_cleanup_time_invalid')
    try:return datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
    except Exception:raise VerifyStop('wecom_cleanup_time_invalid')from None

def proof_time(value):
    # One millisecond conservative margin avoids timestamp rounding toward a
    # newer instant. The source is the first-fact wall/monotonic origin.
    return utc_iso((math.floor(value*1000)-1)/1000)

def validate_config(value):
    if not isinstance(value,dict)or set(value)!=FIELDS:raise VerifyStop('wecom_cleanup_config_invalid')
    binding=validate_binding(value['physicalCleanup'],value)
    if value['taskId']!=value['verificationTaskId']or any(not isinstance(value[k],str)or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',value[k])for k in ('taskId','verificationId','verificationNonce','verificationTaskId')):
        raise VerifyStop('wecom_cleanup_binding_mismatch')
    for k in ('issuedAt','expiresAt','pickedAt'):timestamp(value[k])  # audit only
    ticket=value['causalLease'];CausalLeaseBudget(ticket)
    challenge=value['challenge']
    if ticket['purpose']!='verification'or not isinstance(challenge,dict)or set(challenge)!={'protocol','epoch','verificationLeaseId','challengeId'}or challenge['protocol']!=CAUSAL_PROTOCOL or challenge['epoch']!=ticket['epoch']or challenge['verificationLeaseId']!=ticket['leaseId']or not isinstance(challenge['challengeId'],str)or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',challenge['challengeId']):raise VerifyStop('wecom_cleanup_causal_context_unconfirmed')
    url=urllib.parse.urlsplit(value['serverBaseUrl'])
    if url.scheme not in('http','https')or not url.hostname or url.username or url.password or url.query or url.fragment:raise VerifyStop('wecom_cleanup_origin_invalid')
    if not isinstance(value['agentToken'],str)or not value['agentToken']or len(value['agentToken'])>16384:raise VerifyStop('wecom_cleanup_credential_missing')
    if not isinstance(value['hosts'],list)or not 1<=len(value['hosts'])<=8:raise VerifyStop('wecom_original_host_unconfirmed')
    return dict(value,physicalCleanup=binding)

def lease(config,check_budget,*,request=None,lease_budget=None):
    binding=config['physicalCleanup']
    query=urllib.parse.urlencode({k:config[k]for k in ('verificationId','verificationNonce','verificationTaskId')})
    url=config['serverBaseUrl'].rstrip('/')+'/api/v1/windows-agents/'+urllib.parse.quote(config['agentId'],safe='')+'/wecom-cleanup/'+urllib.parse.quote(binding['obligationId'],safe='')+'/lease?'+query
    check_budget()
    if lease_budget is None:raise VerifyStop('wecom_cleanup_causal_context_unconfirmed')
    started=lease_budget.sample()
    if request is not None:result=request(url,config['agentToken'])
    else:
        req=urllib.request.Request(url,headers={'Authorization':'Bearer '+config['agentToken']})
        try:
            with urllib.request.build_opener(NoRedirect).open(req,timeout=2)as response:raw=response.read(2049)
            if len(raw)>2048:raise ValueError('bounded')
            result=json.loads(raw)
        except Exception:raise VerifyStop('wecom_cleanup_lease_unconfirmed')from None
    check_budget()
    return isinstance(result,dict)and lease_budget.consume(result,started)

def execute(value,*,cancelled=lambda:False,clock=time.monotonic,wall=time.time,runtime_factory=SystemRuntimeGuard,process_created_at=None,closed_hosts=None,adb_factory=ReadOnlyAdb,sleep=time.sleep,lease_request=None):
    config=validate_config(value);began=clock();end=began+3
    lease_budget=CausalLeaseBudget(config['causalLease'],clock=clock)
    def budget():
        if cancelled():raise VerifyStop('wecom_cleanup_cancelled')
        if clock()>=end:raise VerifyStop('wecom_cleanup_verify_timeout')
    budget();identity=runtime_factory()
    def local_guard():budget();identity.check();budget();return True
    def authority_guard():
        local_guard();valid=lease(config,budget,request=lease_request,lease_budget=lease_budget);local_guard()
        if not valid:raise VerifyStop('wecom_cleanup_lease_lost')
        return True
    if closed_hosts is None:
        if not original_hosts_closed(config['hosts']):raise VerifyStop('wecom_original_host_still_alive')
    elif closed_hosts(config['hosts'])is not True:raise VerifyStop('wecom_original_host_still_alive')
    hosts=[]
    for h in config['hosts']:
        try:hosts.append(HostRef(h['pid'],float.fromhex(h['creationToken'])))
        except Exception:raise VerifyStop('wecom_original_host_unconfirmed')from None
    if process_created_at is None:
        import psutil
        def process_created_at(pid):
            try:return psutil.Process(pid).create_time()
            except psutil.NoSuchProcess as error:
                if type(error)is not psutil.NoSuchProcess:raise
                return None
    # Read fresh server authority before each complete frame and after both.
    # Keep fresh local identity and the original deadline at each socket
    # open/send. Repeating the same HTTP GET for every read-only command used
    # most of the three-second proof window before the second frame existed.
    def io_guard():budget();return True
    adb=adb_factory(config['serial'],io_guard,budget,operation_guard=local_guard)
    def frame_pids(package):
        if package==MAIN:authority_guard()
        return adb.pids(package)
    # Full identity checks remain at every socket open/send and authority
    # boundary. Generic receive/bookkeeping loops only check cancellation/time;
    # duplicating the global TCP scan there delays the exact same proof.
    frames=verify_empty(serial=config['serial'],hosts=hosts,process_created_at=process_created_at,pids=frame_pids,forwards=adb.forwards,guard=io_guard,check_budget=budget,sleep=sleep,clock=clock,wall_clock=wall)
    authority_guard()
    if clock()-frames[0].captured_at>3:raise VerifyStop('wecom_tool_proof_stale')
    proof={'binding':config['physicalCleanup'],**{k:config[k]for k in ('verificationId','verificationNonce','verificationTaskId')},'challenge':dict(config['challenge']),
        'snapshots':[{'sequence':i+1,'elapsedMs':(frame.captured_at-began)*1000,'observedAt':proof_time(frame.observed_at),'packagesAbsent':True,'packageNames':[MAIN,TEST],'serialForwardCount':0}for i,frame in enumerate(frames)]}
    if not 0<=proof['snapshots'][0]['elapsedMs']<proof['snapshots'][1]['elapsedMs']<=3000:raise VerifyStop('wecom_tool_proof_stale')
    return proof

def main():
    cancelled=threading.Event()
    try:
        raw=read_line(sys.stdin,32768)
        if len(raw)>32768:raise VerifyStop('wecom_cleanup_config_invalid')
        value=json.loads(raw);start(sys.stdin,cancelled)
        result={'ok':True,'proof':execute(value,cancelled=cancelled.is_set)}
    except VerifyStop as error:
        code=str(error)if re.fullmatch(r'[a-z0-9_]{1,100}',str(error))else 'wecom_cleanup_verify_unconfirmed'
        result={'ok':False,'code':code}
    except Exception:result={'ok':False,'code':'wecom_cleanup_verify_unconfirmed'}
    print(json.dumps(result),flush=True)

if __name__=='__main__':main()
