"""Disposable local-only PostgreSQL, no inherited production connection."""
import os,shutil,socket,subprocess,tempfile
from pathlib import Path
root=Path(tempfile.mkdtemp(prefix='device-retirement-pg-'));started=False
env={'PATH':os.environ.get('PATH',''),'LANG':'C','LC_ALL':'C'}
with socket.socket()as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
try:
 subprocess.run(['initdb','-D',str(root/'db'),'-A','trust','-U','fixture_user','--no-locale'],env=env,stdout=subprocess.DEVNULL,check=True)
 subprocess.run(['pg_ctl','-D',str(root/'db'),'-l',str(root/'log'),'-o',f'-h 127.0.0.1 -p {port} -k {root}','-w','start'],env=env,stdout=subprocess.DEVNULL,check=True);started=True
 subprocess.run(['createdb','-h','127.0.0.1','-p',str(port),'-U','fixture_user','device_retirement_fixture'],env=env,check=True)
 subprocess.run(['node','--test','server/device-retirement.postgres.test.mjs'],cwd=Path(__file__).resolve().parents[2],env={**env,'DEVICE_RETIREMENT_TEST_DATABASE_URL':f'postgresql://fixture_user@127.0.0.1:{port}/device_retirement_fixture'},check=True,timeout=30)
finally:
 if started:subprocess.run(['pg_ctl','-D',str(root/'db'),'-m','fast','-w','stop'],env=env,stdout=subprocess.DEVNULL,check=True)
 shutil.rmtree(root)
