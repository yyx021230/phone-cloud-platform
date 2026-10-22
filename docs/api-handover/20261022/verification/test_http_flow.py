import importlib.util,tempfile,unittest,json
from pathlib import Path
from unittest.mock import patch
p=Path(__file__).resolve().parents[1]/'http_flow.py'
spec=importlib.util.spec_from_file_location('flow',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();m.STATE_FILE=Path(self.temp.name)/'state.json';m.API_KEY='synthetic-api-key';self.s=m.load();self.clock=0
 def tearDown(self):self.temp.cleanup()
 def sleep(self,n):self.clock+=n
 def rd(self):self.s['round']={'key':'prepare-key-1','preparationId':'round-111','status':'ready'};m.save(self.s)
 def job(self):self.rd();self.s['jobs']['order-1']={'phoneHash':'synthetic','key':'query-key-1','lookupId':'lookup-111'}
 def test_prepare_persists_key_before_request(self):
  def req(*a):
   saved=json.loads(m.STATE_FILE.read_text());self.assertEqual(a[3],saved['round']['key']);return {'ok':True,'preparationId':'round-111','status':'ready','ready':True}
  with patch.object(m,'request',req):self.assertTrue(m.prepare(self.s)['ready'])
 def test_prepare_timeout_reuses_original_key(self):
  def req(*a):return {'ok':True,'preparationId':'round-111','status':'preparing','ready':False}
  with patch.object(m,'request',req),patch.object(m.time,'monotonic',lambda:self.clock),patch.object(m.time,'sleep',self.sleep):
   self.assertTrue(m.prepare(self.s,1)['localWaitTimedOut']);key=self.s['round']['key'];self.assertTrue(m.prepare(self.s,1)['localWaitTimedOut']);self.assertEqual(key,self.s['round']['key'])
 def test_new_round_blocked_until_previous_stopped(self):
  self.rd()
  with patch.object(m,'request',return_value={'status':'stopping'}):
   with self.assertRaises(RuntimeError):m.prepare(self.s,new_round=True)
  self.assertEqual(self.s['round']['key'],'prepare-key-1')
 def test_explicit_new_round_after_stop(self):
  self.rd()
  with patch.object(m,'request',side_effect=[{'status':'stopped'},{'ok':True,'preparationId':'round-222','status':'ready','ready':True}]):self.assertTrue(m.prepare(self.s,new_round=True)['ready'])
  self.assertNotEqual(self.s['round']['key'],'prepare-key-1');self.assertEqual(self.s['round']['preparationId'],'round-222')
 def test_unknown_submit_retry_reuses_persisted_key(self):
  self.rd();seen=[]
  def req(method,path,body=None,key=None,*a):
   if path=='/prepare':return {'status':'ready','ready':True}
   seen.append(key);self.assertEqual(key,json.loads(m.STATE_FILE.read_text())['jobs']['order-1']['key'])
   if len(seen)==1:raise RuntimeError('response lost')
   return {'ok':True,'lookupId':'lookup-111','status':'processing','reused':True}
  with patch.object(m,'request',req):
   with self.assertRaises(RuntimeError):m.submit(self.s,'13800000001','order-1')
   self.s=m.load();self.assertTrue(m.submit(self.s,'13800000001','order-1')['reused'])
  self.assertEqual(seen[0],seen[1])
 def test_same_business_after_id_only_gets(self):
  self.rd()
  with patch.object(m,'request',side_effect=[{'status':'ready','ready':True},{'ok':True,'lookupId':'lookup-111','status':'queued'}]):m.submit(self.s,'13800000001','order-1')
  with patch.object(m,'request',return_value={'status':'processing'}) as req:m.submit(self.s,'13800000001','order-1');self.assertEqual(req.call_args.args[:2],('GET','/tasks/lookup-111'))
 def test_same_business_other_phone_rejected(self):
  self.rd()
  with patch.object(m,'request',side_effect=[{'status':'ready','ready':True},{'ok':True,'lookupId':'lookup-111','status':'queued'}]):m.submit(self.s,'13800000001','order-1')
  with patch.object(m,'request') as req:
   with self.assertRaises(RuntimeError):m.submit(self.s,'13800000002','order-1')
   req.assert_not_called()
 def test_empty_name_only_on_completed(self):
  self.job()
  with patch.object(m,'request',return_value={'ok':True,'lookupId':'lookup-111','status':'completed','name':''}):self.assertEqual(m.result(self.s,'order-1')['name'],'')
 def test_failed_never_backfills_empty_name(self):
  self.job()
  with patch.object(m,'request',return_value={'ok':False,'lookupId':'lookup-111','status':'failed','code':'lookup_round_stopped'}):self.assertEqual(m.result(self.s,'order-1')['status'],'failed')
  self.assertNotIn('name',self.s['jobs']['order-1'])
 def test_query_timeout_only_polls_original_id(self):
  self.job()
  with patch.object(m,'request',return_value={'ok':True,'lookupId':'lookup-111','status':'processing'}) as req,patch.object(m.time,'monotonic',lambda:self.clock),patch.object(m.time,'sleep',self.sleep):
   self.assertTrue(m.result(self.s,'order-1',1)['localWaitTimedOut']);self.assertTrue(m.result(self.s,'order-1',1)['localWaitTimedOut']);self.assertTrue(all(c.args[0]=='GET' for c in req.call_args_list))
 def test_stop_timeout_keeps_round_and_key(self):
  self.rd()
  with patch.object(m,'request',return_value={'ok':True,'preparationId':'round-111','status':'stopping','stopped':False}) as req,patch.object(m.time,'monotonic',lambda:self.clock),patch.object(m.time,'sleep',self.sleep):
   self.assertTrue(m.stop(self.s,1)['localWaitTimedOut']);self.assertTrue(m.stop(self.s,1)['localWaitTimedOut']);self.assertTrue(all(c.args[3]=='stop-round-111' for c in req.call_args_list))
 def test_stop_confirmed(self):
  self.rd()
  with patch.object(m,'request',return_value={'ok':True,'preparationId':'round-111','status':'stopped','stopped':True}):self.assertTrue(m.stop(self.s)['stopped'])
 def test_completed_missing_name_rejected(self):
  self.job()
  with patch.object(m,'request',return_value={'ok':True,'lookupId':'lookup-111','status':'completed'}):
   with self.assertRaises(RuntimeError):m.result(self.s,'order-1')
 def test_key_never_written_and_cross_key_state_rejected(self):
  self.assertNotIn(m.API_KEY,m.STATE_FILE.read_text());m.API_KEY='different-key'
  with self.assertRaises(RuntimeError):m.load()
 def test_http_uses_single_key_and_no_redirects(self):
  class Resp:
   status_code=202
   def __enter__(self):return self
   def __exit__(self,*a):pass
   def json(self):return {'ok':True,'lookupId':'lookup-111'}
  with patch.object(m.requests,'request',return_value=Resp()) as req:
   m.request('POST','/tasks',{'phoneNumber':'13800000001'},'query-key-1')
   self.assertEqual(req.call_args.kwargs['headers'],{'X-API-Key':'synthetic-api-key','Idempotency-Key':'query-key-1'});self.assertFalse(req.call_args.kwargs['allow_redirects'])
class CapacityTests(unittest.TestCase):
 setUp=Tests.setUp
 tearDown=Tests.tearDown
 sleep=Tests.sleep
 rd=Tests.rd
 job=Tests.job
 def ready(self, available=True):return {'ok':True,'preparationId':'round-111','status':'ready','ready':True,'acceptingRequests':available,**({} if available else {'code':'lookup_no_available_device','retryAfterSeconds':30})}
 def test_ready_without_capacity_waits_original_prepare(self):
  self.rd()
  with patch.object(m,'request',side_effect=[self.ready(False),self.ready(True)]) as req,patch.object(m.time,'monotonic',lambda:self.clock),patch.object(m.time,'sleep',self.sleep):
   result=m.prepare(self.s,40);self.assertTrue(result['acceptingRequests']);self.assertEqual(self.clock,30);self.assertEqual([c.args[3] for c in req.call_args_list],['prepare-key-1','prepare-key-1'])
 def test_zero_capacity_prevents_new_submission(self):
  self.rd()
  with patch.object(m,'request',return_value=self.ready(False)) as req:
   r=m.submit(self.s,'13800000001','order-1');self.assertFalse(r['accepted']);self.assertEqual(req.call_count,1);self.assertEqual(req.call_args.args[1],'/prepare');self.assertEqual(self.s['jobs'],{})
   r=m.submit(self.s,'13800000002','order-2');self.assertFalse(r['accepted']);self.assertEqual(req.call_count,1)
 def test_rejected_submit_recovers_with_same_key(self):
  self.rd();seen=[]
  def req(method,path,body=None,key=None,*a):
   if path=='/prepare':return self.ready()
   seen.append(key)
   if len(seen)==1:return {'ok':False,'code':'lookup_no_available_device','accepted':False,'retryAfterSeconds':30}
   return {'ok':True,'lookupId':'lookup-111','status':'queued','reused':False}
  with patch.object(m,'request',req),patch.object(m.time,'time',lambda:self.clock):
   r=m.submit(self.s,'13800000001','order-1');self.assertFalse(r['accepted']);self.assertNotIn('lookupId',self.s['jobs']['order-1']);key=self.s['jobs']['order-1']['key']
   self.clock=10;r=m.submit(self.s,'13800000001','order-1');self.assertFalse(r['accepted']);self.assertEqual(len(seen),1)
   self.clock=31;r=m.submit(self.s,'13800000001','order-1');self.assertEqual(r['lookupId'],'lookup-111');self.assertEqual(seen,[key,key])
 def test_queued_capacity_hint_is_not_failure(self):
  self.job()
  response={'ok':True,'lookupId':'lookup-111','status':'queued','code':'lookup_no_available_device','acceptingRequests':False,'retryAfterSeconds':30}
  with patch.object(m,'request',side_effect=[response,{'ok':True,'lookupId':'lookup-111','status':'completed','name':'张*'}]) as req,patch.object(m.time,'monotonic',lambda:self.clock),patch.object(m.time,'sleep',self.sleep):
   r=m.result(self.s,'order-1',40);self.assertEqual(r['name'],'张*');self.assertEqual(self.clock,30);self.assertTrue(all(c.args[:2]==('GET','/tasks/lookup-111') for c in req.call_args_list))
 def test_unknown_response_after_prior_rejection_reconciles_first(self):
  self.rd();count=0;seen=[]
  def req(method,path,body=None,key=None,*a):
   nonlocal count
   if path=='/prepare':return self.ready()
   seen.append(key);count+=1
   if count==1:return {'ok':False,'code':'lookup_no_available_device','accepted':False,'retryAfterSeconds':30}
   if count==2:raise RuntimeError('response lost')
   return {'ok':True,'lookupId':'lookup-111','status':'processing','reused':True}
  with patch.object(m,'request',req),patch.object(m.time,'time',lambda:self.clock):
   m.submit(self.s,'13800000001','order-1');self.clock=31
   with self.assertRaises(RuntimeError):m.submit(self.s,'13800000001','order-1')
   self.assertNotIn('confirmedNotAccepted',self.s['jobs']['order-1']);self.assertTrue(m.submit(self.s,'13800000001','order-1')['reused']);self.assertEqual(len(set(seen)),1)
 def test_http_503_keeps_retry_header_and_no_lookup_id(self):
  class Resp:
   status_code=503;headers={'Retry-After':'45'}
   def __enter__(self):return self
   def __exit__(self,*a):pass
   def json(self):return {'ok':False,'code':'lookup_no_available_device','accepted':False,'retryAfterSeconds':30}
  with patch.object(m.requests,'request',return_value=Resp()):
   r=m.request('POST','/tasks',{},'query-key-1');self.assertFalse(r['accepted']);self.assertNotIn('lookupId',r);self.assertEqual(r['retryAfterSeconds'],45)
 def test_processing_and_completed_never_resubmit_when_paused(self):
  self.job();self.s['sendPauseUntil']=time_value=999999999999
  with patch.object(m,'request',side_effect=[{'ok':True,'lookupId':'lookup-111','status':'processing'},{'ok':True,'lookupId':'lookup-111','status':'completed','name':''}]) as req,patch.object(m.time,'monotonic',lambda:self.clock),patch.object(m.time,'sleep',self.sleep):
   self.assertEqual(m.result(self.s,'order-1',20)['name'],'');self.assertEqual(self.clock,5);self.assertTrue(all(c.args[0]=='GET' for c in req.call_args_list))
if __name__=='__main__':unittest.main()
