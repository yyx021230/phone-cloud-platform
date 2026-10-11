#!/usr/bin/env python3
"""Rebuild the deployed source union and test offline without production credentials."""
from pathlib import Path
import argparse,datetime,hashlib,io,json,os,shutil,subprocess,tarfile,tempfile

package=Path(__file__).resolve().parent
repo=package.parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--workspace',type=Path,required=True,help='Existing local dependency workspace')
args=parser.parse_args()
base=Path(tempfile.mkdtemp(prefix='phone-cloud-postdeploy-verification-'))
base.chmod(0o700)
manifest=json.loads((package/'MANIFEST.json').read_text())

def archive(tag,prefix,destination):
    blob=subprocess.check_output(['git','archive',tag,prefix],cwd=repo)
    with tarfile.open(fileobj=io.BytesIO(blob)) as t:
        for item in t.getmembers():
            if not item.isfile():continue
            assert item.name.startswith(prefix+'/')
            relative=item.name[len(prefix)+1:]
            assert '..' not in Path(relative).parts
            p=destination/relative;p.parent.mkdir(parents=True,exist_ok=True)
            p.write_bytes(t.extractfile(item).read())

v=base/'candidate';v.mkdir()
archive(manifest['sourceTag'],'releases/platform-api-docs-20261010-rc.1',v)
for folder in ['fixtures','tests']:
    shutil.copytree(v/'verification'/folder,v,dirs_exist_ok=True)
for tag,folder,names in [
    (manifest['metadataTag'],'releases/platform-update-20261012-rc.3',['public/api-docs.html','public/api-reference.json','public/openapi.json']),
    (manifest['entryTag'],'releases/platform-api-entry-20261012-rc.1',['public/index.html','public/styles.css'])]:
    for name in names:
        (v/name).write_bytes(subprocess.check_output(['git','show',tag+':'+folder+'/'+name],cwd=repo))
for relative in ['node_modules','windows-agent/node_modules']:
    dependency=args.workspace.resolve()/relative
    if not dependency.is_dir():raise SystemExit('Missing existing dependency directory: '+relative)
    (v/relative).symlink_to(dependency)
receipt=json.loads((repo/'releases/platform-api-entry-20261012-rc.1/FILE_HASHES.json').read_text())
for row in receipt['runtimeFiles']:
    assert hashlib.sha256((v/row['path']).read_bytes()).hexdigest()==row['afterSha256'],row['path']
for row in receipt['frozenFiles']:
    assert hashlib.sha256((v/row['path']).read_bytes()).hexdigest()==row['sha256'],row['path']
test=v/'screen-client/screen-ui.test.mjs'
assert hashlib.sha256(test.read_bytes()).hexdigest()==manifest['screenTestBeforeSha256']
replacement=package/'screen-client/screen-ui.test.mjs'
assert hashlib.sha256(replacement.read_bytes()).hexdigest()==manifest['screenTestAfterSha256']
test.write_bytes(replacement.read_bytes())

def api_fixture(name,published):
    api=base/name
    for folder in ['scripts','docs']:(api/folder).mkdir(parents=True,exist_ok=True)
    for filename in ['build-api-docs.py','api-docs.test.mjs']:
        shutil.copyfile(repo/'scripts'/filename,api/'scripts'/filename)
    shutil.copyfile(repo/'docs/api-reference-contracts.json',api/'docs/api-reference-contracts.json')
    shutil.copyfile(package/'publication.json' if published else repo/'docs/platform-api-publication.json',api/'docs/platform-api-publication.json')
    dest=api/'releases/platform-api-docs-20261010-rc.1'
    if published:
        shutil.copytree(v,dest,symlinks=True,ignore=shutil.ignore_patterns('node_modules','data','logs','__pycache__'))
    else:archive(manifest['sourceTag'],'releases/platform-api-docs-20261010-rc.1',dest)
    archive('lookup-20261010-rc.2','releases/lookup-20261010-rc.2',api/'releases/lookup-20261010-rc.2')
    return api

published=api_fixture('published-api',True)
local=api_fixture('local-api',False)
policy=base/'loopback.sb'
policy.write_text('(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-bind (local ip "localhost:*"))\n')
env={k:os.environ[k] for k in ['PATH','HOME','TMPDIR','LANG','LC_ALL'] if k in os.environ}
env.update(NO_PROXY='127.0.0.1,localhost',PYTHONDONTWRITEBYTECODE='1')
commands=[
    ('syntax',v,['npm','run','check']),
    ('screen',v,['npm','run','test:screen']),
    ('agent',v/'windows-agent',['npm','run','check']),
    ('python',v,['python3','-m','unittest','discover','-s','windows-agent/scripts','-p','automation_runners_test.py']),
    ('lookup',v,['python3','-m','unittest','discover','-s','windows-agent/scripts','-p','test_lookup_*.py']),
    ('sdk-node',v,['node','--test','sdk/open_name_lookup/node_client.test.mjs']),
    ('sdk-python',v,['python3','-m','unittest','sdk.open_name_lookup.python_client_test']),
    ('published-api',published,['node','--test','scripts/api-docs.test.mjs']),
    ('local-api',local,['node','--test','scripts/api-docs.test.mjs']),
    ('smoke',v,['node','scripts/smoke-platform.mjs'])]
rows=[]
for label,cwd,cmd in commands:
    log=base/(label+'.log');start=datetime.datetime.now(datetime.timezone.utc)
    with log.open('w') as f:
        log.chmod(0o600)
        try:
            r=subprocess.run(['/usr/bin/sandbox-exec','-f',str(policy)]+cmd,cwd=cwd,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=300)
            code=r.returncode
        except subprocess.TimeoutExpired:code=124
    rows.append({'check':label,'exitCode':code,'seconds':round((datetime.datetime.now(datetime.timezone.utc)-start).total_seconds(),2),'logSha256':hashlib.sha256(log.read_bytes()).hexdigest()})
    result={'sourceTags':[manifest['sourceTag'],manifest['metadataTag'],manifest['entryTag']],'runtimeHashesVerified':len(receipt['runtimeFiles'])+len(receipt['frozenFiles']),'loopbackNetworkOnly':True,'realCredentials':False,'productionDb':False,'checks':rows}
    (base/'RESULTS.json').write_text(json.dumps(result,indent=2)+'\n')
    print(label+': '+('PASS' if code==0 else 'FAIL '+str(code)),flush=True)
print('Private evidence: '+str(base),flush=True)
raise SystemExit(int(any(r['exitCode'] for r in rows)))
