import json, os, pathlib, secrets, subprocess, sys, time

# Usage: python3 tools/release-validation/image-smoke.py IMAGE /absolute/private/output LOCAL_CONTEXT
# Uses synthetic accounts in disposable containers. No real platform/Agent connections.
ROOT = pathlib.Path(__file__).resolve().parents[2]
IMAGE = sys.argv[1]
OUT = pathlib.Path(sys.argv[2]).resolve()
OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
DOCKER = ['docker', '--context', sys.argv[3]]
endpoint = subprocess.check_output(['docker','context','inspect',sys.argv[3],'--format','{{.Endpoints.docker.Host}}'],text=True).strip()
if not endpoint.startswith('unix://'):
    raise RuntimeError('Only an explicitly selected local Unix Docker endpoint is allowed')
PREFIX = 'pc-readiness-fixture-' + str(os.getpid())
NET = PREFIX + '-net'
names = []
def cmd(args, data=None, check=True):
    r = subprocess.run(DOCKER + args, input=data, text=True, capture_output=True, timeout=90)
    if check and r.returncode:
        raise RuntimeError('docker step failed: ' + args[0] + '\n' + r.stderr[-2000:])
    return r
def run(name, extra, image, command=[]):
    cmd(['run','-d','--platform','linux/amd64','--name',name,'--network',NET] + extra + [image] + command)
    names.append(name)
def node(name, source):
    r = cmd(['exec','-i',name,'node','--input-type=module','-'], source)
    return json.loads(r.stdout)
