"""Run the HTTP scenario with a fresh loopback PostgreSQL; never production."""
from pathlib import Path
import argparse, os, socket, subprocess, tempfile

p = argparse.ArgumentParser()
p.add_argument('--runtime', required=True, help='Assembled candidate runtime')
p.add_argument('--pg-bin', required=True, help='Directory containing initdb, pg_ctl and psql')
a = p.parse_args()
runtime = Path(a.runtime).resolve()
binary = Path(a.pg_bin).resolve()
root = Path(tempfile.mkdtemp(prefix='lookup-recovery-pg-'))
sock = socket.socket()
sock.bind(('127.0.0.1', 0))
port = sock.getsockname()[1]
sock.close()
env = {'PATH': os.environ['PATH'], 'HOME': os.environ['HOME'], 'LC_ALL': 'C'}
started = False
with (root / 'setup.log').open('w') as log:
    try:
        subprocess.run([str(binary / 'initdb'), '-D', str(root / 'data'), '-A', 'trust', '-E', 'UTF8', '--no-locale', '-U', 'lookup_test'], env=env, stdout=log, stderr=log, check=True)
        subprocess.run([str(binary / 'pg_ctl'), '-D', str(root / 'data'), '-l', str(root / 'postgres.log'), '-o', f'-h 127.0.0.1 -p {port} -k {root}', '-w', 'start'], env=env, stdout=log, stderr=log, check=True)
        started = True
        url = f'postgresql://lookup_test@127.0.0.1:{port}/postgres'
        # index.mjs initializes the authoritative structured tables itself.
        for name in ['20261013-managed-lookup.sql', '20261013-managed-lookup-async.sql']:
            subprocess.run([str(binary / 'psql'), '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', str(runtime / 'deploy/sql' / name)], env=env, stdout=log, stderr=log, check=True)
        subprocess.run(['node', str(runtime / 'verification/recovery-http-device-reprobe50.mjs')], cwd=runtime, env={**env, 'MANAGED_LOOKUP_TEST_DATABASE_URL': url}, check=True)
    finally:
        if started:
            subprocess.run([str(binary / 'pg_ctl'), '-D', str(root / 'data'), '-m', 'fast', '-w', 'stop'], env=env, stdout=log, stderr=log, check=True)
