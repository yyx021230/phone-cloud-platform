import importlib.util,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('http_lookup',Path(__file__).resolve().parents[1]/'public/downloads/lookup.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Example(unittest.TestCase):
 def test_pause_resume_and_original_identity(self):
  clock=[0];calls=[];sleeps=[]
  responses=[{'ok':True,'status':'ready','ready':True,'acceptingRequests':False},{'ok':True,'status':'ready','ready':True,'acceptingRequests':True},m.ApiError('lookup_no_available_device',True,30),{'ok':True,'status':'ready','ready':True,'acceptingRequests':False},{'ok':True,'status':'ready','ready':True,'acceptingRequests':True},{'ok':True,'lookupId':'original-id','status':'queued'},{'ok':True,'lookupId':'original-id','status':'queued','code':'lookup_no_available_device','retryAfterSeconds':30},{'ok':True,'lookupId':'original-id','status':'completed','name':''}]
  def call(method,path,body,key,*args):
   calls.append((method,path.split('/')[-1],key));item=responses.pop(0)
   if isinstance(item,Exception):raise item
   return item
  def sleep(seconds):sleeps.append(seconds);clock[0]+=seconds
  with tempfile.TemporaryDirectory() as t,patch.object(m,'http_request',call):
   out=m.query_name('13800000000','synthetic-order','synthetic-key',base_url='http://127.0.0.1',state_db=str(Path(t)/'state.sqlite'),wait_seconds=240,clock=lambda:clock[0],sleep=sleep)
   self.assertEqual(out['name'],'');self.assertEqual([c[1] for c in calls],['prepare','prepare','tasks','prepare','prepare','tasks','original-id','original-id']);self.assertEqual(sleeps,[30,30,30,30]);self.assertEqual(len(set(c[2] for c in calls if c[1]=='prepare')),1);self.assertEqual(len(set(c[2] for c in calls if c[1]=='tasks')),1)
if __name__=='__main__':unittest.main()
