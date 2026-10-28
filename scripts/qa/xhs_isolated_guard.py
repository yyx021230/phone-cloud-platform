"""Test-only lease policy. Never rewrites the real Agent inventory or its locks."""
import json
import time
from pathlib import Path


def validate(config, proof, inventory, age, now=None):
    now = time.monotonic() if now is None else now
    required = ('deviceId', 'serial', 'deviceName', 'appSlot', 'xhsId', 'accountName',
                'jobId', 'sessionId', 'lockId', 'ownerUserId')
    if any(not isinstance(config.get(k), str) or not config[k] for k in required):
        raise RuntimeError('qa_binding_incomplete')
    if config['appSlot'] not in ('app1', 'app2') or config['deviceName'] in ('18', '152', '155', '185'):
        raise RuntimeError('qa_target_excluded')
    if not 0 <= age <= 90:
        raise RuntimeError('qa_inventory_stale')
    if (not proof.get('allowed') or not 0 <= now - proof.get('localObservedAt', -100) <= 3
            or not 0 <= proof.get('roundTripSeconds', -1) <= 3
            or not 0 <= proof.get('brokerProofAgeSeconds', -1)
            or not 0 <= (proof.get('brokerProofAgeSeconds', -1) + proof.get('roundTripSeconds', -1)
                         + now - proof.get('localObservedAt', -100)) <= 3):
        raise RuntimeError('qa_lease_not_fresh')
    if any(proof.get(k) != config[k] for k in required):
        raise RuntimeError('qa_lease_identity_changed')
    if proof.get('activeLockCount') != 1 or not proof.get('sessionAlive') or proof.get('lookupReserved'):
        raise RuntimeError('qa_lease_not_exclusive')
    matches = [d for d in inventory if d.get('adb', {}).get('serial', '').lower() == config['serial'].lower()]
    if len(matches) != 1:
        raise RuntimeError('qa_inventory_serial_ambiguous')
    d = matches[0]
    if d.get('deviceId') != config['deviceId'] or str(d.get('deviceName')) != config['deviceName'] or d.get('adb', {}).get('state') != 'device':
        raise RuntimeError('qa_device_identity_or_online_changed')
    occupancy = d.get('occupancy') or {}
    if occupancy.get('kind') != 'screen_control' or occupancy.get('sessionId') != config['sessionId']:
        raise RuntimeError('qa_real_inventory_does_not_show_owned_screen')
    accounts = [a for a in d.get('xhsAccounts', []) if a.get('appSlot') == config['appSlot']]
    if len(accounts) != 1 or not accounts[0].get('enabled') or any(accounts[0].get(k) != config[k] for k in ('xhsId', 'accountName')):
        raise RuntimeError('qa_account_binding_changed')
    return d  # Actual screen occupancy is deliberately preserved.


def validate_file(config, proof):
    p = Path(config['inventoryPath'])
    payload = json.loads(p.read_text(encoding='utf-8-sig'))
    return validate(config, proof, payload if isinstance(payload, list) else payload['devices'], time.time() - p.stat().st_mtime)
