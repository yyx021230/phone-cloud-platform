"""Operator-side CPS preview client. Credentials stay in memory; no invitation."""
import getpass
import hashlib
import json
import re
import subprocess
import sys
import time
import uuid
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


container = json.loads(subprocess.check_output(['docker', 'inspect', 'phone-cloud-cps-wecom']))[0]
env = dict(s.split('=', 1) for s in container['Config']['Env'])
assert env['CPS_EXECUTION_MODE'] == 'preview', 'not_preview_mode'
clients = json.loads(env['CPS_WECOM_CLIENTS_JSON'])
assert len(clients) == 1
client = clients[0]
database = urlsplit(env['CPS_DATABASE_URL']).path.lstrip('/')
assert re.fullmatch(r'[A-Za-z0-9_]+', database)
state_key = env.get('CPS_STATE_KEY', 'default')
assert re.fullmatch(r'[A-Za-z0-9_-]{1,160}', state_key)


def signed(route, fields):
    body = dict(fields, app_id=client['appId'], timestamp=int(time.time() * 1000), nonce=uuid.uuid4().hex)
    value = lambda x: str(x).lower() if isinstance(x, bool) else str(x)
    signing = '&'.join(k + '=' + value(body[k]) for k in sorted(body)) + '&secret=' + client['secret']
    body['sign'] = hashlib.sha256(signing.encode()).hexdigest()
    request = Request('http://47.98.127.132' + route, data=json.dumps(body).encode(),
                      headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST')
    with build_opener(NoRedirect).open(request, timeout=15) as response:
        payload = json.loads(response.read(2 * 1024 * 1024))
        print('PUBLIC_HTTP', response.status, route)
    return payload


def query(db, sql):
    raw = subprocess.check_output(['docker', 'exec', '-i', 'phone-cloud-postgres', 'psql', '-X', '-qAt',
                                  '-U', 'phone_cloud', '-d', db, '-v', 'ON_ERROR_STOP=1'],
                                 input="BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; " + sql + '; COMMIT;',
                                 text=True, timeout=6).strip()
    return json.loads(raw)


mode = sys.argv[1]
if mode == 'inventory':
    response = signed('/api/v1/lead/devices/query', {'online_only': False})
    assert response['success'] is True
    devices = response['result']['devices']
    selected = [d for d in devices if str(d.get('device_number')) in ('200', '202')]
    assert len(selected) == 2
    for device in selected:
        expected = [m for m in client['members'] if m['deviceNumber'] == device['device_number']]
        assert len(expected) == 1 and len(device['accounts']) == 1
        assert device['accounts'][0]['wecom_phone'] == expected[0]['wecom_phone']
        # Reports retain state, not the credential or full account phone.
        device['accounts'][0].pop('wecom_phone')
    print(json.dumps({'total': len(devices), 'devices': selected, 'capacity': response['result']['capacity'],
                      'updated_at': response['result']['updated_at']}, ensure_ascii=False))
elif mode in ('submit', 'repeat'):
    device, lead = sys.argv[2:4]
    assert device in ('200', '202') and re.fullmatch(r'[1-9]\d{0,18}', lead) and int(lead) <= 9223372036854775807
    target = next(m for m in client['members'] if m['deviceNumber'] == device)
    assert target['enabled'] is True and target['bindingVerified'] is True
    phone = getpass.getpass('Authorized customer phone (not logged): ')
    assert re.fullmatch(r'1[3-9]\d{9}', phone)
    response = signed('/api/v1/lead/dispatch', {'lead_id': int(lead), 'phone': phone, 'wecom_phone': target['wecom_phone']})
    print(json.dumps({'device': device, 'lead_id': lead, 'response': response}, ensure_ascii=False))
elif mode == 'status':
    lead = sys.argv[2]
    assert re.fullmatch(r'[1-9]\d{0,18}', lead)
    rows = query(database, "SELECT coalesce(jsonb_agg(jsonb_build_object('leadId',q->>'leadId','stage',q->>'stage','error',q->>'error','jobId',q->>'jobId','requestId',q->>'requestId','attempts',q->'attempts','outcome',q->'outcome')),'[]'::jsonb) FROM phone_cloud_cps_wecom s CROSS JOIN LATERAL jsonb_array_elements(s.data->'leads') q WHERE s.state_key='" + state_key + "' AND q->>'leadId'='" + lead + "'")
    print('CPS_LEAD', json.dumps(rows, ensure_ascii=False))
    assert len(rows) <= 1
    if rows and rows[0]['jobId']:
        job_id = rows[0]['jobId']
        assert re.fullmatch(r'[a-f0-9-]{36}', job_id)
        job = query('phone_cloud', "SELECT jsonb_build_object('jobId',job_id,'status',status,'windowsTaskId',data->>'windowsTaskId','lockId',data->>'lockId','previewStatus',data->'result'->'previewStatus','previewCode',data->'result'->'previewCode','remarkPhoneSet',data->'result'->'remarkPhoneSet','remarkSaveStatus',data->'result'->'remarkSaveStatus','sendStatus',data->'result'->'sendStatus','invitationSent',data->'result'->'invitationSent','execution',data->'result'->'diagnostic'->'wecomExecution') FROM phone_cloud_automation_jobs WHERE job_id='" + job_id + "'")
        print('PLATFORM_JOB', json.dumps(job, ensure_ascii=False))
else:
    raise SystemExit('invalid_operator_action')
