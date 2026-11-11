"""Guarded release registration; never restores state or restarts services."""
import copy
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request

BASE = Path('/opt/phone-cloud-platform')
STAGE = Path('/opt/phone-cloud-staging/wecom-cps-preview-20261111-rc.2')
RECEIPT = Path('/opt/phone-cloud-staging/wecom-cps-preview-20261111-deployed.1')
BEFORE = 'b033757d557909e0d1c79b7ba375aae2b3efe302edc2c85897ff4244c3d391d5'
NEXT = 'sha256:03b99e4e37271941d4946ef7f6d94381f1076fb13772216104440b24eec3eda6'
TAG = 'phone-cloud-platform:wecom-cps-preview-20261111-rc.8'
CODE = '3b32a1d44b2382b117da112ff6ee1e9db0b90664'
EXPECTED = {
    'server/wecom-preinput-recovery.mjs': '57fc6886364e367e16c9b2470704ae22d4ed55c608d6a1c26872bf7fb2bb78b6',
    'public/cps-wecom-integration-api.md': 'e88beba10724b7085fcde33c44f1dea5268c85372014f5e34e5513311b52f53d',
}


def sha(value):
    return hashlib.sha256(value).hexdigest()


def command(args, **kwargs):
    return subprocess.check_output(args, text=True, timeout=40, **kwargs).strip()


def query(sql, database='phone_cloud'):
    return json.loads(command(['docker', 'exec', '-i', 'phone-cloud-postgres', 'psql', '-X', '-qAt',
                              '-U', 'phone_cloud', '-d', database, '-v', 'ON_ERROR_STOP=1'],
                             input="BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; " + sql + '; COMMIT;'))


def inspect(name):
    return json.loads(command(['docker', 'inspect', name]))[0]


def compose(paths):
    args = ['docker', 'compose', '--project-directory', str(BASE)]
    for name in paths:
        args += ['-f', name]
    return json.loads(command(args + ['config', '--no-interpolate', '--no-env-resolution', '--format', 'json']))


active = BASE / 'ACTIVE_PLATFORM_RELEASE.json'
raw = active.read_bytes()
assert sha(raw) == BEFORE, 'active_drift'
old = json.loads(raw)
main = inspect('phone-cloud-platform')
assert main['State']['Pid'] == 1730700 and main['Id'] == old['runningContainerId']
assert main['State']['StartedAt'] == old['mainStartedAt'] and main['Image'] == old['imageId']
assert main['State']['Health']['Status'] == 'healthy'
assert command(['docker', 'image', 'inspect', '--format', '{{.Id}}', TAG]) == NEXT
hash_script = "const fs=require('fs'),c=require('crypto');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const o={};for(const p of JSON.parse(s))o[p]=c.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex');console.log(JSON.stringify(o))})"
file_list = json.dumps(list(old['cloudRuntimeFiles']))
hashes = json.loads(command(['docker', 'exec', '-i', 'phone-cloud-platform', 'node', '-e', hash_script], input=file_list))
diffs = {k: v for k, v in hashes.items() if old['cloudRuntimeFiles'][k] != v}
assert diffs == EXPECTED, 'cloud_file_drift'
future = json.loads(command(['docker', 'run', '--rm', '-i', '--network=none', '--read-only', '--cap-drop=ALL',
                             '--pids-limit=32', '--memory=256m', '--entrypoint=node', TAG, '-e', hash_script], input=file_list))
