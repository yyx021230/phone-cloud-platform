import access as a,json,subprocess,sys
j=a.live();devices=[]
for n in (sys.argv[1:] or ['142','161']):
 d=next(x for x in j['devices'] if x['deviceName']==n)
 assert not d.get('occupancy') and d['adb']['state']=='device'
 assert not any(c['deviceId']==d['deviceId'] for c in j['pool']['channels'])
 snap=next((x for x in j['console']['devices'] if x['deviceId']==d['deviceId']),None)
 accounts=(snap or {}).get('accounts',[])
 assert not (accounts and all(x.get('status')=='cooling' for x in accounts)), 'all known accounts cooling; select another idle phone'
 devices.append({'number':n,'deviceId':d['deviceId'],'serial':d['adb']['serial']})
code="""import {WebSocket} from 'ws';
const devices=DEVICES,headers={Authorization:'Bearer '+process.env.ADMIN_API_TOKEN,'Content-Type':'application/json'},owned=[];
const cleanup=async()=>{for(const x of owned)await fetch('http://127.0.0.1:8787/api/v1/screen-sessions/'+x.sessionId,{method:'DELETE',headers});process.exit(0)};
try{for(const d of devices){const r=await fetch('http://127.0.0.1:8787/api/v1/user/devices/'+d.deviceId+'/screen-sessions',{method:'POST',headers,body:'{}'});const j=await r.json();if(!r.ok)throw Error('reservation rejected');owned.push({...d,sessionId:j.session.sessionId});const w=new WebSocket('ws://127.0.0.1:8787/realtime/v1/sessions/'+j.session.sessionId+'/control?token='+encodeURIComponent(j.browserToken));await new Promise((r,j)=>{w.once('open',r);w.once('error',j)});w.on('error',()=>{});w.on('close',cleanup);}
console.log(JSON.stringify(owned));setTimeout(cleanup,30*60*1000);}catch(e){console.error('lease failed');await cleanup()}
""".replace('DEVICES',json.dumps(devices))
p=subprocess.Popen(a.CLOUD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);p.stdin.write(code);p.stdin.close();line=p.stdout.readline();assert line,'lease failed'
owned=json.loads(line)
# Record each independently held lease before merging; never lose ownership
# evidence when another helper is still acquiring a different phone.
(a.ROOT/('lease-'+devices[0]['number']+'-private.json')).write_text(json.dumps(owned))
import fcntl
with (a.ROOT/'lease-merge.lock').open('w') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 current=a.api('/api/v1/devices')['devices']
 existing=json.loads((a.ROOT/'reservations.json').read_text()) if (a.ROOT/'reservations.json').exists() else []
 existing=[x for x in existing if x['deviceId'] not in {d['deviceId'] for d in owned} and any(d['deviceId']==x['deviceId'] and (d.get('occupancy') or {}).get('sessionId')==x['sessionId'] for d in current)]
 merged=existing+owned
 (a.ROOT/'reservations.json').write_text(json.dumps(merged))
 (a.ROOT/'test-devices-private.json').write_text(json.dumps([{k:v for k,v in x.items() if k!='sessionId'} for x in merged]))
print('Test phones exclusively reserved, no control events sent',flush=True);p.wait()
