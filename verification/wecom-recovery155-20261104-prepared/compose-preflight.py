"""Explicit read-only Compose preflight. Never prints or persists credentials."""
import argparse
import copy
import json
import os
import subprocess
from pathlib import Path


def existing_xhs_environment(containers, original, *, project, is_file=os.path.isfile):
    rows=[c for c in containers if c.get('State',{}).get('Running')is True
          and c.get('Config',{}).get('Labels',{}).get('com.docker.compose.service')=='xhs-batch'
          and c['Config']['Labels'].get('com.docker.compose.project')==project]
    if len(rows)!=1:raise ValueError('xhs_existing_container_unconfirmed')
    row=rows[0];mounts=[m for m in row.get('Mounts',[])if m.get('Destination')=='/run/xhs-batch/config.json'
                      and m.get('Type')=='bind'and m.get('RW')is False]
    if len(mounts)!=1 or not is_file(mounts[0]['Source']):raise ValueError('xhs_existing_mount_unconfirmed')
    values=[x.partition('=')[2]for x in row['Config'].get('Env',[])if x.partition('=')[0]=='XHS_BATCH_DATABASE_URL']
    image=row['Config'].get('Image')
    if len(values)!=1 or not values[0]or not isinstance(image,str)or not image:raise ValueError('xhs_existing_environment_unconfirmed')
    # Child-process environment only. No global os.environ assignment or secret
    # file/argv. The existing image, database and private mount stay identical.
    return dict(original,XHS_BATCH_CONFIG_PATH=mounts[0]['Source'],XHS_BATCH_IMAGE=image,XHS_BATCH_DATABASE_URL=values[0])


def preflight(stage):
    root=Path('/opt/phone-cloud-platform');active_path=root/'ACTIVE_PLATFORM_RELEASE.json'
    import hashlib
    raw=active_path.read_bytes();active=json.loads(raw);manifest=json.loads((stage/'manifest.json').read_bytes())
    if hashlib.sha256(raw).hexdigest()!=manifest['baselineActiveSha256']:raise ValueError('active_drift')
    def command(args,**kwargs):return subprocess.check_output(args,text=True,stderr=subprocess.PIPE,timeout=20,**kwargs)
    live=json.loads(command(['docker','inspect','phone-cloud-platform']))[0]
    if live['Image']!=manifest['previousImage']:raise ValueError('live_image_drift')
    project=live['Config']['Labels']['com.docker.compose.project']
    ids=command(['docker','ps','--filter','label=com.docker.compose.service=xhs-batch','--filter','label=com.docker.compose.project='+project,'--format','{{.ID}}']).split()
    if len(ids)!=1:raise ValueError('xhs_existing_container_unconfirmed')
    env=existing_xhs_environment(json.loads(command(['docker','inspect',*ids])),os.environ,project=project)
    args=['docker','compose','-p',project]
    for path,digest in manifest['baselineCompose'].items():
        if hashlib.sha256(Path(path).read_bytes()).hexdigest()!=digest:raise ValueError('compose_file_drift')
        args+=['-f',path]
    old=json.loads(command(args+['config','--format','json'],cwd=root,env=env))
    new=json.loads(command(args+['-f',str(stage/'compose.pending.json'),'config','--format','json'],cwd=root,env=env))
    expected=copy.deepcopy(old);expected['services']['phone-cloud']['image']=manifest['imageTag']
    if new!=expected:raise ValueError('out_of_scope_compose_difference')
    base=json.loads(command(['docker','image','inspect',manifest['previousImage']]))[0]
    convert=lambda rows:dict(x.split('=',1)for x in rows or[])
    predicted=convert(base['Config'].get('Env'));predicted.update({k:str(v)for k,v in old['services']['phone-cloud'].get('environment',{}).items()if v is not None})
    if predicted!=convert(live['Config'].get('Env')):raise ValueError('current_runtime_environment_drift')
    if active_path.read_bytes()!=raw:raise ValueError('active_drift')
    return dict(status='validated_not_activated',composeOnlyImageChanged=True,runtimeEnvironmentMatchesCurrent=True,
                existingXhsReferencesReused=True,credentialValuesPersisted=False,serviceReloaded=False)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--run',action='store_true');parser.add_argument('--stage',type=Path);args=parser.parse_args()
    if not args.run or not args.stage:raise SystemExit('Explicit --run --stage required; no action performed')
    try:print(json.dumps(preflight(args.stage)))
    except Exception:raise SystemExit('Compose read-only preflight failed; no activation or auto-repair')from None
