import sys,subprocess,json,inspect,urllib.request
sys.path.insert(0,'D:/PhoneCloud/staging/wecom-qa-peer-64804402-81d86c14/windows-agent/scripts')
from wecom_qa_socket_peer import SocketPeerGuard
child="from http.server import HTTPServer,BaseHTTPRequestHandler\nclass H(BaseHTTPRequestHandler):\n def log_message(self,*a):pass\n def do_POST(self):\n  self.rfile.read(int(self.headers.get('Content-Length','0')));self.send_response(200);self.end_headers();self.wfile.write(b'OK')\ns=HTTPServer(('127.0.0.1',0),H);print(s.server_port,flush=True);s.serve_forever()"
p=subprocess.Popen([sys.executable,'-u','-c',child],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
try:
 port=int(p.stdout.readline());guard=SocketPeerGuard({'adbPid':27912,'adbCreatedAt':1,'brokerUrl':'http://127.0.0.1:'+str(port)},forwards=lambda:[])
 denied=[];original=guard.deny
 def deny():
  stack=inspect.stack();err=sys.exc_info()[1]
  denied.append({'caller':stack[1].function,'exception':type(err).__name__ if err else None,'errno':getattr(err,'errno',None),'winerror':getattr(err,'winerror',None)})
  return original()
 guard.deny=deny;count=0;failure=None
 try:
  with guard.install():
   for _ in range(20):
    with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:'+str(port),data=b'{}',method='POST'),timeout=2)as r:assert r.read(16385)==b'OK'
    count+=1
 except Exception as e:failure=type(e).__name__
 print(json.dumps({'completed':count,'failure':failure,'denied':denied,'guard':guard.summary(),'phoneActions':0,'adbConnections':0}))
finally:
 p.terminate();p.wait(timeout=3);p.stdout.close()
