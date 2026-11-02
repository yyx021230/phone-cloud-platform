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
from wecom_cleanup_contract import validate_binding
from wecom_control_pipe import read_line,start
from wecom_host_identity import original_hosts_closed,utc_iso
from wecom_physical_verify import HostRef,ReadOnlyAdb,VerifyStop,verify_empty
from wecom_system_runtime import SystemRuntimeGuard

FIELDS={'taskId','deviceId','serial','agentId','serverBaseUrl','agentToken','physicalCleanup','verificationId','verificationNonce','verificationTaskId','issuedAt','expiresAt','pickedAt','hosts'}

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
    issued,expires,picked=(timestamp(value[k])for k in ('issuedAt','expiresAt','pickedAt'))
    if not issued<=picked<expires or expires-issued>120.001:raise VerifyStop('wecom_cleanup_time_invalid')
    url=urllib.parse.urlsplit(value['serverBaseUrl'])
    if url.scheme not in('http','https')or not url.hostname or url.username or url.password or url.query or url.fragment:raise VerifyStop('wecom_cleanup_origin_invalid')
    if not isinstance(value['agentToken'],str)or not value['agentToken']or len(value['agentToken'])>16384:raise VerifyStop('wecom_cleanup_credential_missing')
    if not isinstance(value['hosts'],list)or not 1<=len(value['hosts'])<=8:raise VerifyStop('wecom_original_host_unconfirmed')
    return dict(value,physicalCleanup=binding)

def lease(config,check_budget,*,request=None):
    binding=config['physicalCleanup']
    query=urllib.parse.urlencode({k:config[k]for k in ('verificationId','verificationNonce','verificationTaskId')})
    url=config['serverBaseUrl'].rstrip('/')+'/api/v1/windows-agents/'+urllib.parse.quote(config['agentId'],safe='')+'/wecom-cleanup/'+urllib.parse.quote(binding['obligationId'],safe='')+'/lease?'+query
    check_budget()
    if request is not None:result=request(url,config['agentToken'])
    else:
        req=urllib.request.Request(url,headers={'Authorization':'Bearer '+config['agentToken']})
        try:
            with urllib.request.build_opener(NoRedirect).open(req,timeout=2)as response:raw=response.read(2049)
            if len(raw)>2048:raise ValueError('bounded')
            result=json.loads(raw)
        except Exception:raise VerifyStop('wecom_cleanup_lease_unconfirmed')from None
    check_budget()
    return isinstance(result,dict)and result.get('valid')is True

def execute(value,*,cancelled=lambda:False,clock=time.monotonic,wall=time.time,runtime_factory=SystemRuntimeGuard,process_created_at=None,closed_hosts=None,adb_factory=ReadOnlyAdb,sleep=time.sleep,lease_request=None):
    config=validate_config(value);began=clock();end=min(began+20,began+timestamp(config['expiresAt'])-wall())
    def budget():
        if cancelled():raise VerifyStop('wecom_cleanup_cancelled')
        if clock()>=end:raise VerifyStop('wecom_cleanup_verify_timeout')
    budget();identity=runtime_factory()
    def local_guard():budget();identity.check();budget();return True
    def authority_guard():
        local_guard();valid=lease(config,budget,request=lease_request);local_guard()
        if not valid:raise VerifyStop('wecom_cleanup_lease_lost')
        return True
    authority_guard()
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
    # Cancellation/deadline checks apply to each IO byte. Full runtime + lease
    # checks run before every fixed smart-socket command/open, not a cached
    # proof or repeated HTTP request for each byte of the same response.
    def io_guard():budget();return True
    adb=adb_factory(config['serial'],io_guard,budget,operation_guard=authority_guard)
    frames=verify_empty(serial=config['serial'],hosts=hosts,process_created_at=process_created_at,pids=adb.pids,forwards=adb.forwards,guard=local_guard,check_budget=budget,sleep=sleep,clock=clock,wall_clock=wall)
    authority_guard()
    if clock()-frames[0].captured_at>3:raise VerifyStop('wecom_tool_proof_stale')
    proof={'binding':config['physicalCleanup'],**{k:config[k]for k in ('verificationId','verificationNonce','verificationTaskId')},
        'snapshots':[{'observedAt':proof_time(frame.observed_at),'packagesAbsent':True,'packageNames':[MAIN,TEST],'serialForwardCount':0}for frame in frames]}
    stamps=[timestamp(p['observedAt'])for p in proof['snapshots']]
    if not timestamp(config['pickedAt'])<stamps[0]<stamps[1]or any(wall()-stamp>3 or stamp>wall()for stamp in stamps):raise VerifyStop('wecom_tool_proof_stale')
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
