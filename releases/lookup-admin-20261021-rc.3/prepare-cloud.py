#!/usr/bin/env python3
"""Stage/build/backup only. Never activate, retag latest, restart or touch Agent/ADB."""
import pathlib,json,subprocess,hashlib,os,secrets,time,sys
root=pathlib.Path('/opt/phone-cloud-platform');stage=pathlib.Path(__file__).resolve().parent
baseline='sha256:a9e487ecb04afa22def7c926541a06be5593191066652881388d017e54022dab'
def run(args,**kw):return subprocess.check_output(args,text=True,**kw).strip()
active=json.loads((root/'ACTIVE_PLATFORM_RELEASE.json').read_text());assert active['version']=='lookup-scheduling-20261021-deployed.1';assert active['imageId']==baseline and active['restartImageId']==baseline
assert run(['docker','inspect','phone-cloud-platform','--format','{{.Image}}'])==baseline
assert active['lookupSchedulingOverlay']['sourceCommit']=='9d2276884f26e6c436bc4ccd80bb3c8d18be3771'
diff=json.loads((stage/'PRODUCTION_DIFF.json').read_text());cloud={f:v for f,v in diff.items() if f.startswith(('server/','public/'))}
verify="const fs=require('fs'),c=require('crypto');const rows="+json.dumps(cloud)+";for(const [f,h]of Object.entries(rows)){const p='/app/'+f;const actual=fs.existsSync(p)?c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null;if(actual!==h.before)throw Error('baseline drift: '+f);}console.log('cloud hashes verified');"
run(['docker','exec','-i','phone-cloud-platform','node','-e',verify])
media=json.loads(run(['/tmp/phonecloud-node-v22.22.3-linux-x64/node-v22.22.3-linux-x64/bin/node',str(root/'deploy/mediamtx-pacing/verify.mjs'),'--live']));assert media['verified']=='live'
backup=stage/'rollback';backup.mkdir(mode=0o700,exist_ok=False);(backup/'ACTIVE_PLATFORM_RELEASE.json').write_bytes((root/'ACTIVE_PLATFORM_RELEASE.json').read_bytes())
env=json.loads(run(['docker','inspect','phone-cloud-postgres','--format','{{json .Config.Env}}']));pg=dict(x.split('=',1) for x in env if '=' in x)
with open(backup/'database.dump','wb') as out:subprocess.run(['docker','exec','phone-cloud-postgres','pg_dump','-U',pg.get('POSTGRES_USER','postgres'),'-d',pg.get('POSTGRES_DB','postgres'),'-Fc'],stdout=out,check=True)
with open(backup/'database.dump','rb') as source:subprocess.run(['docker','exec','-i','phone-cloud-postgres','pg_restore','--list'],stdin=source,stdout=subprocess.DEVNULL,check=True)
with open(backup/'previous-image.tar.gz','wb') as out:
 p=subprocess.Popen(['docker','image','save',baseline],stdout=subprocess.PIPE);g=subprocess.run(['gzip','-1'],stdin=p.stdout,stdout=out);p.stdout.close();assert p.wait()==0 and g.returncode==0
for p in backup.iterdir():p.chmod(0o600)
tag='phone-cloud-platform:lookup-admin-20261021-rc.3'
with open(stage/'build.log','w') as log:subprocess.run(['nice','-n','10','docker','build','--pull=false','-t',tag,str(stage)],stdout=log,stderr=subprocess.STDOUT,check=True)
# Production mode requires structured PostgreSQL. Use only the disposable
# network-isolated database; never borrow production data or credentials.
subprocess.run([sys.executable,str(stage/'complete-preparation.py')],check=True)
