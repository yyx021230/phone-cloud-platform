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
 allowed=('pidof com.netease.open.pocoservice','pidof com.netease.open.pocoservice.test','cat /proc/8061/stat','cat /proc/8061/cmdline','dumpsys activity instrumentation','date +%s',"logcat -b events -d -v epoch -t 1000 am_proc_start:I am_proc_died:I am_kill:I '*:S'")
 assert value in allowed
 s=connection();out=b''
 try:
  command(s,'host:transport:'+serial);command(s,'shell:'+value)
  while True:
   b=s.recv(4096)
   if not b:break
   out+=b
   if len(out)>262144:raise RuntimeError('read_budget')
 finally:s.close()
 value=out.decode().strip()

 return value
def forwards():
 s=connection()
 try:command(s,'host:list-forward');n=int(exact(s,4),16);value=exact(s,n).decode()
 finally:s.close()
 return [line.split()for line in value.splitlines()if line.split()and line.split()[0]==serial and line.split()[-1]in('tcp:10080','tcp:10081')]
import re
rows=[]
for _ in range(2):
 stat=shell('cat /proc/8061/stat');tail=stat.rsplit(') ',1)[-1].split()
 rows.append({'at':time.time(),'pid':8061,'startToken':tail[19]if len(tail)>19 else '', 'mainPids':shell('pidof com.netease.open.pocoservice'),'testPids':shell('pidof com.netease.open.pocoservice.test')});time.sleep(.3)
raw=shell("logcat -b events -d -v epoch -t 1000 am_proc_start:I am_proc_died:I am_kill:I '*:S'")
events=[]
for line in raw.splitlines():
 if 'com.netease.open.pocoservice'not in line:continue
 m=re.search(r'^\s*([0-9]+\.[0-9]+).*?\b(am_proc_start|am_proc_died|am_kill)\s*:\s*\[([0-9]+),([0-9]+),',line)
 if m:events.append({'deviceEpoch':m[1],'event':m[2],'user':int(m[3]),'pid':int(m[4]),'isMain':'com.netease.open.pocoservice,'in line})
print(json.dumps({'observations':rows,'deviceEpochNow':shell('date +%s'),'pocoProcessEvents':events,'pocoEventLineCount':sum('com.netease.open.pocoservice'in l for l in raw.splitlines()),'readOnlyAdb':True,'mutatingCommands':0,'socketPeer':g.summary()}))
