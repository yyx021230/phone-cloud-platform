"""Cleanup-only NEW authority generation after the original one-shot hosts exited."""
import hashlib
import json
import re
import sys
import time
import wecom_platform_preview as host
from wecom_cleanup import cleanup_reader, MAIN, TEST
from wecom_screen_lease import ScreenAuthority
from wecom_diagnostics import ExecutionTrace
from wecom_call_trace import CallTrace


def scope_fingerprint(resources, original_hosts):
    return hashlib.sha256(json.dumps([resources,original_hosts],sort_keys=True,separators=(',',':')).encode()).hexdigest()


def validate_scope(resources, original_hosts, process):
    if set(resources) != {'readerStarted','pid','startToken','forwards','cleanupConfirmed'}:
        raise ValueError('qa_cleanup_resources_invalid')
    if type(resources['readerStarted']) is not bool or resources['cleanupConfirmed'] not in (True,False,None):
        raise ValueError('qa_cleanup_resources_invalid')
    if any(not isinstance(resources[k],str) or (resources[k] and not re.fullmatch(r'[1-9]\d{0,19}',resources[k])) for k in ('pid','startToken')):
        raise ValueError('qa_cleanup_resources_invalid')
    mappings=resources['forwards']
    if not isinstance(mappings,list) or len(mappings)>2 or any(not isinstance(p,list) or len(p)!=2 or type(p[0]) is not int or not 1024<p[0]<65536 or p[0]==5037 or p[1] not in (10080,10081) for p in mappings):
        raise ValueError('qa_cleanup_resources_invalid')
    if not isinstance(original_hosts,list) or len(original_hosts)!=2:
        raise ValueError('qa_original_hosts_unconfirmed')
    for h in original_hosts:
        if set(h)!={'pid','createdAt'} or type(h['pid']) is not int or h['pid']<=0 or type(h['createdAt']) not in (int,float) or h['createdAt']<=0:
            raise ValueError('qa_original_hosts_unconfirmed')
        # Callback must distinguish NoSuchProcess from all other inspection errors.
        creation=process(h['pid'])
        if creation is not None and creation==h['createdAt']:
            raise ValueError('qa_original_host_still_alive')
    if original_hosts[0]['pid']==original_hosts[1]['pid']:
        raise ValueError('qa_original_hosts_unconfirmed')


class CleanupView:
    def __init__(self,authority):self.authority=authority
    def check(self,config):return self.authority.check_cleanup(config)


def execute(envelope, *, process):
    if set(envelope)!={'task','reservation','resources','originalHosts'}:raise ValueError('qa_cleanup_envelope_invalid')
    config=host.validate_config(envelope['task']);binding=envelope['reservation'];resources=envelope['resources'];original_hosts=envelope['originalHosts']
    validate_scope(resources,original_hosts,process)
    if binding.get('purpose')!='cleanup' or binding.get('scopeFingerprint')!=scope_fingerprint(resources,original_hosts):
        raise ValueError('qa_cleanup_scope_changed')
    authority=ScreenAuthority(binding)
    if not authority.check_cleanup(config):raise ValueError('qa_cleanup_authority_denied')
    host.config=config;host.SERIAL=config['serial'];host.selected_user=config['androidUser']
    host.external_authority=CleanupView(authority);host.initial_adb=binding['adbPid']
    host.cleaning_up=True;host.deadline=time.monotonic()+12
    host.trace=ExecutionTrace(None,clock=time.monotonic)
    ok=cleanup_reader(serial=config['serial'],ports=resources['forwards'],owned_pid=resources['pid'],
        owned_start=resources['startToken'],reader_started=resources['readerStarted'],pids=host.reader_pids,
        start_token=lambda pid:host.process_start_token(host.shell('cat /proc/'+pid+'/stat')),
        stop_main=lambda:host.shell('am force-stop com.netease.open.pocoservice'),
        close_instrument=lambda:None,forwards=host.reader_forwards,remove_forward=host.remove_reader_forward)
    # Even a preflight stop must not be confused with a clean phone. Limit the
    # forward proof to this reader protocol, preserving control/other forwards.
    return ok and not host.reader_pids(MAIN) and not host.reader_pids(TEST) and not any(
        serial==config['serial'] and remote in ('tcp:10080','tcp:10081')
        for serial,local,remote in host.reader_forwards())


def main():
    import psutil
    def process(pid):
        try:return psutil.Process(pid).create_time()
        except psutil.NoSuchProcess:return None
    host.calls=CallTrace(sys.stderr,clock=time.monotonic)
    try:
        raw=sys.stdin.readline(65537)
        if len(raw)>65536:raise ValueError('qa_cleanup_input_too_large')
        ok=execute(json.loads(raw),process=process)
        result={'cleanupConfirmed':ok,'code':'qa_cleanup_confirmed' if ok else 'qa_cleanup_unconfirmed'}
    except Exception:
        result={'cleanupConfirmed':False,'code':'qa_cleanup_unconfirmed'}
    print(json.dumps(result),flush=True)

if __name__=='__main__':main()
