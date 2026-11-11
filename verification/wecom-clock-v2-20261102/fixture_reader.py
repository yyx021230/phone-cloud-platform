"""OFFLINE fixture: no ADB/SDK/network/SYSTEM assertion or real device facts.

Only its own real OS identity and private stdin/stdout pipe are exercised.
Empty-package/forward readings below are explicitly synthetic delays.
"""
import datetime
import json
import os
import sys
import time
import psutil
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'windows-agent' / 'scripts'))
from wecom_physical_verify import HostRef, verify_empty

def output(value):
    print(json.dumps(value), flush=True)

def line():
    raw = sys.stdin.readline(4097)
    if not raw or len(raw) > 4096:
        raise ValueError('fixture_input_missing')
    return json.loads(raw)

def main():
    if os.environ.get('WECOM_OFFLINE_CLOCK_FIXTURE') != '1':
        raise ValueError('fixture_not_explicit')
    boot = line()
    if set(boot) != {'purpose', 'executionNonce', 'pipeNonce', 'fault'} or boot['purpose'] != 'fixture_bootstrap':
        raise ValueError('fixture_bootstrap_invalid')
    created = psutil.Process(os.getpid()).create_time()
    parent_pid = os.getppid()
    parent_created = psutil.Process(parent_pid).create_time()
    ready = {'kind': 'fixture_ready', 'pid': os.getpid(),
             'createdAt': datetime.datetime.fromtimestamp(created, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
             'creationToken': created.hex(), 'executionNonce': boot['executionNonce'], 'pipeNonce': boot['pipeNonce']}
    if boot['fault'] == 'wrong_pid':
        ready['pid'] += 1
    if boot['fault'] == 'old_nonce':
        ready['pipeNonce'] = 'fixture-old-pipe'
    output(ready)
    if boot['fault'] == 'early_fact':
        output({'kind': 'fixture_fact', 'synthetic': True, 'beforeChallenge': True})
    config = line()
    if config.get('purpose') != 'fixture_challenge':
        raise ValueError('fixture_challenge_missing')
    received = time.monotonic()
    def guard():
        if time.monotonic() - received > 3:
            raise ValueError('fixture_local_facts_expired')
        if (psutil.Process(os.getpid()).ppid() != parent_pid
                or psutil.Process(parent_pid).create_time() != parent_created):
            raise ValueError('fixture_parent_changed')
    host_reads = 0
    reads = 0
    def closed_host_fixture(pid):
        nonlocal host_reads
        host_reads += 1
        if host_reads % 2 == 1:
            output({'kind': 'fixture_fact', 'synthetic': True, 'frame': (host_reads - 1) // 2})
        return None  # Synthetic original host absence, NOT a production PID.
    def empty_read_fixture(*unused):
        nonlocal reads
        guard()
        time.sleep(config['readDelayMs'] / 1000)
        guard()
        reads += 1
        return []  # Explicitly synthetic package/forward facts.
    def guarded_identity():
        guard()
        return True
    # Exercise the unchanged product's actual two-frame sequencing function.
    # No ReadOnlyAdb instance/SDK/socket is created; all IO callbacks are fixtures.
    observations = verify_empty(serial='fixture', hosts=[HostRef(123, 1.0)],
        process_created_at=closed_host_fixture, pids=empty_read_fixture,
        forwards=empty_read_fixture, guard=guarded_identity, check_budget=guard,
        wall_clock=lambda: time.time() + config['wallOffsetMs'] / 1000)
    frames = [{'synthetic': True, 'startedAfterChallengeMs': (frame.captured_at - received) * 1000,
               'wallAuditMs': frame.observed_at * 1000, 'packagesAbsent': True, 'serialForwardCount': 0}
              for frame in observations]
    guard()
    output({'kind': 'fixture_result', 'synthetic': True, 'nonce': config['nonce'], 'epoch': config['epoch'],
            'frames': frames, 'syntheticReadCount': reads})
    # Parent MUST wait for actual OS close; this cost is inside server's age.
    time.sleep(config['closeDelayMs'] / 1000)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Fixed local codes only, no raw config or exception payload.
        code = str(error)
        allowed = {'fixture_input_missing', 'fixture_bootstrap_invalid', 'fixture_challenge_missing',
                   'fixture_local_facts_expired', 'fixture_parent_changed', 'fixture_not_explicit'}
        output({'kind': 'fixture_error', 'code': code if code in allowed else 'fixture_worker_error'})
