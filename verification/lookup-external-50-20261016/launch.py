import subprocess,json,hashlib
from pathlib import Path
b=Path('/tmp/pc-external-50-20261016')
# Read the existing authorized input and caller credential over SSH directly into memory.
# Neither credentials nor phone numbers are written to command arguments, files or output.
js="""import fs from 'node:fs/promises';import crypto from 'node:crypto';const text=await fs.readFile('/app/data/test-receipts/lookup-natural-handoff-20261015/phones.json','utf8');if(crypto.createHash('sha256').update(text).digest('hex')!=='20d3440551746ef8abe6919e5a8b3c7d0c6c12ac555f00f97d61d82fa8c64b95')throw Error('source_changed');const c=JSON.parse(process.env.OPEN_NAME_LOOKUP_CLIENTS_JSON||'[]').find(c=>c.clientId==='name-lookup-v1');if(!c?.secret)throw Error('client_missing');console.log(JSON.stringify({clientId:c.clientId,secret:c.secret,phones:JSON.parse(text).slice(100,150)}));"""
r=subprocess.run(['ssh','-o','BatchMode=yes','-S','/tmp/pc-rc14-cloud-20261016.sock','root@47.98.127.132','docker exec -i phone-cloud-platform node --input-type=module'],input=js.encode(),capture_output=True,timeout=20)
if r.returncode:raise SystemExit('safe credential/input read failed')
payload=r.stdout
x=json.loads(payload);assert len(x['phones'])==50
with (b/'RUN.log').open('ab') as out:
 p=subprocess.run(['node',str(b/'run.mjs')],input=payload,stdout=out,stderr=out)
raise SystemExit(p.returncode)
