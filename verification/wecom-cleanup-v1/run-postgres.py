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
# macOS PostgreSQL startup requires a valid locale even from a PATH-only caller.
pg_env = {'PATH': os.environ.get('PATH', ''), 'LC_ALL': 'C', 'LANG': 'C'}
root = Path(tempfile.mkdtemp(prefix='pc-wecom-cleanup-pg-'))
started = False
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
try:
    subprocess.run([commands['initdb'], '-D', str(root / 'db'), '-A', 'trust', '-U', 'fixture_user', '--no-locale'], check=True, stdout=subprocess.DEVNULL, env=pg_env)
    try:
        subprocess.run([commands['pg_ctl'], '-D', str(root / 'db'), '-l', str(root / 'log'), '-o', f'-h 127.0.0.1 -p {port} -k {root}', '-w', 'start'], check=True, stdout=subprocess.DEVNULL, env=pg_env)
    except subprocess.CalledProcessError:
        # Print only this disposable cluster's bounded log before finally
        # removes it. The caller's captured output retains the original cause.
        print('FIXTURE_POSTGRES_START_FAILED', flush=True)
        try:
            with (root / 'log').open('rb') as log:
                log.seek(0, os.SEEK_END)
                log.seek(max(0, log.tell() - 65536))
                print(log.read().decode('utf-8', errors='replace'), flush=True)
        except OSError as error:
            print(f'Fixture startup log unavailable: {type(error).__name__}', flush=True)
        raise
    started = True
    for mode, extra in (
        ('structured', {}),
        ('snapshot-only', {'WECOM_CLEANUP_TEST_SNAPSHOT_ONLY': '1'}),
        ('dual-write', {'WECOM_CLEANUP_TEST_TABLE_SYNC': '1'}),
    ):
        subprocess.run([commands['createdb'], '-h', '127.0.0.1', '-p', str(port), '-U', 'fixture_user', 'wecom_cleanup_fixture'], check=True, env=pg_env)
        print('MODE', mode, flush=True)
        env = {**pg_env, 'WECOM_CLEANUP_TEST_DATABASE_URL': f'postgresql://fixture_user@127.0.0.1:{port}/wecom_cleanup_fixture', **extra}
        subprocess.run([commands['node'], '--test', 'server/wecom-physical-cleanup.http.test.mjs'], cwd=project, env=env, check=True, timeout=60)
        subprocess.run([commands['dropdb'], '-h', '127.0.0.1', '-p', str(port), '-U', 'fixture_user', 'wecom_cleanup_fixture'], check=True, env=pg_env)
finally:
    if started:
        subprocess.run([commands['pg_ctl'], '-D', str(root / 'db'), '-m', 'fast', '-w', 'stop'], check=True, stdout=subprocess.DEVNULL, env=pg_env)
    shutil.rmtree(root)