def wait_http(name, url):
    for _ in range(40):
        r = cmd(['exec',name,'node','-e',"fetch('"+url+"').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], check=False)
        if not r.returncode: return
        time.sleep(0.5)
    logs = cmd(['logs','--tail','20',name],check=False)
    raise RuntimeError('container readiness failed: '+name+'\n'+logs.stderr[-2000:])
password = secrets.token_hex(24)
clientsecret = secrets.token_hex(32)
env = OUT/'container-fixture.env'
env.write_text('\n'.join(['ADMIN_USERNAME=fixture_admin','ADMIN_PASSWORD='+password,
    'ADMIN_API_TOKEN='+secrets.token_hex(32),'WINDOWS_AGENT_TOKEN='+secrets.token_hex(32),
    'DEVICE_AGENT_TOKEN='+secrets.token_hex(32),'EVIDENCE_SIGNING_SECRET='+secrets.token_hex(32),
    'STORAGE_BACKEND=postgres','DATABASE_URL=postgresql://fixture@pg:5432/fixture','REDIS_URL=redis://redis:6379/0',
    'DATA_DIR=/app/data','STRICT_PRODUCTION_CONFIG=false','POSTGRES_KEYED_STATE_ENABLED=true'])+'\n')
env.chmod(0o600)
config = OUT/'batch-fixture.json'
config.write_text(json.dumps({'platformBaseUrl':'http://platform:8787','clients':[{'clientId':'fixture',
    'secret':clientsecret,'username':'fixture_user','password':password,
    'targets':[{'deviceId':'absent-fixture-device','appSlot':'app1','xhsId':'fixture_xhs','accountName':'Fixture'}]}]}))
config.chmod(0o600)
receipt = {'image':IMAGE,'scope':'isolated local Linux amd64 containers; synthetic credentials; no real phones',
    'network':'internal; no published ports','checks':{}}
try:
    cmd(['network','create','--internal',NET])
    run(PREFIX+'-pg',['--network-alias','pg','-e','POSTGRES_USER=fixture','-e','POSTGRES_DB=fixture','-e','POSTGRES_HOST_AUTH_METHOD=trust','--tmpfs','/var/lib/postgresql/data'], 'postgres:16-alpine')
    for _ in range(50):
        if cmd(['exec',PREFIX+'-pg','pg_isready','-h','127.0.0.1','-U','fixture','-d','fixture'],check=False).returncode == 0: break
        time.sleep(0.5)
    for schema in ['deploy/sql/20261013-managed-lookup.sql','deploy/sql/20261013-managed-lookup-async.sql','deploy/xhs-batch/schema.sql']:
        cmd(['exec','-i',PREFIX+'-pg','psql','-v','ON_ERROR_STOP=1','-U','fixture','-d','fixture'],(ROOT/schema).read_text())
    run(PREFIX+'-redis',['--network-alias','redis'], 'redis:8-alpine', ['redis-server','--save','','--appendonly','no'])
    run(PREFIX+'-platform',['--network-alias','platform','--env-file',str(env),'--tmpfs','/app/data'],IMAGE)
    wait_http(PREFIX+'-platform','http://127.0.0.1:8787/readyz')
    receipt['checks']['platform'] = node(PREFIX+'-platform', """
const base='http://127.0.0.1:8787';
async function api(path,method='GET',body,token='') {
 const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
 if(!r.ok) throw new Error(path+':'+r.status); return r.json();
}
const ready=await api('/readyz');
const login=await api('/api/v1/auth/login','POST',{username:process.env.ADMIN_USERNAME,password:process.env.ADMIN_PASSWORD});
await api('/api/v1/users','POST',{username:'fixture_user',password:process.env.ADMIN_PASSWORD,role:'user',enabled:true},login.session.token);
const u=await api('/api/v1/auth/login','POST',{username:'fixture_user',password:process.env.ADMIN_PASSWORD});
const task=await api('/api/v1/user/automation/xhs-data-tasks','GET',undefined,u.session.token);
if(task.batchContract?.version!==1||!task.batchContract.submissionLookup) throw new Error('missing batch contract');
const agent=await api('/api/v1/windows-agents','POST',{agentId:'fixture-agent',agentName:'Synthetic fixture'},login.session.token);
const input={agent:{agentId:'fixture-agent'},devices:Array.from({length:140},(_,i)=>({adbSerial:'FIXTURE-'+i,state:'device',model:'Synthetic'}))};
const sync=await fetch(base+'/api/v1/windows-agents/fixture-agent/devices/sync',{method:'POST',headers:{authorization:'Bearer '+agent.token,'content-type':'application/json','accept-encoding':'gzip'},body:JSON.stringify(input)});
if(!sync.ok||sync.headers.get('content-encoding')!=='gzip')throw new Error('inventory compression unavailable');
const synced=await sync.json();if(synced.devices.length!==140)throw new Error('inventory decode lost devices');
const assets=[]; for(const p of ['/','/api-docs.html','/app.js','/user-device-inventory.js']) { const r=await fetch(base+p); if(!r.ok) throw new Error(p+':'+r.status); assets.push(p); }
console.log(JSON.stringify({ready:ready.ok,backend:ready.storage.backend,contract:task.batchContract,assets,ordinaryRole:u.user.role,inventoryGzip:true,decodedSyntheticDevices:140,node:process.version}));
""")
    cmd(['cp',str(config),PREFIX+'-platform:/tmp/batch-fixture.json'])
    cmd(['volume','create',PREFIX+'-config'])
    cmd(['run','--rm','-i','--platform','linux/amd64','--network','none','--mount','type=volume,src='+PREFIX+'-config,dst=/config',IMAGE,'node','-e',
        "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const f=require('fs');f.writeFileSync('/config/config.json',s,{mode:0o600});f.chownSync('/config/config.json',1000,1000);});"],config.read_text())
    run(PREFIX+'-batch',['--network-alias','batch','--user','node','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp','-e','XHS_BATCH_HOST=0.0.0.0',
        '-e','XHS_BATCH_DATABASE_URL=postgresql://fixture@pg:5432/fixture',
        '-e','XHS_BATCH_CONFIG_FILE=/run/fixture/config.json','--mount','type=volume,src='+PREFIX+'-config,dst=/run/fixture,readonly'],IMAGE,['node','server/xhs-batch/main.mjs'])
    wait_http(PREFIX+'-batch','http://127.0.0.1:8791/healthz')
    # Exercise the ordinary HTTP gateway using an unprivileged, isolated Nginx.
    nginx = '''pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events {}
http {
  access_log off;
  client_body_temp_path /tmp/body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  server { listen 8080;
    location = /healthz { proxy_pass http://batch:8791/healthz; }
    location ^~ /api/v1/open/xhs-data/ {
      proxy_pass http://batch:8791;
      proxy_set_header Host $host;
      proxy_http_version 1.1;
      client_max_body_size 64k;
      proxy_read_timeout 60s;
    }
  }
}'''
    cmd(['run','--rm','-i','--platform','linux/amd64','--network','none','--mount','type=volume,src='+PREFIX+'-config,dst=/config',IMAGE,'node','-e',
        "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('fs').writeFileSync('/config/nginx.conf',s,{mode:0o644}));"],nginx)
    run(PREFIX+'-gateway',['--network-alias','gateway','--user','101:101','--read-only','--cap-drop','ALL',
        '--security-opt','no-new-privileges:true','--tmpfs','/tmp:mode=1777','--mount','type=volume,src='+PREFIX+'-config,dst=/fixture,readonly',
        '--entrypoint','nginx'],'nginx:stable-alpine',['-c','/fixture/nginx.conf','-g','daemon off;'])
    wait_http(PREFIX+'-platform','http://gateway:8080/healthz')
    receipt['checks']['batch'] = node(PREFIX+'-platform', """
import fs from 'node:fs'; import {signRequest} from '/app/server/xhs-batch/http.mjs'; import crypto from 'node:crypto';
const c=JSON.parse(fs.readFileSync('/tmp/batch-fixture.json')).clients[0],root='/api/v1/open/xhs-data';
async function api(path,method='GET',body) {const raw=body?JSON.stringify(body):'',t=String(Date.now()),n=crypto.randomUUID();const r=await fetch('http://gateway:8080'+root+path,{method,headers:{'content-type':'application/json','x-client-id':c.clientId,'x-timestamp':t,'x-nonce':n,'x-signature':signRequest(c.secret,method,root+path,t,n,raw)},body:raw||undefined});if(!r.ok)throw new Error('batch:'+r.status);return r.json();}
const schedule=await api('/schedule');if(schedule.schedule.enabled!==false)throw new Error('unexpected enabled schedule');
const batch=await api('/batches','POST',{requestId:'container-fixture-original'});
const repeat=await api('/batches','POST',{requestId:'container-fixture-original'});if(batch.batch.runId!==repeat.batch.runId)throw new Error('duplicate batch');
const path='/batches/'+batch.batch.runId;await api(path+'/stop','POST',{});
let result;for(let i=0;i<35;i++){result=await api(path+'?offset=0&limit=1');if(result.status==='completed')break;await new Promise(r=>setTimeout(r,500));}
if(result.status!=='completed'||result.items[0].reason!=='batch_stopped')throw new Error('stop not drained');
console.log(JSON.stringify({http:true,viaUnprivilegedNginx:true,signed:true,scheduleInitiallyDisabled:true,oneBatchOnRepeat:true,stopped:true,items:result.items.length,nextOffset:result.nextOffset,realPhoneTasks:0}));
""")
    cmd(['restart',PREFIX+'-batch'])
    wait_http(PREFIX+'-batch','http://127.0.0.1:8791/healthz')
    receipt['checks']['restart'] = node(PREFIX+'-platform',"""
import fs from 'node:fs';import {signRequest}from'/app/server/xhs-batch/http.mjs';import crypto from'node:crypto';
const c=JSON.parse(fs.readFileSync('/tmp/batch-fixture.json')).clients[0],p='/api/v1/open/xhs-data/batches?offset=0',t=String(Date.now()),n=crypto.randomUUID();
const r=await fetch('http://gateway:8080'+p,{headers:{'x-client-id':c.clientId,'x-timestamp':t,'x-nonce':n,'x-signature':signRequest(c.secret,'GET',p,t,n,'')}});const d=await r.json();if(!r.ok||d.batches.length!==1||d.batches[0].status!=='completed')throw new Error('restart lost result');console.log(JSON.stringify({persistedCompletedBatch:true}));
""")
    receipt['imageMetadata'] = json.loads(cmd(['image','inspect',IMAGE,'--format','{{json .}}']).stdout)
    receipt['imageMetadata'] = {k:receipt['imageMetadata'][k] for k in ['Id','Architecture','Os']}
    receipt['passed']=True
    receipt['postgresImage'] = json.loads(cmd(['image','inspect','postgres:16-alpine','--format','{{json .RepoDigests}}']).stdout)
    receipt['redisImage'] = json.loads(cmd(['image','inspect','redis:8-alpine','--format','{{json .RepoDigests}}']).stdout)
    receipt['nginxImage'] = json.loads(cmd(['image','inspect','nginx:stable-alpine','--format','{{json .RepoDigests}}']).stdout)
finally:
    for name in reversed(names):cmd(['rm','-f',name],check=False)
    cmd(['network','rm',NET],check=False)
    cmd(['volume','rm',PREFIX+'-config'],check=False)
    env.unlink(missing_ok=True);config.unlink(missing_ok=True)
    receipt['cleanup']=True
    (OUT/'image-smoke-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
