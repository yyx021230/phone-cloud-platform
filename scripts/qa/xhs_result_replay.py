"""Replay two completed real results against isolated local HTTP/PG; no phone actions."""
from pathlib import Path
import importlib.util,json,subprocess,uuid,concurrent.futures,time,sys
root=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('live',root/'scripts/qa/xhs_candidate_live.py');live=importlib.util.module_from_spec(spec);spec.loader.exec_module(live)
if len(sys.argv)!=4:raise SystemExit('usage: xhs_result_replay.py source_phase_dir slow_phone fast_phone')
source=Path(sys.argv[1]).resolve();names=sys.argv[2:];slow_name,fast_name=names
assert source.is_dir() and slow_name!=fast_name and all(n.isascii() and n.isdigit() for n in names)
r=source.parent;phase='replay-'+uuid.uuid4().hex[:12];out=r/phase;out.mkdir(mode=0o700)
def save(n,v):
 p=out/n;p.write_text(json.dumps(v,ensure_ascii=False,indent=2));p.chmod(0o600)
targets=[t for t in json.loads((source/'targets-private.json').read_text()) if t['deviceName'] in tuple(names)]
assert len(targets)==2
answers={name:json.loads((source/('result-'+name+'-private.json')).read_text()) for name in tuple(names)};assert all(x['ok'] for x in answers.values())
database='xhs_batch_test_'+phase.replace('-','_');subprocess.run(['/opt/homebrew/opt/postgresql@16/bin/createdb','-h','127.0.0.1','-p','57503','-U','xhs_test',database],check=True,capture_output=True)
save('local-private.json',{'targets':targets,'databaseUrl':'postgresql://xhs_test@127.0.0.1:57503/'+database})
api=subprocess.Popen(['node',str(root/'scripts/qa/xhs_candidate_api.mjs'),str(out/'local-private.json')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(out/'api-stderr.log').open('w'),text=True)
def call(v):
 api.stdin.write(json.dumps(v)+'\n');api.stdin.flush();a=json.loads(api.stdout.readline());assert 'error' not in a,a;return a.get('result',a)
try:
 assert json.loads(api.stdout.readline())['ready'];run_id=call({'op':'create','requestId':phase})['batch']['runId'];tasks={}
 deadline=time.monotonic()+40
 while len(tasks)<2 and time.monotonic()<deadline:
  t=call({'op':'next'}).get('task')
  if t:tasks[next(x['deviceName'] for x in targets if x['serial']==t['adbSerial'])]=t
  else:time.sleep(.5)
 assert len(tasks)==2
 slow=concurrent.futures.Future();fast=concurrent.futures.Future();fast.set_result(fast_name);ordered=live.completed_results([slow,fast])
 name=next(ordered);assert name==fast_name and not slow.done()
 call({'op':'complete','taskId':tasks[name]['taskId'],'payload':{'status':'succeeded','result':answers[name]['result']}})
 for _ in range(30):
  pages=[call({'op':'result','runId':run_id,'offset':i}) for i in range(2)]
  rows={t['deviceName']:next(p['items'][0] for p in pages if p['items'][0]['xhsId']==t['xhsId']) for t in targets}
  if rows[fast_name]['status']=='succeeded':break
  time.sleep(.5)
 assert rows[fast_name]['status']=='succeeded' and rows[slow_name]['status']!='succeeded' and not slow.done()
 save('incremental-private.json',pages)
 slow.set_result(slow_name);name=next(ordered);call({'op':'complete','taskId':tasks[name]['taskId'],'payload':{'status':'succeeded','result':answers[name]['result']}})
 for _ in range(30):
  pages=[call({'op':'result','runId':run_id,'offset':i}) for i in range(2)]
  if pages[0]['complete']:break
  time.sleep(.5)
 assert pages[0]['complete'];save('completed-private.json',pages)
 call({'op':'restart'});restarted=[call({'op':'result','runId':run_id,'offset':i}) for i in range(2)];assert [p['items'] for p in pages]==[p['items'] for p in restarted]
 stopped=call({'op':'stop','runId':run_id})['batch'];assert stopped['stopRequestedAt'];after=call({'op':'result','runId':run_id});assert after['stopRequestedAt']==stopped['stopRequestedAt']
 save('api-stop-private.json',stopped);save('after-stop-private.json',after)
 summary={'phase':phase,'kind':'local_HTTP_replay_of_completed_real_results','sourcePhase':source.name,'newPhoneActions':0,'fastItemVisibleWhileSlowPending':True,'paginationAndRestartEqual':True,'stopApiAcknowledged':True,'stopPersisted':True,'completedCounts':pages[0]['counts']};save('summary.json',summary);print(json.dumps(summary),flush=True)
finally:
 try:call({'op':'close'})
 except Exception:pass
 api.stdin.close()
 try:api.wait(timeout=30)
 except subprocess.TimeoutExpired:api.terminate();api.wait(timeout=10)
