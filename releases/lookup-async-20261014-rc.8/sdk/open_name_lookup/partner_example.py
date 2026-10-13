"""Two independent integration jobs with durable identity (SQLite demonstration).
Use a private DB file; phone/name are personal data. No credentials are persisted.
Run with BASE_URL, CLIENT_ID, CLIENT_SECRET in environment. See PARTNER_HANDOFF.md.
"""
import argparse,json,os,sqlite3,time,uuid
from python_client import OpenNameLookupClient,OpenNameLookupApiError

TERMINAL={'succeeded','not_found','failed'}
def connect(path):
 db=sqlite3.connect(path,timeout=10);db.row_factory=sqlite3.Row
 db.execute('CREATE TABLE IF NOT EXISTS lookup_jobs (business_id TEXT PRIMARY KEY, phone TEXT NOT NULL, request_key TEXT UNIQUE NOT NULL, lookup_id TEXT, status TEXT NOT NULL DEFAULT \'pending_submission\', name TEXT NOT NULL DEFAULT \'\', code TEXT NOT NULL DEFAULT \'\', last_polled REAL NOT NULL DEFAULT 0)');db.commit();return db

def prepare(db,business_id,phone):
 # Commit the business key BEFORE the first HTTP send. Concurrent submitters
 # use the same row/key; business_id must come from your own stable record ID.
 with db:
  db.execute('INSERT OR IGNORE INTO lookup_jobs(business_id,phone,request_key) VALUES(?,?,?)',(business_id,phone,str(uuid.uuid4())))
  row=db.execute('SELECT * FROM lookup_jobs WHERE business_id=?',(business_id,)).fetchone()
  if row['phone']!=phone:raise ValueError('business_id already belongs to a different phone')
 return dict(row)

def submit_job(db,client,business_id,phone):
 row=prepare(db,business_id,phone)
 if row['lookup_id']:return row['lookup_id']
 accepted=client.submit_lookup(phone,idempotency_key=row['request_key'])
 if accepted.get('ok') is not True or not isinstance(accepted.get('lookupId'),str) or not accepted['lookupId'] or accepted.get('status') not in {'queued','processing',*TERMINAL}:
  raise ValueError('invalid submission response; retain original business key')
 with db:
  current=db.execute('SELECT lookup_id FROM lookup_jobs WHERE business_id=?',(business_id,)).fetchone()[0]
  if current and current!=accepted['lookupId']:raise ValueError('lookup identity changed; stop and investigate')
  # A terminal POST response is still fetched by the result job for its name.
  db.execute('UPDATE lookup_jobs SET lookup_id=?, status=CASE WHEN status=\'pending_submission\' THEN \'queued\' ELSE status END WHERE business_id=?',(accepted['lookupId'],business_id))
 return accepted['lookupId']

def poll_job(db,client,limit=50):
 outcomes=[]
 for row in db.execute("SELECT * FROM lookup_jobs WHERE lookup_id IS NOT NULL AND status NOT IN ('succeeded','not_found','failed') ORDER BY last_polled,rowid LIMIT ?",(limit,)).fetchall():
  try:
   with db:db.execute('UPDATE lookup_jobs SET last_polled=? WHERE business_id=?',(time.time(),row['business_id']))
   result=client.get_lookup_result(row['lookup_id'])
   status=result.get('status');name=result.get('name');code=result.get('code')
   if result.get('ok') is not True or result.get('lookupId')!=row['lookup_id'] or status not in {'queued','processing',*TERMINAL} or not isinstance(name,str) or not isinstance(code,str) or (status=='succeeded' and not name) or (status!='succeeded' and name):
    raise ValueError('invalid result response; do not store an empty success')
   with db:
    # Put your own business-table backfill in this transaction or use a durable
    # outbox with a UNIQUE lookup_id. Never submit again because backfill failed.
    db.execute("UPDATE lookup_jobs SET status=?,name=?,code=? WHERE business_id=? AND lookup_id=? AND status NOT IN ('succeeded','not_found','failed')",(status,name,code,row['business_id'],row['lookup_id']))
   outcomes.append({'businessId':row['business_id'],'status':status})
  except OpenNameLookupApiError as error:
   outcomes.append({'businessId':row['business_id'],'httpError':error.code,'retryAfterSeconds':error.retry_after_seconds})
  except ValueError:
   outcomes.append({'businessId':row['business_id'],'httpError':'invalid_response'})
 return outcomes

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('action',choices=['submit','poll']);p.add_argument('--db',required=True);p.add_argument('--business-id');a=p.parse_args()
 client=OpenNameLookupClient(base_url=os.environ['BASE_URL'],client_id=os.environ['CLIENT_ID'],secret=os.environ['CLIENT_SECRET'])
 with connect(a.db) as db:
  if a.action=='submit':
   if not a.business_id:p.error('--business-id is required')
   print(json.dumps({'lookupId':submit_job(db,client,a.business_id,os.environ['PHONE_NUMBER'])}))
  else:print(json.dumps(poll_job(db,client),ensure_ascii=False))