assert future == hashes, 'next_start_file_mismatch'
win = json.loads((STAGE / 'windows-post.json').read_text(encoding='utf-8-sig'))
assert win['agentPid'] == 11604 and win['adb']['pid'] == 20016 and win['outboxPending'] == 0
assert win['verifiedAgentFiles'] == 109
assert win['agentFiles']['src/index.mjs'] == '8a94d6a5ce8e3d26eb9513e38a49163b74f80271ddf5952cb98423139911a871'
stamp = datetime.datetime.fromisoformat(win['atUtc'][:26] + '+00:00')
assert (datetime.datetime.now(datetime.timezone.utc) - stamp).total_seconds() < 1800, 'stale_windows_proof'
health = {}
for port, name, path in [(8787, 'healthz', 'healthz'), (8787, 'readyz', 'readyz'), (8797, 'cps', 'healthz')]:
    with urllib.request.urlopen('http://127.0.0.1:' + str(port) + '/' + path, timeout=5) as response:
        health[name] = response.status
assert all(v == 200 for v in health.values())
assert not Path('/run/phone-cloud-cps-rc3-maintenance.flag').exists()
assert sha(Path('/etc/nginx/sites-enabled/sms-code-center').read_bytes()) == '24cd66a94a4543080374572c9a20ad7cc924636368626f1dac62cf4a2e5b54b3'
assert command(['docker', 'exec', 'phone-cloud-platform', 'node', '-e',
                "fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(1000)}).then(()=>{console.log('open');process.exitCode=1}).catch(()=>console.log('closed'))"]) == 'closed'
media = json.loads(command(['/proc/1730700/root/lib/ld-musl-x86_64.so.1', '--library-path',
                            '/proc/1730700/root/lib:/proc/1730700/root/usr/lib', '/proc/1730700/root/usr/local/bin/node',
                            str(BASE / 'deploy/mediamtx-pacing/verify.mjs'), '--live']))
assert media['verified'] == 'live' and media['pid'] == 2503525 and media['bitsPerSecond'] == 8000000 and media['packetsPerGroup'] == 2
lookup_before = json.loads((STAGE / 'lookup-before.private.json').read_text())
lookup_after = query('SELECT jsonb_agg(data) FROM phone_cloud_managed_lookup')
assert len(lookup_before) == len(lookup_after) == 1
before, after = lookup_before[0], lookup_after[0]
assert after['config'] == before['config'] and after['configRevision'] == before['configRevision'] == 187
old_devices = {d['deviceId']: d for d in before['devices']}
new_devices = {d['deviceId']: d for d in after['devices']}
assert set(old_devices) == set(new_devices), 'lookup_device_pool_drift'
assert all(all(old_devices[i].get(k) == new_devices[i].get(k) for k in ('deviceId', 'deviceNumber', 'enabled')) for i in old_devices), 'lookup_device_binding_drift'
changed_device_fields = dict(collections.Counter(k for i in old_devices for k in set(old_devices[i]) | set(new_devices[i])
                                                 if old_devices[i].get(k) != new_devices[i].get(k)))
lookup = {'configUnchanged': True, 'configRevision': 187, 'poolDevices': len(after['devices']),
          'channelsBefore': len(before['channels']), 'channelsAfter': len(after['channels']),
          'sameOriginalSessionIds': sorted(c['sessionId'] for c in before['channels']) == sorted(c['sessionId'] for c in after['channels']),
          'deviceBindingsAndEnabledUnchanged': True, 'naturalDeviceStateChangesByField': changed_device_fields,
          'noSnapshotRestored': True}
old_records = json.loads((STAGE / 'rejected-proof-202.before.private.json').read_text())
for name, table, key, value in [('native', 'phone_cloud_windows_tasks', 'task_id', '00c5f1c6-8cf7-4001-b3c9-285dbfb9f50f'),
                                ('verifier', 'phone_cloud_windows_tasks', 'task_id', '1058e40f-0cb5-499e-aa02-b75afcc0402e'),
                                ('job', 'phone_cloud_automation_jobs', 'job_id', '3e2d5e14-e6b8-4445-aa90-14e044585767')]:
    current = query('SELECT data FROM ' + table + ' WHERE ' + key + "='" + value + "'")
    assert all(current.get(k) == old_records[name].get(k) for k in ('status', 'result', 'completedAt')), 'original_history_drift'
