"""Narrow QA reads and normal listing updates over an operator-owned SSH master."""
import json
import math
from pathlib import Path
import shlex
import subprocess
import time

import wecom_qa_access as access


def require(ok, code):
    if not ok: raise RuntimeError(code)


def transport(code, value, *, timeout=9):
    require(Path(access.CLOUD_SOCKET).is_socket(), 'qa_cloud_master_missing')
    argv = ['ssh', '-F', '/dev/null', '-S', access.CLOUD_SOCKET, '-o', 'ControlMaster=no',
            '-o', 'BatchMode=yes', '-o', 'ProxyCommand=/usr/bin/false', '-T', access.CLOUD_HOST,
            'docker exec -i phone-cloud-platform node --input-type=module -e '+shlex.quote(code)]
    try:
        r = subprocess.run(argv, input=json.dumps(value).encode(), capture_output=True, timeout=timeout)
        require(r.returncode == 0 and len(r.stdout) <= 2*1024*1024, 'qa_transport_unknown')
        answer = json.loads(r.stdout)
        require(isinstance(answer, dict) and 'error' not in answer, 'qa_read_unknown')
        return answer
    except RuntimeError: raise
    except Exception: raise RuntimeError('qa_transport_unknown') from None


class Reader:
    def __init__(self, target):
        self.target = dict(target)
        self.source = Path(__file__).with_name('wecom_single_reader.mjs').read_text()
        self.failed = False

    def state(self, session=None):
        require(not self.failed, 'qa_reader_revoked')
        start = time.monotonic()
        try:
            result = transport(self.source, dict(target=self.target, session=session))
            result['readStartedMono'] = start
            return result
        except Exception:
            self.failed = True
            raise


def assert_idle(target, state):
    rows = state.get('devices', [])
    require(len(rows) == 1, 'qa_device_ambiguous')
    d = rows[0]
    require(d['deviceId'] == target['deviceId'] and d['deviceName'] == target['deviceNumber']
            and d['adb']['serial'] == target['serial'], 'qa_device_alias_conflict')
    require(state.get('lookupExcluded') is True and not any(state.get(k)
            for k in ('locks', 'tasks', 'jobs', 'sessions')), 'qa_target_not_exclusive')
    require(d.get('listingStatus') == 'listed' and state['runtime']['online'] is True
            and state['runtime']['available'] is True, 'qa_target_not_idle')
    return d


def assert_owned(binding, state, *, marker=None):
    rows, locks = state.get('devices', []), state.get('locks', [])
    require(len(rows) == len(locks) == 1, 'qa_ownership_ambiguous')
    d, lock, session = rows[0], locks[0], state.get('session') or {}
    require(d['deviceId'] == binding['deviceId'] and d['deviceName'] == binding['deviceNumber']
            and d['adb']['serial'] == binding['serial'] and d['adb']['agentId'] == binding['physicalAgentId'], 'qa_device_changed')
    require(state['runtime']['online'] is True and d['adb']['state'] == 'device', 'qa_device_offline')
    require(state.get('lookupExcluded') is True and not any(state.get(k)
            for k in ('tasks', 'jobs', 'sessions')), 'qa_other_work_or_lookup')
    require(lock['lock_id'] == binding['lockId'] and lock['status'] == 'active'
            and lock['type'] == 'screen_control' and lock['task_id'] == binding['sessionId']
            and lock['owner'] == binding['ownerUserId'], 'qa_lock_changed')
    require(session.get('sessionId') == binding['sessionId'] and session.get('deviceId') == binding['deviceId']
            and session.get('userId') == binding['ownerUserId']
            and session.get('agentId') == binding['physicalAgentId'] and session.get('adbSerial') == binding['serial']
            and session.get('status') in ('ready', 'streaming'), 'qa_session_changed')
    occupancy = state['runtime'].get('occupancy') or {}
    require(occupancy.get('type') == 'screen_control', 'qa_runtime_ownership_changed')
    if marker is not None:
        require(d.get('listingStatus') == 'unlisted' and d.get('unlistedAt') == marker
                and state['runtime'].get('listed') is False, 'qa_maintenance_marker_changed')
    expiry = state.get('expiresInSeconds')
    require(type(expiry) in (int, float) and math.isfinite(expiry)
            and expiry - (time.monotonic()-state['readStartedMono']) > 20, 'qa_expiry_too_close')
    return expiry - (time.monotonic()-state['readStartedMono'])


def listing(target, value):
    require(value in ('listed', 'unlisted'), 'qa_listing_invalid')
    code = """let raw='';for await(const c of process.stdin)raw+=c;const input=JSON.parse(raw);
const r=await fetch('http://127.0.0.1:8787/api/v1/devices/'+encodeURIComponent(input.deviceId),{
method:'PUT',headers:{authorization:'Bearer '+process.env.ADMIN_API_TOKEN,'content-type':'application/json'},
body:JSON.stringify({listingStatus:input.value}),redirect:'error',signal:AbortSignal.timeout(5000)});
const body=await r.json();if(r.status!==200)throw Error('listing_update_unknown');
const d=body.device;console.log(JSON.stringify({http:r.status,deviceId:d.deviceId,deviceName:d.deviceName,
listingStatus:d.listingStatus,unlistedAt:d.unlistedAt,updatedAt:d.updatedAt}));"""
    result = transport(code, dict(deviceId=target['deviceId'], value=value))
    require(result['deviceId'] == target['deviceId'] and result['deviceName'] == target['deviceNumber']
            and result['listingStatus'] == value, 'qa_listing_ack_unknown')
    return result
