"""Test-only authority for an existing real screen reservation, never fake tasks."""
import hashlib
import json
import re
import math
import secrets
import time
import urllib.parse
import urllib.request
import contextlib
from pathlib import Path

BOUND = ('taskId', 'deviceId', 'serial', 'deviceNumber', 'appSlot', 'androidUser',
         'agentId', 'physicalAgentId', 'sessionId', 'lockId', 'ownerUserId', 'operationFingerprint', 'purpose', 'authorityGeneration', 'scopeFingerprint')
INVENTORY_PATH = r'D:\PhoneCloud\agent\data\device-scan-cache.json'


def validate(config, proof, inventory, *, nonce, round_trip, local_age, inventory_age):
    if not isinstance(proof, dict) or type(proof.get('version'))is not int or type(config.get('proofVersion',1))is not int or config.get('proofVersion',1)not in (1,2) or proof.get('version') != config.get('proofVersion',1) or proof.get('allowed') is not True:
        raise ValueError('qa_lease_denied')
    if proof.get('nonce') != nonce or not re.fullmatch(r'[a-f0-9]{32}', nonce):
        raise ValueError('qa_proof_nonce_changed')
    if type(proof.get('androidUser')) is not int or any(proof.get(key) != config.get(key) for key in BOUND):
        raise ValueError('qa_lease_identity_changed')
    for value in (round_trip, local_age, proof.get('brokerAgeSeconds')):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 3:
            raise ValueError('qa_proof_stale')
    # v2 age is measured at SERVER REQUEST ARRIVAL. A fact read inside this
    # request is entirely covered by the measured client RTT, never counted
    # twice. v1 retains its original conservative age-at-send contract.
    if config.get('proofVersion',1)==2 and proof.get('ageReference')!='request_received':
        raise ValueError('qa_proof_stale')
    total_age = round_trip + local_age + proof['brokerAgeSeconds']
    expiry = proof.get('expiresInSeconds')
    if isinstance(expiry,bool) or not isinstance(expiry,(int,float)) or not math.isfinite(expiry) or total_age > 3 or expiry-total_age <= 15:
        raise ValueError('qa_proof_stale')
    if type(proof.get('activeLockCount')) is not int or proof.get('activeLockCount') != 1 or proof.get('sessionAlive') is not True or proof.get('lookupExcluded') is not True:
        raise ValueError('qa_lease_not_exclusive')
    if not 0 <= inventory_age <= 90:
        raise ValueError('qa_inventory_stale')
    matches = [d for d in inventory if d.get('deviceId') == config['deviceId'] or d.get('adb', {}).get('serial') == config['serial']]
    if len(matches) != 1: raise ValueError('qa_inventory_ambiguous')
    device = matches[0]; adb = device.get('adb', {}); occupancy = device.get('occupancy') or {}
    if (device.get('deviceId') != config['deviceId'] or str(device.get('deviceName')) != config['deviceNumber']
            or adb.get('serial') != config['serial'] or adb.get('agentId') != config['physicalAgentId'] or adb.get('state') != 'device'):
        raise ValueError('qa_inventory_identity_changed')
    if occupancy.get('kind') != 'screen_control' or occupancy.get('sessionId') != config['sessionId']:
        raise ValueError('qa_inventory_not_owned_reservation')
    return True


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


