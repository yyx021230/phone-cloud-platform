"""Durable caller-side behavior; complements the real HTTP downloaded-bundle test."""
import sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'sdk/open_name_lookup'))
from partner_example import connect,prepare,submit_job,poll_job
from python_client import OpenNameLookupApiError
class Client:
 def __init__(self):self.keys=[];self.ids=[];self.results={}
 def submit_lookup(self,phone,*,idempotency_key):self.keys.append(idempotency_key);return {'ok':True,'lookupId':'id-one','status':'queued'}
 def get_lookup_result(self,id):
  self.ids.append(id);r=self.results.get(id,{'ok':True,'lookupId':id,'status':'processing','name':'','code':''})
  if isinstance(r,Exception):raise r
  return r
class Caller(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'caller.db';self.db=connect(self.path);self.c=Client()
 def tearDown(self):self.db.close();self.temp.cleanup()
 def test_process_reopen_reuses_key_created_before_send(self):
  key=prepare(self.db,'business','13800000001')['request_key'];self.db.close();self.db=connect(self.path);submit_job(self.db,self.c,'business','13800000001');self.assertEqual(self.c.keys,[key]);submit_job(self.db,self.c,'business','13800000001');self.assertEqual(len(self.c.keys),1)
 def test_same_business_other_phone_rejected_before_send(self):
  prepare(self.db,'business','13800000001')
  with self.assertRaises(ValueError):submit_job(self.db,self.c,'business','13800000002')
  self.assertEqual(self.c.keys,[])
 def populate(self):
  for i in range(3):
   prepare(self.db,str(i),'1380000000'+str(i+1))
   with self.db:self.db.execute('UPDATE lookup_jobs SET lookup_id=?,status=? WHERE business_id=?',('id-'+str(i),'queued',str(i)))
 def test_first_record_http_failure_does_not_skip_next_result(self):
  self.populate();self.c.results['id-0']=OpenNameLookupApiError('offline',code='network_error');self.c.results['id-1']={'ok':True,'lookupId':'id-1','status':'succeeded','name':'测*','code':''};poll_job(self.db,self.c);self.assertEqual(self.db.execute("select status from lookup_jobs where business_id='0'").fetchone()[0],'queued');self.assertEqual(self.db.execute("select name from lookup_jobs where business_id='1'").fetchone()[0],'测*');self.assertEqual(self.c.keys,[])
 def test_bounded_scan_rotates_pending_records(self):
  self.populate();poll_job(self.db,self.c,limit=1);poll_job(self.db,self.c,limit=1);self.assertEqual(self.c.ids,['id-0','id-1'])
 def test_invalid_success_is_not_empty_backfill(self):
  submit_job(self.db,self.c,'business','13800000001');self.c.results['id-one']={'ok':True,'lookupId':'id-one','status':'succeeded','name':'','code':''};self.assertEqual(poll_job(self.db,self.c)[0]['httpError'],'invalid_response');self.assertEqual(self.db.execute('select status from lookup_jobs').fetchone()[0],'queued')
if __name__=='__main__':unittest.main()
