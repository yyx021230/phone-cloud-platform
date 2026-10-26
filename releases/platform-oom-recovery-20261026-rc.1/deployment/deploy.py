"""Emergency cloud-only recovery. No database migration, Agent or ADB commands."""
import pathlib, json, hashlib, subprocess, os, sys, time, fcntl, copy
os.umask(0o077)
root = pathlib.Path('/opt/phone-cloud-platform')
stage = pathlib.Path(__file__).resolve().parent
lock = (root/'.deployment.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
run = lambda args: subprocess.check_output(args, text=True).strip()
def sha(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()
manifest = json.loads((stage/'MANIFEST.json').read_text())
active_path = root/'ACTIVE_PLATFORM_RELEASE.json'
raw = active_path.read_bytes()
active = json.loads(raw)
assert active['version'] == manifest['baseRelease']
assert active['imageId'] == active['restartImageId'] == manifest['baseImage']
assert raw == (stage/'rollback/ACTIVE_PLATFORM_RELEASE.json').read_bytes()
args = ['docker', 'compose', '-p', 'phone-cloud-platform']
for row in active['activeCompose']:
    assert sha(row['path']) == row['sha256']
    args += ['-f', row['path']]
media_cmd = ['/tmp/phonecloud-node-v22.22.3-linux-x64/node-v22.22.3-linux-x64/bin/node', str(root/'deploy/mediamtx-pacing/verify.mjs'), '--live']
tag = 'phone-cloud-platform:oom-recovery-20261026-rc1'
pending = stage/'compose.pending.json'
if sys.argv[1] == 'prepare':
    container = json.loads(run(['docker', 'inspect', 'phone-cloud-platform']))[0]
    assert container['Image'] == manifest['baseImage'] and not container['State']['Running']
    backup = json.loads((stage/'BACKUP.json').read_text())
    assert sha(stage/'rollback/database.dump') == backup['sha256']
    with (stage/'rollback/database.dump').open('rb') as f:
        subprocess.run(['docker','exec','-i','phone-cloud-postgres','pg_restore','--list'], stdin=f, stdout=subprocess.DEVNULL, check=True)
    for name, hashes in manifest['files'].items():
        assert sha(stage/'payload'/name) == hashes['after']
        if hashes['before'] is not None:
            dest = stage/'rollback/runtime'/name
            dest.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(['docker','cp','phone-cloud-platform:/app/'+name,str(dest)],check=True,stdout=subprocess.DEVNULL)
            assert sha(dest) == hashes['before']
    assert run(['docker','image','inspect','phone-cloud-platform:lookup-final-20261023-rc.1','--format','{{.Id}}']) == manifest['baseImage']
    media = json.loads(run(media_cmd)); assert media['verified'] == 'live'
    (stage/'Dockerfile').write_text('FROM phone-cloud-platform:lookup-final-20261023-rc.1\nCOPY payload/ /app/\n')
    with (stage/'build.log').open('w') as log:
        subprocess.run(['docker','build','--pull=false','-t',tag,str(stage)],stdout=log,stderr=subprocess.STDOUT,check=True)
    image = run(['docker','image','inspect',tag,'--format','{{.Id}}'])
    code = "const fs=require('fs'),c=require('crypto');for(const[f,h]of Object.entries("+json.dumps(manifest['files'])+")){if(c.createHash('sha256').update(fs.readFileSync('/app/'+f)).digest('hex')!==h.after)throw Error(f)}"
    run(['docker','run','--rm','--network','none','--entrypoint','node',tag,'-e',code])
    run(['docker','run','--rm','--network','none','--entrypoint','node',tag,'--check','/app/server/index.mjs'])
    run(['docker','run','--rm','--network','none','--entrypoint','node',tag,'--input-type=module','-e',"await import('/app/server/snapshot-copy.mjs')"])
    pending.write_text(json.dumps({'services':{'phone-cloud':{'image':tag}}},indent=2)+'\n')
    old=json.loads(run(args+['config','--format','json']))
    new=json.loads(run(args+['-f',str(pending),'config','--format','json']))
    expected=copy.deepcopy(old);expected['services']['phone-cloud']['image']=tag;assert new==expected
    out={'status':'prepared','sourceCommit':(stage/'SOURCE_COMMIT').read_text().strip(),'imageId':image,'imageTag':tag,'baseImage':manifest['baseImage'],'media':media,'backup':backup,'activeSha256':sha(active_path)}
    (stage/'PREPARED.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
elif sys.argv[1] == 'activate':
    prep=json.loads((stage/'PREPARED.json').read_text())
    assert sha(active_path)==prep['activeSha256']
    c=json.loads(run(['docker','inspect','phone-cloud-platform']))[0]
    assert c['Image']==manifest['baseImage'] and not c['State']['Running']
    assert json.loads(run(media_cmd))==prep['media']
    (stage/'ACTIVATION_STARTED.json').write_text(json.dumps({'atUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'authorization':'User requested urgent OOM recovery following explicit deployment request; only stopped failed cloud service is replaced'},indent=2)+'\n')
    subprocess.run(args+['-f',str(pending),'up','-d','--no-deps','--pull','never','phone-cloud'],check=True,cwd=root,timeout=60)
    print('Candidate started; health and resource acceptance pending')
else:
    raise RuntimeError('Expected prepare or activate')
