from pathlib import Path
import argparse,os,shutil,subprocess,sys
p=argparse.ArgumentParser();p.add_argument('--out',required=True);p.add_argument('--node-modules',required=True);p.add_argument('--hold-ms',type=int,default=121000);a=p.parse_args()
if a.hold_ms<121000:p.error('partner timeout acceptance requires at least121000ms')
root=Path(__file__).resolve().parents[2];out=Path(a.out).resolve();deps=Path(a.node_modules).resolve()
assert not out.exists();assert deps.is_dir()
subprocess.run([sys.executable,str(root/'releases/lookup-readiness-20261015-rc.12/verification/prepare-local.py'),'--out',str(out)],check=True)
(out/'node_modules').symlink_to(deps,target_is_directory=True)
shutil.copyfile(Path(__file__).with_name('partner-api-blackbox.mjs'),out/'verification/partner-api-blackbox.mjs')
env={**os.environ,'READINESS_HOLD_MS':str(a.hold_ms),'MANAGED_LOOKUP_TEST_DATABASE_URL':''}
subprocess.run(['node','verification/partner-api-blackbox.mjs'],cwd=out,env=env,check=True)
