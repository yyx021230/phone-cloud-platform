"""Run one explicitly authorized preview; authorized target is stdin only."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
SOURCE = '32c0091a534aa7f9038deb91aa33f202f72e0e6b'


def main():
    if sys.argv[1:] != ['--accept-preview']:
        raise SystemExit('explicit_preview_flag_required')
    supplied = json.loads(sys.stdin.readline())
    phone = supplied['phoneNumber']
    if not isinstance(phone, str) or len(phone) != 11 or not phone.isdigit() or not phone.endswith('6441'):
        raise SystemExit('authorized_target_required')
    folder = Path('/private/tmp/pc-wecom-api-accept-20261102/attempt-43-main-01')
    folder.mkdir(mode=0o700)
    proof = json.loads(Path('/private/tmp/pc-wecom-api-accept-20261102/PREFLIGHT_WINDOWS.json').read_text(encoding='utf-8-sig'))
    request_id = 'wecom-native-20261102-43-main-' + uuid.uuid4().hex[:12]
    intent = dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(), sourceCommit=SOURCE,
                  deviceNumber='43', appSlot='main', mode='preview', phoneSuffix='6441',
                  requestId=request_id, initialPostBudget=1, sameIdReplayBudget=1,
                  newJobOnUnknownForbidden=True, clientSha256=hashlib.sha256((HERE / 'preview-client.mjs').read_bytes()).hexdigest(),
                  resourceCheckedAt=proof['at'], spareSlots=proof['conservativeSpareSlots'])
    with (folder / 'INTENT.json').open('x') as output:
        output.write(json.dumps(intent, indent=2) + '\n'); output.flush(); os.fsync(output.fileno())
    body = dict(phoneNumber=phone, deviceNumber='43', mode='preview', requestId=request_id,
                resourceCheckedAt=proof['at'], spareSlots=proof['conservativeSpareSlots'])
    command = 'docker exec -i phone-cloud-platform node --input-type=module --eval ' + shlex.quote((HERE / 'preview-client.mjs').read_text()) + ' -- --accept-preview'
    child = subprocess.Popen(['ssh', '-S', '/tmp/pc-root-wecom-accept-cloud-20261102.sock', '-o', 'BatchMode=yes',
                              'root@47.98.127.132', command], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    child.stdin.write((json.dumps(body) + '\n').encode()); child.stdin.close()
    with (folder / 'EVENTS.jsonl').open('x') as output:
        for raw in child.stdout:
            value = json.loads(raw)
            output.write(json.dumps(value, ensure_ascii=False) + '\n'); output.flush()
            print(json.dumps(value, ensure_ascii=False), flush=True)
    code = child.wait(timeout=15)
    stderr = child.stderr.read()
    (folder / 'TRANSPORT.json').write_text(json.dumps({'exitCode': code, 'stderrBytes': len(stderr),
                                                     'originalIntentRetained': True}, indent=2))
    raise SystemExit(code)


if __name__ == '__main__':
    main()
