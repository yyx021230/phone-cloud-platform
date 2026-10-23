"""Inactive candidate build/backups only. No service restarts or phone actions."""
import pathlib,json,subprocess,hashlib,os,sys,copy,fcntl
os.umask(0o077)
root=pathlib.Path('/opt/phone-cloud-platform');stage=pathlib.Path(__file__).resolve().parent
lock=(root/'.deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
run=lambda a:subprocess.check_output(a,text=True).strip()
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
active=json.loads((root/'ACTIVE_PLATFORM_RELEASE.json').read_text());baseline='sha256:7ecf126b7c6b254eb8e8f6c6b16e57bd7fe1927219771894a8b4dcec3a7ba745'
assert active['version']=='lookup-recovery-20261023-deployed.1' and active['imageId']==active['restartImageId']==baseline
assert run(['docker','inspect','phone-cloud-platform','--format','{{.Image}}'])==baseline
assert run(['docker','image','inspect','phone-cloud-platform:lookup-recovery-20261023-rc.6','--format','{{.Id}}'])==baseline
files=json.loads((stage/'PRODUCTION_DIFF.json').read_text())
code="const fs=require('fs'),c=require('crypto');for(const[f,h]of Object.entries("+json.dumps(files)+")){const p='/app/'+f;const a=fs.existsSync(p)?c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null;if(a!==h.before)throw Error('baseline drift: '+f)}"
run(['docker','exec','phone-cloud-platform','node','-e',code])
media=json.loads(run(['/tmp/phonecloud-node-v22.22.3-linux-x64/node-v22.22.3-linux-x64/bin/node',str(root/'deploy/mediamtx-pacing/verify.mjs'),'--live']));assert media['verified']=='live'
args=['docker','compose','-p','phone-cloud-platform']
for row in active['activeCompose']:
 assert sha(row['path'])==row['sha256'];args+=['-f',row['path']]
backup=stage/'rollback';backup.mkdir(mode=0o700,exist_ok=False)
(backup/'ACTIVE_PLATFORM_RELEASE.json').write_bytes((root/'ACTIVE_PLATFORM_RELEASE.json').read_bytes())
for f in files:
 if (root/f).exists():
  target=backup/'source'/f;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((root/f).read_bytes())
pending={'services':{'phone-cloud':{'image':'phone-cloud-platform:lookup-probe-ai-20261023-rc.1'}}}
(stage/'compose.pending.json').write_text(json.dumps(pending,indent=2)+'\n')
old=json.loads(run(args+['config','--format','json']));new=json.loads(run(args+['-f',str(stage/'compose.pending.json'),'config','--format','json']))
expected=copy.deepcopy(old);svc=expected['services']['phone-cloud'];svc['image']=pending['services']['phone-cloud']['image'];assert new==expected,'compose changes out of scope'
(backup/'compose-baseline.json').write_text(json.dumps(active['activeCompose'],indent=2)+'\n')
pg=dict(x.split('=',1) for x in json.loads(run(['docker','inspect','phone-cloud-postgres','--format','{{json .Config.Env}}'])) if '=' in x)
with open(backup/'database.dump','wb') as out:subprocess.run(['docker','exec','phone-cloud-postgres','pg_dump','-U',pg.get('POSTGRES_USER','postgres'),'-d',pg.get('POSTGRES_DB','postgres'),'-Fc'],stdout=out,check=True)
with open(backup/'database.dump','rb') as inp:subprocess.run(['docker','exec','-i','phone-cloud-postgres','pg_restore','--list'],stdin=inp,stdout=subprocess.DEVNULL,check=True)
with open(backup/'previous-image.tar.gz','wb') as out:
 p=subprocess.Popen(['docker','image','save',baseline],stdout=subprocess.PIPE);g=subprocess.run(['gzip','-1'],stdin=p.stdout,stdout=out);p.stdout.close();assert p.wait()==0 and g.returncode==0
for p in backup.rglob('*'):
 if p.is_file():p.chmod(0o600)
with open(stage/'build.log','w') as log:subprocess.run(['nice','-n','10','docker','build','--pull=false','-t','phone-cloud-platform:lookup-probe-ai-20261023-rc.1',str(stage)],stdout=log,stderr=subprocess.STDOUT,check=True)
subprocess.run([sys.executable,str(stage/'complete-preparation.py')],check=True)