class ScreenAuthority:
    def __init__(self, binding, *, clock=time.monotonic, wall=time.time):
        self.binding = dict(binding); self.clock, self.wall = clock, wall
        self.revoked = False
        self.last_failure = None
        self.last_failure_stage = None
        self.observe = lambda label:contextlib.nullcontext()
        self.observe_blank_screen = lambda capture:None
        self.observe_startup = lambda kind,raw,user:None
        self.observe_page = lambda observation,page:None
        self.observe_difference = lambda action,before,after:None
        if binding.get('inventoryPath') != INVENTORY_PATH:
            raise ValueError('qa_inventory_path_invalid')
        for key in BOUND:
            if key not in binding or (key != 'androidUser' and (not isinstance(binding[key], str) or not binding[key] or len(binding[key])>200)):
                raise ValueError('qa_binding_incomplete')
        if binding['purpose'] not in ('preview', 'cleanup') or not re.fullmatch(r'[a-f0-9]{32}',binding['authorityGeneration']):
            raise ValueError('qa_authority_generation_invalid')
        url = urllib.parse.urlsplit(binding['brokerUrl'])
        if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.port == 5037
                or url.path not in ('', '/') or url.query or url.fragment or url.username or url.password):
            raise ValueError('qa_broker_origin_invalid')
        if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', binding['brokerToken']):
            raise ValueError('qa_broker_credential_invalid')

    def host_identity(self):
        import psutil
        value = self.binding
        agent = psutil.Process(value['agentPid'])
        if (agent.username() != r'NT AUTHORITY\SYSTEM' or agent.exe() != value['agentExe']
                or agent.create_time() != value['agentCreatedAt']):
            raise ValueError('qa_agent_identity_changed')
        listeners = {row.pid for row in psutil.net_connections(kind='tcp') if row.status == 'LISTEN' and row.laddr.port == 5037}
        if listeners != {value['adbPid']}: raise ValueError('qa_adb_listener_changed')
        adb = psutil.Process(value['adbPid'])
        if (adb.username() != r'NT AUTHORITY\SYSTEM' or Path(adb.exe()) != Path(r'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe')
                or adb.create_time() != value['adbCreatedAt']):
            raise ValueError('qa_adb_identity_changed')

    def check(self, config):
        return self._check(config, 'preview')

    def check_cleanup(self, config):
        return self._check(config, 'cleanup')

    def _check(self, config, purpose):
        if self.revoked: return False
        stage='configuration'
        try:
            if self.binding['purpose'] != purpose: raise ValueError('qa_authority_purpose_changed')
            if config.get('mode') != 'preview' or config.get('previewOnly') is not True:
                raise ValueError('qa_send_forbidden')
            if any(config.get(k) != self.binding[k] for k in ('taskId','deviceId','serial','deviceNumber','appSlot','androidUser','agentId')):
                raise ValueError('qa_config_changed')
            fingerprint = hashlib.sha256(json.dumps(['preview', hashlib.sha256(json.dumps(
                [config['remarkName'],config['description']],ensure_ascii=False,separators=(',',':')).encode()).hexdigest(),
                config['phoneNumber'],config['deviceId'],config['androidUser']],separators=(',',':')).encode()).hexdigest()
            if fingerprint != self.binding['operationFingerprint']: raise ValueError('qa_operation_changed')
            stage='host_identity'
            with self.observe('qa.host_identity'): self.host_identity()
            stage='inventory_read'
            with self.observe('qa.inventory'):
                path = Path(self.binding['inventoryPath'])
                payload = json.loads(path.read_text(encoding='utf-8-sig'))
                inventory = payload if isinstance(payload, list) else payload['devices']
            nonce = secrets.token_hex(16); started = self.clock()
            body = json.dumps({'taskId':self.binding['taskId'], 'nonce':nonce, 'purpose':purpose,
                'authorityGeneration':self.binding['authorityGeneration'], 'proofVersion':self.binding.get('proofVersion',1)}).encode()
            request = urllib.request.Request(self.binding['brokerUrl'].rstrip('/')+'/guard', data=body,
                headers={'Authorization':'Bearer '+self.binding['brokerToken'],'Content-Type':'application/json'}, method='POST')
            stage='proof_request'
            with self.observe('qa.proof_request'):
                with urllib.request.build_opener(NoRedirect).open(request, timeout=2) as response:
                    raw=response.read(16385)
            finished = self.clock()
            if len(raw)>16384: raise ValueError('qa_proof_too_large')
            stage='proof_parse'
            proof=json.loads(raw)
            stage='proof_validate'
            return validate(self.binding,proof,inventory,nonce=nonce,round_trip=finished-started,
                local_age=self.clock()-finished, inventory_age=self.wall()-path.stat().st_mtime)
        except Exception as error:
            fixed=('qa_lease_denied','qa_proof_nonce_changed','qa_lease_identity_changed','qa_proof_stale','qa_lease_not_exclusive','qa_inventory_stale','qa_inventory_ambiguous','qa_inventory_identity_changed','qa_inventory_not_owned_reservation','qa_send_forbidden','qa_config_changed','qa_operation_changed','qa_authority_purpose_changed','qa_proof_too_large','qa_agent_identity_changed','qa_adb_listener_changed','qa_adb_identity_changed')
            self.last_failure_stage=stage
            name=type(error).__name__
            category=('timeout'if isinstance(error,TimeoutError)or isinstance(getattr(error,'reason',None),TimeoutError)else 'json_invalid'if name=='JSONDecodeError'else 'file_missing'if name=='FileNotFoundError'else 'file_denied'if name=='PermissionError'else 'host_inspection'if name in ('AccessDenied','NoSuchProcess','ZombieProcess')else 'http_denied'if name=='HTTPError'else 'connection'if name in ('URLError','ConnectionError','ConnectionResetError','ConnectionAbortedError')else 'timeout'if isinstance(error,TimeoutError)else 'os_error'if isinstance(error,OSError)else 'unknown')
            self.last_failure=str(error) if isinstance(error,ValueError)and str(error)in fixed else 'qa_authority_'+category
            self.revoked = True  # No implicit resume of the same generation.
            return False