proofs = []
for device, native in [('200', 'f7b77da3-ec43-4679-a068-5acb0bae42ab'), ('202', '61de9602-9a59-4cec-909f-139e1f386d58')]:
    lock = query("SELECT l.data FROM phone_cloud_windows_tasks t JOIN phone_cloud_device_locks l ON l.lock_id=t.data->'payload'->'physicalCleanup'->>'obligationId' WHERE t.task_id='" + native + "'")
    duty = lock['physicalCleanup']
    frames = duty['proof']['snapshots']
    assert lock['status'] == 'released' and duty['phase'] == 'verified' and len(frames) == 2
    assert all(f['packagesAbsent'] is True and f['serialForwardCount'] == 0 and f['elapsedMs'] <= 3000 for f in frames)
    proofs.append({'deviceNumber': device, 'nativeTaskId': native, 'lockId': lock['lockId'],
                   'verificationTaskId': duty['verification']['verificationTaskId'], 'snapshotElapsedMs': [f['elapsedMs'] for f in frames]})
cps = inspect('phone-cloud-cps-wecom')
env = dict(s.split('=', 1) for s in cps['Config']['Env'])
assert env['CPS_EXECUTION_MODE'] == 'preview' and env['CPS_STATE_KEY'] == 'preview-20261110'
assert cps['Id'] == '13de64066b3d0cd2a5d92e0355b421153ff4328de6ee93406352cd59c9fe97a4'
members = json.loads(env['CPS_WECOM_CLIENTS_JSON'])[0]['members']
assert sorted(m['deviceNumber'] for m in members) == ['200', '202']
assert all(m['enabled'] and m['bindingVerified'] for m in members)
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
RECEIPT.mkdir(mode=0o700, exist_ok=True)
(RECEIPT / 'ACTIVE.before.json').write_bytes(raw)
overlay = RECEIPT / 'compose.pending.json'
overlay.write_text(json.dumps({'services': {'phone-cloud': {'image': TAG}}}, indent=2) + '\n')
before_compose = compose(old['activeCompose'])
after_compose = compose(old['activeCompose'] + [str(overlay)])
assert after_compose['services']['phone-cloud']['image'] == TAG
after_compose['services']['phone-cloud']['image'] = before_compose['services']['phone-cloud']['image']
assert after_compose == before_compose, 'compose_nonimage_drift'
receipt = {'version': 'wecom-cps-preview-20261111-deployed.1', 'atUtc': now, 'branch': 'codex/wecom-cps-preview-20261111',
           'candidateTag': 'wecom-cps-preview-20261111-rc.8', 'codeCommit': CODE, 'previousActiveSha256': BEFORE,
           'runningImageId': main['Image'], 'nextImageId': NEXT, 'nextImageTag': TAG,
           'containerId': main['Id'], 'mainPid': 1730700, 'mainStartedAt': main['State']['StartedAt'],
           'agentPid': 11604, 'adbPid': 20016, 'sharedAgentReloads': 1, 'mainReloads': 0,
           'windowsPostcheck': {k: v for k, v in win.items() if k != 'agentFiles'},
           'cloudRuntimeFilesVerified': len(hashes), 'cloudChangedFiles': EXPECTED,
           'agentRuntimeFilesVerified': 109, 'agentChangedFiles': {k: v for k, v in win['agentFiles'].items() if old['agentFiles'][k] != v},
           'preservedExternalXhsOverlay': {'scripts/xhs_native_navigation.py': win['agentFiles']['scripts/xhs_native_navigation.py'],
                                          'scripts/xhs_native_window.py': win['agentFiles']['scripts/xhs_native_window.py'],
                                          'scripts/小红书数据同步.py': win['agentFiles']['scripts/小红书数据同步.py']},
           'externalCollectorSourceCommit': None, 'externalCollectorObservedChangeAtUtc': '2026-11-11T06:39:00.5099255Z',
           'health': health, 'mediaVerification': media, 'lookupPreservation': lookup, 'cleanupProofs': proofs,
           'originalFailedRecordsUnchanged': True, 'composeOnlyImageChanged': True, 'nextImageMatchesRunningFiles': True,
           'cps': {'containerId': cps['Id'], 'imageId': cps['Image'], 'startedAt': cps['State']['StartedAt'], 'mode': 'preview',
                   'enabledMembers': ['200', '202'], 'rollbackContainer': 'phone-cloud-cps-wecom-rollback-20261111',
                   'callbackConfigured': True, 'callbackInvoked': False},
           'realInvitations': 0, 'formalCallbacks': 0,
           'tests': {'wecomPython': 634, 'recoveryService': 78, 'recoveryHttp': 1, 'windowsCleanup': 12, 'windowsRecovery': 27,
                     'transportLookupXhs': 54, 'screen': 53, 'rootSyntax': 'passed', 'previousRootFull': {'passed': 2404, 'failed': 3, 'skipped': 3}},
           'notVerified': ['202 new-customer remark/send-page path: authorized test customer is already a contact',
                           'Production invitation and official CPS callback using a new CPS lead',
                           'Source commit for preserved external XHS collector hot overlay',
                           'Previous three baseline UI assertions still fail; not a full green regression'],
           'rollbackDirectory': str(STAGE), 'receiptCommitPending': True}
