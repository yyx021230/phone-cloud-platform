"""Explicit reviewed fixture only. No shared PG/service or configured DB usage."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
PG = Path('/opt/homebrew/bin/postgres')
INITDB = Path('/opt/homebrew/bin/initdb')
CREATEDB = Path('/opt/homebrew/bin/createdb')
ISREADY = Path('/opt/homebrew/bin/pg_isready')
NODE = Path('/opt/homebrew/bin/node')


def minimal_env():
    return {'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'LC_ALL': 'C', 'LANG': 'C'}


def verify_sources():
    spec = json.loads((HERE / 'RUNNER_SOURCE_HASHES.json').read_text())
    for name, expected in spec['sourceSha256'].items():
        p = (PROJECT / name).resolve()
        if not p.is_relative_to(PROJECT) or hashlib.sha256(p.read_bytes()).hexdigest() != expected:
            raise RuntimeError('fixture_source_hash_changed')
    shared = Path('/Users/yyx/ztqc/phone-cloud-platform/node_modules/pg/package.json')
    if hashlib.sha256(shared.read_bytes()).hexdigest() != spec['sharedPgPackageSha256']:
        raise RuntimeError('fixture_pg_dependency_changed')
    for name, expected in spec['dependencySha256'].items():
        allowed = Path('/Users/yyx/ztqc/phone-cloud-platform/node_modules').resolve()
        p = Path(name).resolve()
        if not p.is_relative_to(allowed) or hashlib.sha256(p.read_bytes()).hexdigest() != expected:
            raise RuntimeError('fixture_pg_dependency_source_changed')
    return spec


def group_exists(pid):
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


def stop_owned_node(process):
    if process is None:
        return {'started': False, 'groupAbsent': True}
    # Only while our Popen child remains unreaped may we signal its new session.
    # That reserves its PID/PGID against reuse. Known-exited groups are never killed.
    if process.returncode is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        time.sleep(0.2)
        if group_exists(process.pid):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait(timeout=5)
    return {'started': True, 'pid': process.pid, 'exitCode': process.returncode, 'groupAbsent': not group_exists(process.pid)}


def execute():
    if os.geteuid() == 0:
        raise RuntimeError('fixture_nonroot_required')
    caps = Path('/proc/self/status')
    if caps.exists():
        fields = dict(line.split(':', 1) for line in caps.read_text().splitlines() if ':' in line)
        if int(fields.get('CapEff', '1').strip(), 16) != 0:
            raise RuntimeError('fixture_no_capabilities_required')
    spec = verify_sources()  # Before any directory, process or socket creation.
    env = minimal_env()
    versions = {}
    for name, binary in [('postgres', PG), ('initdb', INITDB), ('createdb', CREATEDB), ('pg_isready', ISREADY), ('node', NODE)]:
        answer = subprocess.run([str(binary), '--version'], env=env, capture_output=True, timeout=5, check=True)
        value = answer.stdout.decode().strip()
        if name != 'node' and '16.15' not in value:
            raise RuntimeError('fixture_postgres_version_changed')
        if name == 'node' and value != spec['nodeVersion']:
            raise RuntimeError('fixture_node_version_changed')
        versions[name] = value
    root = Path(tempfile.mkdtemp(prefix='pc-wecom-v2-delivery-pg-', dir='/private/tmp')).resolve()
    root.chmod(0o700)
    print(json.dumps({'stage': 'private_fixture_created', 'artifactRoot': str(root)}), flush=True)
    receipt = {'kind': 'owned-loopback-wecom-v2-delivery', 'artifactRoot': str(root), 'versions': versions,
               'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'commands': [],
               'sourceManifestSha256': hashlib.sha256((HERE / 'RUNNER_SOURCE_HASHES.json').read_bytes()).hexdigest()}
    pg = node = None
    passed = False
    pglog = None
    def command(argv, output, timeout=15):
        record = {'argv': [str(v) for v in argv], 'exitCode': None, 'output': output}
        receipt['commands'].append(record)
        process = None
        with (root / output).open('xb') as log:
            try:
                process = subprocess.Popen(record['argv'], cwd=root, env=env, stdin=subprocess.DEVNULL,
                                           stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                record['pid'] = process.pid
                record['exitCode'] = process.wait(timeout=timeout)
            finally:
                record['cleanup'] = stop_owned_node(process)
        if record['exitCode'] != 0 or not record['cleanup']['groupAbsent']:
            raise RuntimeError('fixture_command_failed')
    try:
        db = root / 'db'
        if db.exists():
            raise RuntimeError('fixture_existing_data_directory')
        command([INITDB, '-D', db, '-A', 'trust', '-U', 'wecom_v2_fixture', '--no-locale'], 'INITDB.txt')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
        if port < 20000:
            raise RuntimeError('fixture_port_outside_private_range')
        pglog = (root / 'POSTGRES.txt').open('xb')
        argv = [str(PG), '-D', str(db), '-h', '127.0.0.1', '-p', str(port), '-k', str(root),
                '-c', 'unix_socket_permissions=0700', '-c', 'fsync=on', '-c', 'synchronous_commit=on',
                '-c', 'full_page_writes=on', '-c', 'max_connections=12']
        pg = subprocess.Popen(argv, cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=pglog, stderr=subprocess.STDOUT, start_new_session=True)
        receipt['postgres'] = {'pid': pg.pid, 'argv': argv, 'directOwnedChild': True}
        ready = False
        ready_until = time.monotonic() + 10
        while time.monotonic() < ready_until:
            if pg.poll() is not None:
                raise RuntimeError('fixture_postgres_exited_before_ready')
            # Bootstrap probes use only the socket in our new mode0700 root.
            p = subprocess.run([str(ISREADY), '-h', str(root), '-p', str(port), '-U', 'wecom_v2_fixture', '-d', 'postgres', '-t', '1'],
                               env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
            if p.returncode == 0:
                ready = True; break
            time.sleep(0.1)
        if not ready:
            raise RuntimeError('fixture_postgres_readiness_timeout')
        pid = (db / 'postmaster.pid').read_text().splitlines()
        if int(pid[0]) != pg.pid or pid[1] != str(db) or int(pid[3]) != port or pid[4] != str(root):
            raise RuntimeError('fixture_owned_postmaster_mismatch')
        marker = {'kind': 'owned-loopback-wecom-v2-delivery', 'root': str(root), 'port': port, 'postgresPid': pg.pid}
        (root / 'fixture.json').write_text(json.dumps(marker) + '\n'); (root / 'fixture.json').chmod(0o600)
        command([CREATEDB, '-h', str(root), '-p', str(port), '-U', 'wecom_v2_fixture', 'wecom_v2_host_fixture'], 'CREATEDB.txt')
        print(json.dumps({'stage': 'private_postgres_ready', 'postgresPid': pg.pid, 'port': port}), flush=True)
        node_env = {**env, 'WECOM_V2_FIXTURE_ROOT': str(root), 'WECOM_V2_FIXTURE_PORT': str(port)}
        args = [str(NODE), '--test', '--test-reporter=tap', str(HERE / 'postgres.integration.mjs')]
        record = {'argv': args, 'exitCode': None, 'output': 'NODE_TEST_OUTPUT.txt'}
        receipt['commands'].append(record)
        with (root / 'NODE_TEST_OUTPUT.txt').open('xb') as output:
            node = subprocess.Popen(args, cwd=PROJECT, env=node_env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            record['pid'] = node.pid
            code = node.wait(timeout=45)
            record['exitCode'] = code
        if code != 0:
            raise RuntimeError('fixture_pg_tests_failed')
        if verify_sources() != spec:
            raise RuntimeError('fixture_source_changed_during_run')
        receipt['sourceAfterMatched'] = True
        evidence = json.loads((root / 'PG_EVIDENCE.json').read_text())
        expected_cases = {'delivery-fields','delivery-stale-proposal'}
        if len(evidence['cases']) != 2 or {c['name'] for c in evidence['cases']} != expected_cases or not evidence['server']['privateDataDirectoryMatched']:
            raise RuntimeError('fixture_evidence_incomplete')
        receipt['actualPgCases'] = len(evidence['cases'])
        passed = True
    except BaseException as error:
        receipt['failure'] = {'type': type(error).__name__, 'code': str(error) if isinstance(error, RuntimeError) else 'fixture_execution_failed'}
    finally:
        try:
            receipt['nodeCleanup'] = stop_owned_node(node)
        except BaseException as error:
            receipt['nodeCleanup'] = {'confirmed': False, 'type': type(error).__name__}
        if pg is not None:
            try:
                if pg.returncode is None:
                    pg.send_signal(signal.SIGINT)  # Fast stop this Popen-owned postmaster only.
                    pg.wait(timeout=10)
                receipt['postgresCleanup'] = {'pid': pg.pid, 'exitCode': pg.returncode, 'confirmed': pg.returncode == 0}
            except BaseException as error:
                # No global pg_ctl/pkill or attempt to kill unknown descendants.
                receipt['postgresCleanup'] = {'pid': pg.pid, 'confirmed': False, 'type': type(error).__name__}
        else:
            receipt['postgresCleanup'] = {'started': False, 'confirmed': True}
        if pglog is not None:
            pglog.close()
        clean = receipt['postgresCleanup']['confirmed'] and receipt['nodeCleanup'].get('groupAbsent', False)
        passed = passed and clean
        receipt['status'] = 'passed' if passed else 'failed'
        receipt['dataDirectoryRemoved'] = False
        if passed:
            try:
                shutil.rmtree(root / 'db')
                receipt['dataDirectoryRemoved'] = True
            except BaseException as error:
                passed = False
                receipt['status'] = 'failed'
                receipt['dataRemovalFailure'] = type(error).__name__
        receipt['artifactSha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()
                                     if p.is_file() and p.name != 'RUN_RECEIPT.json'}
        (root / 'RUN_RECEIPT.json').write_text(json.dumps(receipt, indent=2) + '\n'); (root / 'RUN_RECEIPT.json').chmod(0o600)
    print(json.dumps({'status': receipt['status'], 'artifactRoot': str(root), 'actualPgCases': receipt.get('actualPgCases', 0),
                      'nodeCleanup': receipt['nodeCleanup'], 'postgresCleanup': receipt['postgresCleanup'],
                      'dataDirectoryRemoved': receipt['dataDirectoryRemoved']}))
    return 0 if passed else 1


def main(argv):
    if argv != ['--execute-reviewed']:
        print(json.dumps({'status': 'not_started', 'code': 'explicit_reviewed_invocation_required'}))
        return 2
    try:
        return execute()
    except BaseException as error:
        print(json.dumps({'status': 'not_started', 'failureType': type(error).__name__,
                          'code': str(error) if isinstance(error, RuntimeError) else 'fixture_preflight_failed'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
