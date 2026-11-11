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
 allowed=('pidof com.netease.open.pocoservice','pidof com.netease.open.pocoservice.test')
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
 if value and not all(x.isdigit()for x in value.split()):raise RuntimeError('pid_unconfirmed')
 return value
def forwards():
 s=connection()
 try:command(s,'host:list-forward');n=int(exact(s,4),16);value=exact(s,n).decode()
 finally:s.close()
 return [line.split()for line in value.splitlines()if line.split()and line.split()[0]==serial and line.split()[-1]in('tcp:10080','tcp:10081')]
rows=[]
for _ in range(2):
 rows.append({'at':time.time(),'mainPids':shell('pidof com.netease.open.pocoservice'),'testPids':shell('pidof com.netease.open.pocoservice.test'),'readerForwards':forwards()});time.sleep(.3)
hosts=[]
for pid,birth in[(20436,1793671566.9582727),(22728,1793671567.0479963)]:
 try:p=psutil.Process(pid);hosts.append({'pid':pid,'sameBirthAlive':p.create_time()==birth})
 except psutil.NoSuchProcess:hosts.append({'pid':pid,'absent':True})
print(json.dumps({'snapshots':rows,'originalHosts':hosts,'socketPeer':g.summary(),'readOnlyAdb':True,'mutatingCommands':0}))
