from pathlib import Path
import json,datetime,collections,math
b=Path('/tmp/pc-external-50-20261016');s=json.loads((b/'STATE.json').read_text());a=json.loads((b/'AUDIT_COMPLETE.json').read_text());hist=[json.loads(x) for x in (b/'OBSERVER_HISTORY.jsonl').read_text().splitlines()];events=[json.loads(x) for x in (b/'EVENTS.jsonl').read_text().splitlines()]
ts=lambda x:datetime.datetime.fromisoformat(x.replace('Z','+00:00')).timestamp()
tasks={}
for h in hist:
 for t in h['tasks']:tasks[t['taskId']]=t
businessIds={e['taskId'] for r in a['rows'] for e in r['executions']}
for r in a['rows']:
 for e in r['executions']:
  t=tasks.get(e['taskId'],{});t.update({k:e[k] for k in ['taskId','status','createdAt','pickedAt','completedAt'] if k in e});t['number']=e['number'];tasks[e['taskId']]=t
cutoff=max(ts(h['at']) for h in hist)
def peak(ids):
 points=[]
 for tid in ids:
  t=tasks[tid]
  if not t.get('pickedAt'):continue
  start=ts(t['pickedAt']);end=ts(t['completedAt']) if t.get('completedAt') else cutoff
  if end<=start:continue
  points.extend([(start,1,t['number']),(end,-1,t['number'])])
 counts=collections.Counter();maximum=0
 for at,delta,n in sorted(points,key=lambda x:(x[0],x[1])):
  counts[n]+=delta;maximum=max(maximum,sum(v>0 for v in counts.values()))
 return maximum
http=[e for e in events if e['event']=='http'];retries=[r for r in s['rows'] if r.get('retryVerified')];lat=sorted((r['completedAt']-r['firstSubmittedAt'])/1000 for r in s['rows'])
first20=s['rows'][:20];byNumber=collections.Counter(e['number'] for r in a['rows'] for e in r['executions'] if e['status']=='succeeded');rdy=[e for e in events if e['event']=='ready-change' and e['ready']]
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':'local external HTTP client using published SDK','version':'lookup-readiness-20261016-deployed.15','runtimeCommit':'419defa1b9a59891592574e220ab5b9f79594e09','sourceIndices':{'offset':100,'count':50},'uniqueAccepted':len({r['lookupId'] for r in s['rows']}),'completed':sum(r['status']=='completed' for r in s['rows']),'withName':sum(r.get('hasName') is True for r in s['rows']),'emptyName':sum(r.get('hasName') is False for r in s['rows']),'failed':sum(r['status']=='failed' for r in s['rows']),'queryTasks':sum(len(r['executions']) for r in a['rows']),'inputPhoneEvents':sum(e['inputPhoneCount'] for r in a['rows'] for e in r['executions']),'multipleAttemptRows':sum(len(r['executions'])>1 for r in a['rows']), 'duplicateInputRows':sum(sum(e['inputPhoneCount'] for e in r['executions'])!=1 for r in a['rows']),'inflightNewKeyRetries':len(retries),'allRetryIdsUnchanged':all(e['sameId'] for e in events if e['event']=='retry'),'retryElapsedRangeMs':[min(r['retryElapsedMs'] for r in retries),max(r['retryElapsedMs'] for r in retries)],'retryStatuses':dict(collections.Counter(r['statusAtRetry'] for r in retries)),'maxObservedQueuedBusiness':max(sum(r.get('purpose')!='readiness_probe' and r['status']=='queued' for r in h['requests']) for h in hist),'maxClientUnfinished':max(e['unfinished'] for e in events if e['event']=='summary'),'peakBusinessPhonesByTaskIntervals':peak(businessIds),'peakAllLookupPhonesByTaskIntervals':peak(set(tasks)),'businessByDevice':dict(byNumber),'first20BurstMs':max(r['acceptedAt'] for r in first20)-min(r['acceptedAt'] for r in first20),'businessElapsedSeconds':round((max(r['completedAt'] for r in s['rows'])-min(r['firstSubmittedAt'] for r in s['rows']))/1000,3),'latencySeconds':{'p50':lat[24],'p95':lat[47],'max':lat[-1]},'httpCalls':len(http),'httpStatuses':dict(collections.Counter(e['http'] for e in http)),'publicMethodsAndPaths':dict(collections.Counter(e['method']+' '+e['path'] for e in http)),'readyCountExposed':any('readyCount' in e['keys'] for e in http),'sdkZipSha256':'e24488a2efdc8aab71dc84757aae480afa1b0d9da6c49f256a4a8b7ffe08e921','firstReadyAt':rdy[0]['at'],'latestPendingProbeCount':sum(r.get('purpose')=='readiness_probe' and r['status'] not in ['succeeded','not_found','failed','cancelled','expired'] for r in hist[-1]['requests']),'naturalBusinessLimitHandoffObserved':any(r.get('attemptCount',0)>1 and any(e['errorCode']=='alipay_prepared_account_limited' for e in r['executions']) for r in a['rows']),'fiveBusinessPhonesSimultaneouslyVerified':peak(businessIds)==5,'allProductionAcceptanceComplete':False}
assert out['uniqueAccepted']==out['completed']==out['inputPhoneEvents']==50
assert out['queryTasks']==51 and out['duplicateInputRows']==0
assert out['peakAllLookupPhonesByTaskIntervals']<=5
assert not out['readyCountExposed']
(b/'SUMMARY.json').write_text(json.dumps(out,indent=2)+'\n');(b/'TASK_TIMELINE.json').write_text(json.dumps(list(tasks.values()),indent=2)+'\n');print(json.dumps(out))
