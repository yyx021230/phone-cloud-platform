from pathlib import Path
import subprocess,json,sys,zipfile,base64
b=Path('/tmp/pc-combined-release-20261015');archive=Path('/tmp/pc-combined-rc13-committed-check/public/downloads/name-lookup-integration.zip')
with zipfile.ZipFile(archive) as z:sdk=z.read('node_client.mjs')
code=(b/'partner-real.mjs').read_text().replace('SDK_URL',repr('data:text/javascript;base64,'+base64.b64encode(sdk).decode()))
code="process.on('uncaughtException',e=>{console.error(JSON.stringify({event:'runner-error',status:e.status,code:e.code||e.message||'runner_error'}));process.exit(1)});\n"+'process.argv='+json.dumps(['node','partner-real']+sys.argv[1:])+';\n'+code
r=subprocess.run(['ssh','-o','BatchMode=yes','-S','/tmp/pc-combined-cloud-20261015.sock','root@47.98.127.132','docker exec -i phone-cloud-platform node --input-type=module'],input=code.encode(),capture_output=True,timeout=55)
with (b/'REAL_API_EVENTS.jsonl').open('ab') as f:f.write(r.stdout)
print(r.stdout.decode());
if r.returncode:print(r.stderr.decode()[-800:]);raise SystemExit(r.returncode)