d = copy.deepcopy(old)
d['previousPreviewRuntimeBaseline'] = {'version': old['version'], 'activeSha256': BEFORE, 'restartImageId': old['restartImageId'], 'receiptDirectory': old.get('receiptDirectory')}
d.update(version=receipt['version'], status='preview_gray_ready_formal_send_pending', atUtc=now, branch=receipt['branch'],
         runtimeCandidateTag=receipt['candidateTag'], runtimeCandidateCommit=CODE, nativeHotPatchTag=receipt['candidateTag'], nativeHotPatchCommit=CODE,
         restartImageId=NEXT, restartImageTag=TAG, agentPid=11604, adbServerPid=20016, windowsPostcheck=receipt['windowsPostcheck'],
         receiptDirectory=str(RECEIPT), receiptDirectoryInRepository='releases/wecom-cps-preview-20261111-deployed.1',
         receiptBindingStatus='pending_receipt_commit', restartedComponents=['Windows Agent once', 'independent CPS bridge'],
         untouchedComponents=['cloud main process', 'ADB server', 'SYSTEM identity/keys/task actions', 'Windows OS', 'USB', 'MediaMTX', 'Postgres', 'Redis', 'XHS batch'],
         userAuthorization='User requested completion with one consolidated shared interruption; two-phone preview only',
         productionAcceptanceComplete=False)
d['cloudRuntimeFiles'] = hashes
d['agentFiles'] = win['agentFiles']
d['activeCompose'].append(str(overlay))
d['hotPatchedRuntimeFiles'].append({'path': 'server/wecom-preinput-recovery.mjs', 'beforeSha256': old['cloudRuntimeFiles']['server/wecom-preinput-recovery.mjs'],
                                    'sha256': EXPECTED['server/wecom-preinput-recovery.mjs'], 'sourceCommit': 'b04b770',
                                    'activation': 'existing same-state same-clock service object; Runtime only; inspector closed', 'nextImageId': NEXT})
d['wecomPreview'] = receipt
assert active.read_bytes() == raw
temporary = active.with_suffix('.json.preview-tmp')
with temporary.open('x') as output:
    json.dump(d, output, ensure_ascii=False, indent=2)
    output.write('\n')
os.replace(temporary, active)
receipt['activeSha256'] = sha(active.read_bytes())
receipt['composeSha256'] = sha(overlay.read_bytes())
(RECEIPT / 'deployment.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'version': receipt['version'], 'activeSha256': receipt['activeSha256'], 'health': health,
                  'lookup': lookup, 'proofs': proofs, 'agentPid': 11604, 'adbPid': 20016}))
