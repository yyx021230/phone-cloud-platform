"""Exact, machine-bound process identities for the WeCom task reader."""
import datetime
import hashlib
import math
import os
import re
import uuid
from wecom_physical_verify import VerifyStop
from wecom_system_runtime import SystemRuntimeGuard


def creation_token(value):
    if type(value)not in(int,float)or not math.isfinite(value)or value<=0:raise VerifyStop('wecom_host_identity_invalid')
    return float(value).hex()


def utc_iso(value):
    return datetime.datetime.fromtimestamp(value,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')


def machine_identity():
    """Read the existing 64-bit Windows machine ID; never create/alter a key."""
    if os.name!='nt':raise VerifyStop('wecom_windows_system_required')
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,r'SOFTWARE\Microsoft\Cryptography',0,winreg.KEY_READ|winreg.KEY_WOW64_64KEY)as key:
            raw,kind=winreg.QueryValueEx(key,'MachineGuid')
        if kind!=winreg.REG_SZ or not isinstance(raw,str):raise ValueError('invalid')
        normalized=uuid.UUID(raw).hex
        return hashlib.sha256(('phone-cloud-wecom-host-v1:'+normalized).encode('ascii')).hexdigest()
    except Exception:raise VerifyStop('wecom_machine_identity_unconfirmed')from None


def host_reference(role,pid,*,runtime,machine_id):
    if not isinstance(role,str)or not re.fullmatch(r'[a-z][a-z0-9_]{0,31}',role)or type(pid)is not int or pid<=0 or not re.fullmatch(r'[a-f0-9]{64}',machine_id):
        raise VerifyStop('wecom_host_identity_invalid')
    value=runtime.Process(pid).create_time()
    return dict(role=role,pid=pid,createdAt=utc_iso(value),creationToken=creation_token(value),machineId=machine_id)


def reader_bootstrap(*,runtime=None,current_pid=None,parent_pid=None,platform=None,machine=None):
    """Reader waits after self-report; the existing parent Agent ACKs it first."""
    if runtime is None:import psutil;runtime=psutil
    current_pid=os.getpid()if current_pid is None else current_pid
    parent_pid=os.getppid()if parent_pid is None else parent_pid
    guard=SystemRuntimeGuard(runtime=runtime,current_pid=current_pid,parent_pid=parent_pid,agent_pid=parent_pid,platform=platform)
    try:
        argv=runtime.Process(parent_pid).cmdline()
        if not any(str(v).replace('\\','/').lower()=='d:/phonecloud/agent/src/index.mjs'for v in argv):
            raise VerifyStop('wecom_agent_parent_unconfirmed')
        machine_id=(machine or machine_identity)()
        return [host_reference('reader',current_pid,runtime=runtime,machine_id=machine_id)],guard
    except VerifyStop:raise
    except Exception:raise VerifyStop('wecom_host_identity_unconfirmed')from None


def reader_hosts(**kwargs):return reader_bootstrap(**kwargs)[0]


def causal_reader_bootstrap(envelope,**kwargs):
    """Bind the real reader to this parent's private bootstrap before UI input."""
    from wecom_cleanup_contract import validate_binding
    if not isinstance(envelope,dict)or set(envelope)!={'version','binding','bootstrap'}or type(envelope['version'])is not int or envelope['version']!=1:
        raise VerifyStop('wecom_cleanup_bootstrap_unconfirmed')
    b=envelope['binding'];p=envelope['bootstrap']
    if not isinstance(b,dict)or not isinstance(p,dict)or set(p)!={'protocol','bindingNonce','pipeNonce'}or p['protocol']!='wecom-causal-v1' or p['bindingNonce']!=b.get('nonce')or not isinstance(p['pipeNonce'],str)or not re.fullmatch(r'[a-f0-9]{48}',p['pipeNonce']):
        raise VerifyStop('wecom_cleanup_bootstrap_unconfirmed')
    context={**b,'taskId':b.get('originalTaskId')}
    validate_binding(b,context,original=True)
    hosts,guard=reader_bootstrap(**kwargs)
    return hosts,guard,dict(p)


def original_hosts_closed(hosts,*,runtime=None,machine=None):
    """Local parent proof only. Another machine or missing precision is unknown."""
    if runtime is None:import psutil;runtime=psutil
    machine_id=(machine or machine_identity)()
    if not isinstance(hosts,list)or not 1<=len(hosts)<=8 or any(not isinstance(h,dict)for h in hosts)or 'reader'not in {h.get('role')for h in hosts}or len({h.get('role')for h in hosts})!=len(hosts):
        raise VerifyStop('wecom_original_host_unconfirmed')
    if len({h.get('pid')for h in hosts})!=len(hosts):raise VerifyStop('wecom_original_host_unconfirmed')
    for h in hosts:
        if set(h)!={'role','pid','createdAt','creationToken','machineId'}or type(h['pid'])is not int or h['pid']<=0:
            raise VerifyStop('wecom_original_host_unconfirmed')
        if h['machineId']!=machine_id:raise VerifyStop('wecom_original_machine_mismatch')
        token=h['creationToken']
        try:
            value=float.fromhex(token)
            if creation_token(value)!=token or utc_iso(value)!=h['createdAt']:raise ValueError('invalid')
        except Exception:raise VerifyStop('wecom_original_host_unconfirmed')from None
        try:current=runtime.Process(h['pid']).create_time()
        except runtime.NoSuchProcess as error:
            if type(error)is not runtime.NoSuchProcess:raise VerifyStop('wecom_original_host_unconfirmed')from None
            continue
        except Exception:raise VerifyStop('wecom_original_host_unconfirmed')from None
        if creation_token(current)==token:return False
    return True
