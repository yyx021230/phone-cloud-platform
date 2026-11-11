import socket,json,time,sys,psutil
sys.path.insert(0,'D:/PhoneCloud/staging/wecom-qa-peer-64804402-81d86c14/windows-agent/scripts')
from wecom_qa_socket_peer import SocketPeerGuard
binding={'adbPid': 27912, 'adbCreatedAt': 1793603626.369136, 'brokerUrl': 'http://127.0.0.1:43001'}
serial='10AEAS224X005FT'
g=SocketPeerGuard(binding,forwards=lambda:[])
def exact(s,n):
 out=b''
 while len(out)<n:
  b=s.recv(n-len(out))
  if not b:raise RuntimeError('read_closed')
  out+=b
 return out
def connection():
 s=socket.create_connection(('127.0.0.1',5037),2);s.settimeout(3)
 try:g.connected(s,('127.0.0.1',5037));return s
 except Exception:s.close();raise
def command(s,value):
 g.before_io(s);b=value.encode();s.sendall(('%04x'%len(b)).encode()+b)
 if exact(s,4)!=b'OKAY':raise RuntimeError('read_rejected')
def shell(value):
 allowed=('pidof com.netease.open.pocoservice','pidof com.netease.open.pocoservice.test','cat /proc/8061/stat','cat /proc/8061/cmdline','cat /proc/8061/status','am force-stop --user 0 com.netease.open.pocoservice')
 assert value in allowed
 s=connection();out=b''
 try:
  command(s,'host:transport:'+serial);command(s,'shell:'+value)
  while True:
   b=s.recv(4096)
   if not b:break
   out+=b
   if len(out)>65536:raise RuntimeError('read_budget')
 finally:s.close()
 value=out.decode().strip()

 return value
def forwards():
 s=connection()
 try:command(s,'host:list-forward');n=int(exact(s,4),16);value=exact(s,n).decode()
 finally:s.close()
 return [line.split()for line in value.splitlines()if line.split()and line.split()[0]==serial and line.split()[-1]in('tcp:10080','tcp:10081')]
import re
for pid,birth in[(20436,1793671566.9582727),(22728,1793671567.0479963)]:
 try:assert psutil.Process(pid).create_time()!=birth,'original_host_alive'
 except psutil.NoSuchProcess:pass
assert shell('pidof com.netease.open.pocoservice')=='8061','observed_instance_changed'
assert shell('pidof com.netease.open.pocoservice.test')=='','unexpected_test_instance'
raw=shell('cat /proc/8061/stat');fields=raw.rsplit(') ',1)[-1].split();assert fields[19]=='36793965','observed_instance_changed'
assert shell('cat /proc/8061/cmdline').replace('\x00',' ').strip()=='com.netease.open.pocoservice','package_changed'
status=shell('cat /proc/8061/status');m=re.search(r'(?m)^Uid:\s+(\d+)',status);assert m and int(m[1])<100000,'not_user_zero'
assert forwards()==[],'unexpected_reader_forwards'
# No retry of this mutation, even if its response becomes unknown.
mutation=shell('am force-stop --user 0 com.netease.open.pocoservice')
assert not mutation.strip(),'force_stop_response_unconfirmed'
rows=[]
for _ in range(2):
 row={'at':time.time(),'mainPids':shell('pidof com.netease.open.pocoservice'),'testPids':shell('pidof com.netease.open.pocoservice.test'),'readerForwards':forwards()};rows.append(row)
 assert row['mainPids']==row['testPids']==''and row['readerForwards']==[],'physical_cleanup_unconfirmed'
 time.sleep(.3)
print(json.dumps({'purpose':'cleanup_only_observed_residue','observedPid':8061,'observedStartToken':'36793965','forceStopCount':1,'snapshots':rows,'socketPeer':g.summary(),'customerActions':0,'cleanupConfirmed':True}))
