import subprocess,json
from pathlib import Path
b=Path('/tmp/pc-external-50-20261016');r=subprocess.run(['ssh','-o','BatchMode=yes','-S','/tmp/pc-rc14-cloud-20261016.sock','root@47.98.127.132','docker exec -i phone-cloud-platform node --input-type=module'],input=(b/'observe.mjs').read_bytes(),capture_output=True,timeout=20)
if r.returncode:raise SystemExit('read-only observer failed')
x=json.loads(r.stdout);(b/'OBSERVER.json').write_text(json.dumps(x,indent=2)+'\n');
with (b/'OBSERVER_HISTORY.jsonl').open('a') as f:f.write(json.dumps(x)+'\n')
print(json.dumps({'at':x['at'],'channels':x['channels'],'requestCounts':{status:sum(1 for r in x['requests'] if r['status']==status) for status in sorted(set(r['status'] for r in x['requests']))},'businessCount':sum(r.get('purpose')!='readiness_probe' for r in x['requests'])}))
