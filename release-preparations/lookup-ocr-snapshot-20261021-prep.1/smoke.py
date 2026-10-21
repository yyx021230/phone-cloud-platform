from pathlib import Path
import subprocess,json
stage=Path('/opt/phone-cloud-platform/staging/lookup-ocr-snapshot-20261021-rc.1');p=json.loads((stage/'PREPARED.json').read_text())
code=r'''
import crypto from 'node:crypto';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';import {once} from 'node:events';
const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'18787',DATA_DIR:'/tmp/isolated-lookup-smoke',STORAGE_BACKEND:'json',STRUCTURED_WRITES:'false',DATABASE_URL:'',REDIS_URL:'',ADMIN_PASSWORD:crypto.randomUUID(),ADMIN_API_TOKEN:crypto.randomUUID(),WINDOWS_AGENT_TOKEN:crypto.randomUUID(),DEVICE_AGENT_TOKEN:crypto.randomUUID(),SCREEN_MEDIA_AUTH_SECRET:crypto.randomUUID(),OPEN_NAME_LOOKUP_API_ENABLED:'true',MANAGED_NAME_LOOKUP_ENABLED:'false',OPEN_NAME_LOOKUP_CLIENTS_JSON:'[]',LOOKUP_HUMAN_FEISHU_WEBHOOK:'',LOOKUP_HUMAN_FEISHU_WEBHOOK_FILE:''};
const c=spawn(process.execPath,['server/index.mjs'],{env,stdio:'ignore'});let ok=false;
try{for(let i=0;i<100;i++){if(c.exitCode!==null)throw Error('isolated_boot_failed');try{const r=await fetch('http://127.0.0.1:18787/readyz');if(r.ok){ok=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}assert.ok(ok);
for(const p of ['/healthz','/api-docs.html','/api-reference.json','/lookup-card-status.js'])assert.equal((await fetch('http://127.0.0.1:18787'+p)).status,200);
console.log(JSON.stringify({passed:true,network:'none',productionData:false,ready:true,publicAssets:4}));
}finally{if(c.exitCode===null){const e=once(c,'exit');c.kill('SIGTERM');const t=setTimeout(()=>c.kill('SIGKILL'),2000);await e;clearTimeout(t)}}
'''
s=subprocess.check_output(['docker','run','--rm','--network','none','-i','--entrypoint','node','--workdir','/app',p['image'],'--input-type=module'],input=code,text=True,stderr=subprocess.PIPE,timeout=30)
o=json.loads(s);assert o['passed'];(stage/'SMOKE.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o))
