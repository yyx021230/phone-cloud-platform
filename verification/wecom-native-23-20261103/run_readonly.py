import hashlib,json,os,selectors,subprocess,time
from pathlib import Path
root=Path('/private/tmp/pc-wecom-23-native-20261103')
source=root/'collect.mjs'
expected='5e7c70ef85e2f2c3c88d43ef665d368a1d2c3c071cd1ebde05a5810db7b5ad1f'
payload=source.read_bytes()
assert hashlib.sha256(payload).hexdigest()==expected and len(payload)<=65536
out=root/'cloud-observation-1'
out.mkdir(mode=0o700)
argv=['/usr/bin/ssh','-F','/dev/null','-S','/private/tmp/pc-wecom-23-cloud-20261103.sock','-o','ControlMaster=no','-o','BatchMode=yes','-o','ProxyCommand=/usr/bin/false','-o','RequestTTY=no','-T','root@47.98.127.132','docker exec -i phone-cloud-platform node --input-type=module']
bufs={'stdout':bytearray(),'stderr':bytearray()};caps={'stdout':2097152,'stderr':65536};reason=None;truncated=[]
p=None;sel=selectors.DefaultSelector();sent=0;local_exit=None;cleanup_confirmed=False
try:
 p=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
 deadline=time.monotonic()+45
 for stream,events,name in [(p.stdin,selectors.EVENT_WRITE,'stdin'),(p.stdout,selectors.EVENT_READ,'stdout'),(p.stderr,selectors.EVENT_READ,'stderr')]:
  os.set_blocking(stream.fileno(),False);sel.register(stream,events,name)
 while sel.get_map():
  remaining=deadline-time.monotonic()
  if remaining<=0:reason='local_read_deadline';break
  for key,_ in sel.select(min(remaining,0.25)):
   if key.data=='stdin':
    try:sent+=os.write(key.fileobj.fileno(),payload[sent:sent+16384])
    except BlockingIOError:continue
    if sent==len(payload):sel.unregister(key.fileobj);key.fileobj.close()
    continue
   try:data=os.read(key.fileobj.fileno(),16384)
   except BlockingIOError:continue
   if not data:sel.unregister(key.fileobj);continue
   buf=bufs[key.data];room=caps[key.data]-len(buf);buf.extend(data[:room])
   if len(data)>room:reason='local_output_budget';truncated.append(key.data);break
  if reason:break
 if not reason:
  remaining=deadline-time.monotonic()
  if remaining<=0:reason='local_read_deadline'
  else:p.wait(timeout=remaining)
except BrokenPipeError:reason='local_stdin_broken_pipe'
except subprocess.TimeoutExpired:reason='local_read_deadline'
except Exception:reason='local_supervisor_error'
finally:
 sel.close()
 if p is not None:
  if p.poll() is None:
   try:p.kill()
   except ProcessLookupError:pass
   try:p.wait(timeout=2)
   except subprocess.TimeoutExpired:reason=reason or 'local_child_exit_unknown'
  local_exit=p.poll();cleanup_confirmed=local_exit is not None
  for f in (p.stdin,p.stdout,p.stderr):
   if f is not None:
    try:f.close()
    except OSError:pass
for name,buf in bufs.items():(out/(name+'.raw')).write_bytes(buf)
receipt={'sourceSha256':expected,'localSshExit':local_exit,'localFailure':reason,'stdinBytesSent':sent,'truncated':truncated,'localChildExitConfirmed':cleanup_confirmed,'remoteCompletionConfirmed':not reason and local_exit==0,'noFallback':True,'files':{name:{'bytes':len(buf),'sha256':hashlib.sha256(buf).hexdigest()} for name,buf in bufs.items()}}
(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
