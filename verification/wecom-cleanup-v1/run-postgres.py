"""Real disposable loopback PostgreSQL acceptance; never uses a configured DB."""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile

project = Path(__file__).resolve().parents[2]

def binary(name):
    found = shutil.which(name)
    if not found:
        fallback = Path('/opt/homebrew/bin') / name
        if fallback.is_file():
            found = str(fallback)
    if not found:
        raise SystemExit(f'Missing local test dependency: {name}')
    return found

commands = {name: binary(name) for name in ('initdb', 'pg_ctl', 'createdb', 'dropdb', 'node')}
root = Path(tempfile.mkdtemp(prefix='pc-wecom-cleanup-pg-'))
started = False
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
try:
    subprocess.run([commands['initdb'], '-D', str(root / 'db'), '-A', 'trust', '-U', 'fixture_user', '--no-locale'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([commands['pg_ctl'], '-D', str(root / 'db'), '-l', str(root / 'log'), '-o', f'-h 127.0.0.1 -p {port} -k {root}', '-w', 'start'], check=True, stdout=subprocess.DEVNULL)
    started = True
    for mode, extra in (
        ('structured', {}),
        ('snapshot-only', {'WECOM_CLEANUP_TEST_SNAPSHOT_ONLY': '1'}),
        ('dual-write', {'WECOM_CLEANUP_TEST_TABLE_SYNC': '1'}),
    ):
        subprocess.run([commands['createdb'], '-h', '127.0.0.1', '-p', str(port), '-U', 'fixture_user', 'wecom_cleanup_fixture'], check=True)
        print('MODE', mode, flush=True)
        env = {'PATH': os.environ.get('PATH', ''), 'WECOM_CLEANUP_TEST_DATABASE_URL': f'postgresql://fixture_user@127.0.0.1:{port}/wecom_cleanup_fixture', **extra}
        subprocess.run([commands['node'], '--test', 'server/wecom-physical-cleanup.http.test.mjs'], cwd=project, env=env, check=True, timeout=60)
        subprocess.run([commands['dropdb'], '-h', '127.0.0.1', '-p', str(port), '-U', 'fixture_user', 'wecom_cleanup_fixture'], check=True)
finally:
    if started:
        subprocess.run([commands['pg_ctl'], '-D', str(root / 'db'), '-m', 'fast', '-w', 'stop'], check=True, stdout=subprocess.DEVNULL)
    shutil.rmtree(root)
