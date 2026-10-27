import sys,json,subprocess
import access as a
p=json.loads(sys.stdin.read());allowed=json.loads((a.ROOT/'observer-device-scope-private.json').read_text());d=next(x for x in allowed if x['serial']==p['serial']);j=a.api('/api/v1/devices');current=next(x for x in j['devices'] if x['deviceId']==d['deviceId'])
assert current['adb']['state']=='device','offline'
assert (current.get('occupancy') or {}).get('kind') in (None,'screen_control'),'production task owns phone'
rv=json.loads((a.ROOT/'reservations.json').read_text());owned=next((x for x in rv if x['deviceId']==d['deviceId']),None)
if p['operation']=='lease_status':
 print(json.dumps({'ownLease':bool(owned and (current.get('occupancy') or {}).get('sessionId')==owned['sessionId']),'canAcquire':not bool(current.get('occupancy'))}));sys.exit()
if p['operation']=='release':
 if owned and (current.get('occupancy') or {}).get('sessionId')==owned['sessionId']:a.api('/api/v1/screen-sessions/'+owned['sessionId'],'DELETE')
 print(json.dumps({'released':True}));sys.exit()
# Read-only observation uses the existing SYSTEM ADB server; never starts a worker.
code=r'''$py=@'
import subprocess,json
adb=r'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe'
serial=SERIAL
def read(args,timeout):
 r=subprocess.run([adb,'-s',serial]+args,capture_output=True,timeout=timeout)
 if r.returncode:raise RuntimeError('read failed')
 return r.stdout.decode('utf8','replace')
power=read(['shell','dumpsys','power'],2)
before=read(['shell','dumpsys','window'],2)
xml=read(['exec-out','uiautomator','dump','/dev/tty'],15)
after=read(['shell','dumpsys','window'],2)
powerAfter=read(['shell','dumpsys','power'],2)
print(json.dumps(dict(power=power,before=before,xml=xml,after=after,powerAfter=powerAfter)))
'@
$py|& 'D:\PhoneCloud\tools\python39\python.exe' -
'''.replace('SERIAL',repr(d['serial']))
r=json.loads(a.ps(code,35));r['number']=d['number'];r['canAcquire']=not bool(current.get('occupancy'));r['ownLease']=bool(owned and (current.get('occupancy') or {}).get('sessionId')==owned['sessionId']);print(json.dumps(r))
