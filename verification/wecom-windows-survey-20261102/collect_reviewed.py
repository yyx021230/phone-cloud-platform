"""One bounded execution of the two exact reviewed read-only Windows scripts."""
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time

BASE = '20882a65c5787948dc0eb9a30837c5f3a0d32d43'
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
APPROVED = {
    'windows_metadata.ps1': '080d110be479cb1ce62577416480960cd57e566f13fbddceec31274e67081eb0',
    'windows_clock_survey.py': '153c7a6ed6fda7eb1b8a0c910826e14618ad5a495dd6ca78c1047251c317bae7',
}
SSH = ['ssh', '-S', '/private/tmp/pc-lookup-20261102-win.sock', '-o', 'BatchMode=yes',
       '-o', 'ControlMaster=no', 'Administrator@100.100.177.27']


def bounded(command, body=b''):
    start = time.monotonic()
    process = subprocess.Popen(SSH + [command], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    received = {'stdout': bytearray(), 'stderr': bytearray()}
    caps = {'stdout': 16384, 'stderr': 4096}
    selector = selectors.DefaultSelector()
    failure = ''
    try:
        position = 0
        if len(body) > 16384:
            raise ValueError('input_bound_exceeded')
        if body:
            os.set_blocking(process.stdin.fileno(), False)
            selector.register(process.stdin, selectors.EVENT_WRITE, 'stdin')
        else:
            process.stdin.close()
        for name in received:
            pipe = getattr(process, name)
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, name)
        while selector.get_map():
            remaining = 15 - (time.monotonic() - start)
            if remaining <= 0:
                raise TimeoutError('local_wait_timeout')
            for key, _ in selector.select(remaining):
                if key.data == 'stdin':
                    try:
                        position += os.write(key.fileobj.fileno(), body[position:position+4096])
                    except BlockingIOError:
                        continue
                    if position == len(body):
                        selector.unregister(key.fileobj)
                        process.stdin.close()
                    continue
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                received[key.data].extend(chunk)
                if len(received[key.data]) > caps[key.data]:
                    raise ValueError('output_bound_exceeded')
        code = process.wait(timeout=max(.01, 15 - (time.monotonic() - start)))
    except (TimeoutError, subprocess.TimeoutExpired, ValueError, OSError) as error:
        failure = type(error).__name__
        process.kill()  # Only this local owned SSH client, never Windows/shared processes.
        code = process.wait(timeout=2)
    finally:
        selector.close()
        if not process.stdin.closed:
            process.stdin.close()
        process.stdout.close()
        process.stderr.close()
    return received, {'exitCode': code, 'failure': failure,
                      'remoteCompletion': 'unconfirmed' if failure else 'ssh_exit_reported',
                      'elapsedMs': round((time.monotonic() - start) * 1000),
                      'stdoutBytes': len(received['stdout']), 'stderrBytes': len(received['stderr']),
                      'stderrSha256': hashlib.sha256(received['stderr']).hexdigest(),
                      'rawStderrStored': False}


def main():
    if sys.argv[1:] != ['--execute-reviewed-readonly']:
        raise SystemExit('explicit_reviewed_readonly_required')
    paths = ['WINDOWS_METADATA_OBSERVED.json', 'WINDOWS_CLOCK_OBSERVED.json', 'EXECUTION_RECEIPT.json']
    if any((HERE / name).exists() for name in paths):
        raise SystemExit('observation_already_attempted_do_not_retry')
    sources = {}
    for name, expected in APPROVED.items():
        relative = str((HERE / name).relative_to(ROOT))
        value = subprocess.check_output(['git', '-C', str(ROOT), 'show', BASE + ':' + relative])
        if hashlib.sha256(value).hexdigest() != expected:
            raise SystemExit('reviewed_source_hash_mismatch')
        sources[name] = value
    receipt = {'atUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'reviewedCommit': BASE, 'reviewedSourceHashes': APPROVED,
               'steps': [], 'phoneActions': 0, 'adbClientCalls': 0,
               'productionConfigChanges': 0, 'nativeAcceptance': False}
    # Intent is exclusive before any remote command; a failure cannot silently re-run.
    with (HERE / 'EXECUTION_RECEIPT.json').open('x') as file:
        json.dump(receipt, file, indent=2)
    specs = [
        ('metadata', 'windows_metadata.ps1', 'WINDOWS_METADATA_OBSERVED.json',
         'powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ' +
         base64.b64encode(sources['windows_metadata.ps1'].decode('utf8').encode('utf-16le')).decode(), b'',
         {'scope', 'atUtc', 'isSystem', 'version', 'build', 'architecture', 'observedLastBootWallUtc',
          'manufacturer', 'model', 'hypervisorPresent', 'logicalProcessors', 'physicalOrVmProven',
          'clockAuthorityProven', 'nativeExecutionPermitted', 'status', 'errorId'}),
        ('clock', 'windows_clock_survey.py', 'WINDOWS_CLOCK_OBSERVED.json',
         r'D:\PhoneCloud\tools\python39\python.exe -I -B - --observe', sources['windows_clock_survey.py'],
         {'scope', 'authoritySupported', 'nativeExecutionPermitted', 'physicalCleanupVerified', 'pid',
          'sampleLimit', 'executionContext', 'status', 'windowsVersion', 'pointerBits',
          'ownCreationFileTime100ns', 'qpcFrequency', 'adjustmentObservation', 'selectedApis',
          'bootIdentityConfirmed', 'physicalOrVmConfirmed', 'units', 'samples', 'anomalies',
          'limitations', 'failedStage', 'errorType', 'windowsError'}),
    ]
    for stage, source, filename, command, stdin, allowed in specs:
        received, transport = bounded(command, stdin)
        step = {'stage': stage, 'sourceSha256': APPROVED[source], **transport}
        receipt['steps'].append(step)
        if transport['failure'] or transport['exitCode']:
            step['evidence'] = 'unconfirmed_transport'
        else:
            try:
                value = json.loads(received['stdout'].decode('utf-8-sig'))
                if not isinstance(value, dict) or set(value) - allowed:
                    raise ValueError('response_not_whitelisted')
                if value.get('nativeExecutionPermitted') is not False:
                    raise ValueError('unexpected_permission')
                if stage == 'metadata' and (value.get('status') == 'unconfirmed' or value.get('isSystem') is not False):
                    raise ValueError('unexpected_metadata_or_identity')
                if stage == 'clock' and (value.get('status') != 'observed_not_authority'
                                         or value.get('authoritySupported') is not False):
                    raise ValueError('unsupported_clock')
                with (HERE / filename).open('x') as output:
                    output.write(json.dumps(value, indent=2, ensure_ascii=True) + '\n')
                step['evidence'] = 'observed_not_authority'
            except (ValueError, UnicodeError):
                step['evidence'] = 'unconfirmed_response'
        receipt['completedAtUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (HERE / 'EXECUTION_RECEIPT.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(step), flush=True)
        if step['evidence'] != 'observed_not_authority':
            raise SystemExit('stopped_no_retry_no_path_or_identity_change')


if __name__ == '__main__':
    main()
