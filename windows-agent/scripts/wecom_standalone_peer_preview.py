"""Staged preview with actual connected-peer attestation; no shared Agent load."""
import contextlib
import json
import os
import re
import sys
import time
import wecom_platform_preview as host
from wecom_screen_lease import ScreenAuthority
from wecom_qa_socket_peer import SocketPeerGuard
from wecom_qa_tcp_runtime import WindowsTcpRuntime,identity_scope
from wecom_call_trace import CallTrace
from wecom_private_observation import writer
from pathlib import Path
from wecom_rpc_evidence import RpcEvidenceProbe


def main():
    authority = None
    peer_guard = None
    host.calls = CallTrace(sys.stderr, clock=time.monotonic)
    host.calls.start()
    try:
        raw = host.control_pipe.read_line(sys.stdin,65536)
        if len(raw)>65536: raise host.SafeStop('qa_input_too_large')
        envelope = json.loads(raw)
        if set(envelope) != {'task','reservation'}: raise host.SafeStop('qa_envelope_invalid')
        config = host.validate_config(envelope['task'])
        if config['mode'] != 'preview' or config['previewOnly'] is not True:
            raise host.SafeStop('qa_send_forbidden')
        runtime=WindowsTcpRuntime()
        authority = ScreenAuthority(envelope['reservation'],runtime=runtime)
        authority.observe_page=writer(Path(__file__).resolve().parents[2],config['phoneNumber'])
        authority.observe_difference=authority.observe_page.difference
        authority.observe_startup=authority.observe_page.startup
        authority.observe_blank_screen=authority.observe_page.capture_blank_screen
        peer_guard = SocketPeerGuard(authority.binding, forwards=lambda: host.resource_state.get('forwards', []),runtime=runtime)
        host.start_control_monitor(sys.stdin)
        # Only the two structured channels retain diagnostics; SDK output is discarded.
        with identity_scope(host,authority),peer_guard.install(), open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):
            probe=RpcEvidenceProbe(config['serial'],Path(__file__).resolve().parents[2])
            probe.prepare()
            authority.observe_rpc_failure=probe.capture
            result = host.run_host(config, sys.__stderr__, authority=authority)
    except (host.SafeStop,host.w.StopPreview) as error:
        code = str(error)
        if not re.fullmatch(r'[a-z0-9_]{1,100}',code): code='qa_preview_stopped'
        result = dict(previewStatus='blocked',previewCode=code,invitationSent=False,
                      sendStatus='not_attempted',remarkSaveStatus='unknown')
    except Exception:
        result = dict(previewStatus='blocked',previewCode='qa_executor_error_no_replay',
                      invitationSent=False,sendStatus='not_attempted',remarkSaveStatus='unknown')
    result['diagnostic'] = {'wecomExecution':host.trace.summary()}
    result['isolation'] = {'mode':'real_screen_reservation', 'resources':host.resource_state,
                           'productionWindowsTask':False, 'primaryFailure':host.primary_failure, 'authorityFailure':authority.last_failure if authority else None, 'authorityFailureStage':authority.last_failure_stage if authority else None}
    if peer_guard is not None:
        result['isolation']['socketPeer'] = peer_guard.summary()
        result['isolation']['tcpOwnerBackend']=runtime.backend
        print('WECOM_SOCKET_PEER '+json.dumps(peer_guard.summary()), file=sys.__stderr__, flush=True)
    host.calls.flush_tail()
    host.calls.emit({'kind':'lifecycle','event':'before_final_json'},essential=True)
    host.calls.sample()
    print(json.dumps(result),flush=True)
    host.calls.emit({'kind':'lifecycle','event':'final_json_flushed'},essential=True)


if __name__=='__main__': main()
