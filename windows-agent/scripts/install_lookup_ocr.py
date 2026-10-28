"""Offline OCR venv preparation. Never changes the existing Airtest environment.

Run using the intended Windows base Python with --wheel-dir and --lock-file.
The target must be a new directory; an existing runtime is never overwritten.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import venv


def verify_wheels(folder, lock):
    rows=[]
    for line in lock.read_text().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        requirement, digest = line.strip().split(' --hash=sha256:')
        name, version = requirement.split('==')
        matches=[p for p in folder.glob('*.whl') if p.name.lower().startswith(name.replace('-','_').lower()+'-'+version+'-')]
        if len(matches)!=1 or hashlib.sha256(matches[0].read_bytes()).hexdigest()!=digest:
            raise ValueError('ocr_wheel_hash_mismatch:'+name)
        rows.append(name)
    if len(rows)!=len(set(rows)) or not {'rapidocr-onnxruntime','onnxruntime','opencv-python','numpy'}.issubset({n.lower() for n in rows}):
        raise ValueError('ocr_wheel_lock_incomplete')
    return rows


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--wheel-dir',type=Path,required=True);parser.add_argument('--lock-file',type=Path,required=True)
    parser.add_argument('--target',type=Path,default=Path(__file__).resolve().parent.parent/'runtime'/'lookup-ocr')
    parser.add_argument('--verify-only',action='store_true');args=parser.parse_args()
    packages=verify_wheels(args.wheel_dir,args.lock_file)
    if args.verify_only:
        print(json.dumps({'wheelHashesVerified':len(packages),'installed':False}));return
    if os.name!='nt' or sys.version_info[:2]!=(3,9) or sys.maxsize<=2**32:
        raise RuntimeError('requires_windows_amd64_python39')
    target=args.target.resolve()
    if target.exists():raise RuntimeError('ocr_target_exists_refuse_overwrite')
    venv.EnvBuilder(with_pip=True,system_site_packages=False).create(target)
    python=target/'Scripts'/'python.exe'
    subprocess.run([str(python),'-m','pip','--isolated','install','--no-index','--find-links',str(args.wheel_dir.resolve()),'--require-hashes','--only-binary=:all:','-r',str(args.lock_file.resolve())],check=True)
    subprocess.run([str(python),'-m','pip','check'],check=True)
    subprocess.run([str(python),'-I','-c',"import sys,importlib.util;assert sys.prefix!=sys.base_prefix;assert importlib.util.find_spec('airtest') is None"],check=True)
    subprocess.run([str(python),'-I',str(Path(__file__).with_name('lookup_ocr_worker.py')),'--verify-runtime'],check=True,timeout=30)
    (target/'PHONE_CLOUD_OCR_READY.json').write_text(json.dumps({'schema':1,'python':sys.version.split()[0],'lockSha256':hashlib.sha256(args.lock_file.read_bytes()).hexdigest(),'isolated':True,'syntheticInferencePassed':True},indent=2)+'\n')
    print(json.dumps({'prepared':True,'existingAirtestModified':False}))


if __name__=='__main__':main()
