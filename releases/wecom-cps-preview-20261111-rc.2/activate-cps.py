"""Enable two preview members using the pre-created independent CPS container."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.request import Request, urlopen

stage = Path('/opt/phone-cloud-staging/wecom-cps-preview-20261111-rc.2')
live_env = Path('/opt/phone-cloud-staging/wecom-cps-rc3-20261110/bridge.env')
assert Path('/run/phone-cloud-cps-rc3-maintenance.flag').is_file(), 'admission_gate_required'
proof = json.loads((stage / 'agent-applied.json').read_text(encoding='utf-8-sig'))
assert proof['applied'] is True and proof['agentPidAfter'] != 15224 and proof['adb']['pid'] == 20016
assert proof['indexAfter'] == '8a94d6a5ce8e3d26eb9513e38a49163b74f80271ddf5952cb98423139911a871'
assert (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(proof['completedAtUtc'].replace('Z', '+00:00'))).total_seconds() < 600


def inspect(name):
    return json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]


old = inspect('phone-cloud-cps-wecom')
new = inspect('phone-cloud-cps-wecom-candidate-20261111')
assert old['Id'] == 'd0c3977f97d63875b786f052e0f421ab255de0d8dee148aa06678b02f7fc6d48'
assert new['Id'] == '13de64066b3d0cd2a5d92e0355b421153ff4328de6ee93406352cd59c9fe97a4'
assert new['State']['Status'] == 'created' and old['Image'] == new['Image']
before = (stage / 'bridge.before.env').read_bytes()
after = (stage / 'bridge.candidate.env').read_bytes()
assert live_env.read_bytes() == before
previous = dict(s.split('=', 1) for s in old['Config']['Env'])
candidate = dict(s.split('=', 1) for s in new['Config']['Env'])
assert [k for k in set(previous) | set(candidate) if previous.get(k) != candidate.get(k)] == ['CPS_WECOM_CLIENTS_JSON']
assert candidate['CPS_EXECUTION_MODE'] == 'preview'
rows = json.loads(candidate['CPS_WECOM_CLIENTS_JSON'])
assert len(rows) == 1 and sorted(m['deviceNumber'] for m in rows[0]['members']) == ['200', '202']
assert all(m['enabled'] is True and m['bindingVerified'] is True for m in rows[0]['members'])
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
subprocess.run(['docker', 'stop', '-t', '10', 'phone-cloud-cps-wecom'], check=True, timeout=15, stdout=subprocess.DEVNULL)
subprocess.run(['docker', 'rename', 'phone-cloud-cps-wecom', 'phone-cloud-cps-wecom-rollback-20261111'], check=True)
subprocess.run(['docker', 'rename', 'phone-cloud-cps-wecom-candidate-20261111', 'phone-cloud-cps-wecom'], check=True)
subprocess.run(['docker', 'start', 'phone-cloud-cps-wecom'], check=True, stdout=subprocess.DEVNULL)
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    try:
        request = Request('http://127.0.0.1:8797/healthz')
        with urlopen(request, timeout=2) as response:
            assert response.status == 200
        break
    except Exception:
        time.sleep(.5)
else:
    raise SystemExit('new_cps_not_ready; rollback container preserved; do not open admission')
temporary = live_env.with_suffix('.env.wecom-preview-new')
with temporary.open('xb') as output:
    os.fchmod(output.fileno(), 0o600)
    output.write(after)
assert live_env.read_bytes() == before
os.replace(temporary, live_env)
result = {'activatedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'startedAtUtc': started,
          'containerBefore': old['Id'], 'containerAfter': new['Id'], 'imageUnchanged': old['Image'],
          'mode': 'preview', 'membersEnabled': ['200', '202'], 'ledgerStateKeyUnchanged': previous['CPS_STATE_KEY'],
          'envBeforeSha256': hashlib.sha256(before).hexdigest(), 'envAfterSha256': hashlib.sha256(after).hexdigest(),
          'cloudMainRestarted': False, 'rollbackContainer': 'phone-cloud-cps-wecom-rollback-20261111'}
(stage / 'cps-activated.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
