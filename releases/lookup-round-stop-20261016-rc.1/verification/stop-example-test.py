"""Exercise downloadable ordinary HTTP stop code without phones or external traffic."""
import importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
root=Path(__file__).resolve().parents[1]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
stop=load('stop_lookup',root/'public/downloads/stop_lookup.py');lookup=load('lookup_sample',root/'public/downloads/lookup.py')
class Response:
 def __init__(self,status,body):self.status_code=status;self.body=body
 def __enter__(self):return self
 def __exit__(self,*a):pass
 def json(self):return self.body
class Examples(unittest.TestCase):
 def setUp(self):self.clock=0;self.calls=[];self.id='00000000-0000-4000-8000-000000000001'
 def sleep(self,n):self.clock+=n
 def body(self,status):return {'ok':True,'preparationId':self.id,'status':status,'stopped':status=='stopped'}
 def run_stop(self,responses,wait=20):
  def post(url,**kw):self.calls.append((url,kw));r=responses.pop(0);return r
  with patch.object(stop.requests,'post',post),patch.object(stop.time,'monotonic',lambda:self.clock),patch.object(stop.time,'sleep',self.sleep):
   return stop.stop_round(self.id,'synthetic-key',base_url='http://127.0.0.1',wait_seconds=wait)
 def test_stopping_then_stopped_reuses_key_and_round(self):
  r=self.run_stop([Response(202,self.body('stopping')),Response(200,self.body('stopped'))]);self.assertTrue(r['stopped']);self.assertEqual(len(self.calls),2)
  for url,kw in self.calls:
   self.assertEqual(kw['headers']['Idempotency-Key'],'stop-'+self.id);self.assertEqual(kw['json'],{'preparationId':self.id});self.assertFalse(kw['allow_redirects'])
 def test_transport_timeout_retains_identity(self):
  calls=[]
  def post(url,**kw):
   calls.append(kw)
   if len(calls)==1:raise stop.requests.Timeout()
   return Response(200,self.body('stopped'))
  with patch.object(stop.requests,'post',post),patch.object(stop.time,'monotonic',lambda:self.clock),patch.object(stop.time,'sleep',self.sleep):r=stop.stop_round(self.id,'key',wait_seconds=20)
  self.assertTrue(r['stopped']);self.assertEqual(calls[0]['headers'],calls[1]['headers'])
 def test_timeout_does_not_claim_confirmed_stop(self):
  r=self.run_stop([Response(202,self.body('stopping'))],wait=5);self.assertEqual(r['status'],'pending');self.assertFalse(r['stopped'])
 def test_retry_server_failure_uses_original_request(self):
  r=self.run_stop([Response(503,{}),Response(200,self.body('stopped'))]);self.assertTrue(r['stopped'])
 def test_wrong_round_response_rejected(self):
  b=self.body('stopped');b['preparationId']='wrong'
  with self.assertRaises(RuntimeError):self.run_stop([Response(200,b)])
 def test_redirect_never_forwarded(self):
  with self.assertRaises(RuntimeError):self.run_stop([Response(302,{})])
 def test_stopped_prepare_never_automatically_restarts(self):
  for status in ['stopping','stopped']:
   calls=[]
   def http(*a,**kw):calls.append(a);return {'ok':True,'status':status,'ready':False}
   with tempfile.TemporaryDirectory() as d,patch.object(lookup,'http_request',http):
    with self.assertRaisesRegex(lookup.ApiError,'lookup_round_stopped'):lookup.query_name('13800000001','synthetic-test','key',state_db=str(Path(d)/'test.sqlite'))
   self.assertEqual(len(calls),1)
if __name__=='__main__':unittest.main()
