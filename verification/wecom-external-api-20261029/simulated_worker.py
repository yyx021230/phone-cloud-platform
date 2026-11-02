"""Loopback-only synthetic UI worker for external API acceptance; never ADB.

Executes the real remark/preview/send algorithms against existing synthetic
Poco fixtures. The production Windows host/startup adapter is NOT executed.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import replace
import wecom_invite_preview as w
import wecom_remark_preview as r
import wecom_customer_invitation as invite
from test_wecom_invite_preview import PHONE, Poco
from test_wecom_remark_preview import scenario, remark


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


def execute(config):
    url = urllib.parse.urlsplit(config['serverBaseUrl'])
    if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost') or url.username or url.password:
        raise ValueError('simulation_requires_loopback')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', config['taskId']):
        raise ValueError('invalid_simulation_task')
    directory = Path(config['claimDirectory']).parent / 'simulation'
    directory.mkdir(parents=True, exist_ok=True)
    record_path = directory / (config['taskId'] + '.json')
    control = directory / (config['taskId'] + '.release')
    deadline = time.monotonic() + 15
    name, description = r.validate_remark_input(config)
    remark_hash = hashlib.sha256(json.dumps([name, description], ensure_ascii=False, separators=(',', ':')).encode('utf8')).hexdigest()
    operation = hashlib.sha256(json.dumps(['send', remark_hash, config['phoneNumber'], config['deviceId'], config['androidUser']], separators=(',', ':')).encode('utf8')).hexdigest()
    record = dict(taskId=config['taskId'], deviceNumber=config['deviceNumber'], appSlot=config['appSlot'],
                  androidUser=config['androidUser'], claimCalls=0, searchCalls=0, saveCalls=0, sendCalls=0)
    def save_record(): record_path.write_text(json.dumps(record), encoding='utf8')
    def budget():
        if time.monotonic() >= deadline: raise w.StopPreview('simulation_budget_exhausted')
    def call(suffix, post=False):
        budget()
        endpoint = config['serverBaseUrl'].rstrip('/') + '/api/v1/windows-agents/' + config['agentId'] + '/wecom-preview-tasks/' + config['taskId'] + '/' + suffix
        request = urllib.request.Request(endpoint, data=b'{}' if post else None,
            headers={'Authorization': 'Bearer ' + config['agentToken'], 'Content-Type': 'application/json'})
        with urllib.request.build_opener(NoRedirect).open(request, timeout=min(3, deadline-time.monotonic())) as response:
            raw = response.read(8193)
        if len(raw) > 8192: raise w.StopPreview('simulation_response_too_large')
        return json.loads(raw)
    def lease():
        proof = call('lease')
        return (proof.get('valid') is True and proof.get('taskId') == config['taskId']
            and proof.get('serial') == config['serial'] and proof.get('deviceId') == config['deviceId']
            and proof.get('appSlot') == config['appSlot'] and proof.get('androidUser') == config['androidUser']
            and proof.get('operationFingerprint') == operation and proof.get('remarkFingerprint') == remark_hash)
    def claim():
        record['atSendBoundary'] = True; save_record()
        if os.environ.get('WECOM_SIM_PAUSE') == 'true':
            while not control.exists():
                budget()
                if not lease(): raise w.StopPreview('device_lease_lost')
                time.sleep(.03)
        invite.claim_local(config['claimDirectory'], config)
        record['localClaimCreated'] = True; record['claimCalls'] += 1
        proof = call('send-claim', post=True)
        confirmed = proof.get('claimed') is True and proof.get('taskId') == config['taskId'] and proof.get('operationFingerprint') == operation
        record['cloudClaimPersisted'] = confirmed; save_record()
        if os.environ.get('WECOM_SIM_LOSE_CLAIM_REPLY') == 'true':
            raise TimeoutError('simulated_claim_reply_lost')
        return confirmed
    pages, actions = scenario('', 'existing-description', requested_name=name)
    pages[6] = remark('old-name', 'existing-description')
    pages = [replace(page, nodes=tuple(replace(node, text=node.text.replace(PHONE, config['phoneNumber'])) for node in page.nodes)) for page in pages]
    class Advancing(Poco):
        def __call__(self, **selector):
            items = super().__call__(**selector)
            for item in items:
                click, write = item.click, item.set_text
                def do_click(original=click):
                    original()
                    if len(self.effects) < len(pages): self.screen = pages[len(self.effects)]
                def do_set(value, original=write):
                    original(value); self.screen = pages[len(self.effects)]
                item.click, item.set_text = do_click, do_set
            return items
    class Driver(invite.InvitationDriverMixin, r.PocoRemarkDriver): pass
    poco = Advancing(pages[0]); driver = Driver(poco, lambda: w.PACKAGE, lease)
    prepared = r.run_customer_preview(driver, {'phoneNumber': config['phoneNumber'], 'remarkName': name, 'description': description}, replace_name=True, sleep=lambda _: None)
    result = invite.send_once(driver, prepared, claim, budget)
    record.update(searchCalls=sum(kind == 'click' and value.startswith('网络查找') for kind, value in poco.effects),
                  saveCalls=sum(kind == 'click' and value == '保存' for kind, value in poco.effects),
                  sendCalls=sum(kind == 'click' and value == w.SEND for kind, value in poco.effects),
                  remarkVerified=result.get('remarkPrepared') is True,
                  status=result.get('status'), code=result.get('code'))
    save_record()
    return dict(previewStatus=result['status'] if result['status'] in ('send_attempted', 'blocked') else 'blocked',
                previewCode=result['code'], invitationSent=result.get('invitationSent', False),
                sendStatus=result.get('sendStatus', 'not_attempted'), remarkSaveStatus=result.get('remarkSaveStatus', 'unknown'))


if __name__ == '__main__':
    try:
        if os.environ.get('WECOM_SIM_PHYSICAL_READY') == '1':
            # Explicit test fixture: real OS identity, synthetic machine ID.
            # This does not bypass or execute the production SYSTEM adapter.
            import datetime
            import psutil
            created = psutil.Process(os.getpid()).create_time()
            host = dict(role='reader', pid=os.getpid(),
                        createdAt=datetime.datetime.fromtimestamp(created, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                        creationToken=created.hex(), machineId='a' * 64)
            print('WECOM_PHYSICAL_READY ' + json.dumps(dict(version=1, hosts=[host])), file=sys.stderr, flush=True)
        output = execute(json.loads(sys.stdin.readline(16385)))
    except Exception:
        output = dict(previewStatus='blocked', previewCode='simulation_worker_error', invitationSent=False, remarkSaveStatus='unknown')
    print(json.dumps(output), flush=True)
