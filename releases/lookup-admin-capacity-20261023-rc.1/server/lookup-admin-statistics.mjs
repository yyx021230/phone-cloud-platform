const done=new Set(['succeeded','not_found','failed','cancelled','expired']);
export function lookupDay(now=Date.now()){
 const date=new Date(now+8*3600000).toISOString().slice(0,10);
 const start=new Date(date+'T00:00:00+08:00').toISOString();
 return {date,timeZone:'Asia/Shanghai',start,end:new Date(Date.parse(start)+86400000).toISOString()};
}
export function lookupStatistics(rows,now=Date.now()){
 const day=lookupDay(now),inside=v=>typeof v==='string'&&v>=day.start&&v<day.end;
 const business=[...new Map(rows.filter(r=>r.lookupId&&r.purpose!=='readiness_probe').map(r=>[r.lookupId,r])).values()];
 const finished=business.filter(r=>done.has(r.status)),today=finished.filter(r=>inside(r.completedAt));
 const phones=records=>new Set(records.flatMap(r=>(r.attempts||[]).filter(a=>a.deviceId&&inside(a.at)).map(a=>a.deviceId))).size;
 return {day,all:{submitted:business.length,completed:finished.length,named:finished.filter(r=>r.status==='succeeded'&&String(r.name||'').trim()).length,empty:finished.filter(r=>r.status==='not_found').length,failed:finished.filter(r=>['failed','expired'].includes(r.status)).length,cancelled:finished.filter(r=>r.status==='cancelled').length},today:{submitted:business.filter(r=>inside(r.createdAt)).length,completed:today.length,named:today.filter(r=>r.status==='succeeded'&&String(r.name||'').trim()).length,empty:today.filter(r=>r.status==='not_found').length,failed:today.filter(r=>['failed','expired'].includes(r.status)).length,cancelled:today.filter(r=>r.status==='cancelled').length,devicesUsed:phones(business)},retention:'stored_business_requests',counting:'canonical_lookup_id_excludes_probes_and_replays'};
}
// Single PostgreSQL snapshot: prefer live state over its archived overlap.
// Aggregate in the database; never transfer all historical phone/name rows.
export const LOOKUP_STATISTICS_SQL=`WITH live AS (
 SELECT DISTINCT ON (r->>'lookupId') r AS data FROM phone_cloud_managed_lookup m,
 LATERAL jsonb_array_elements(coalesce(m.data->'requests','[]'::jsonb)) r
 WHERE m.state_key=$1
), business AS (
 SELECT data FROM live WHERE coalesce(data->>'purpose','')<>'readiness_probe'
 UNION ALL
 SELECT a.data FROM phone_cloud_managed_lookup_results a WHERE a.state_key=$1
 AND coalesce(a.data->>'purpose','')<>'readiness_probe'
 AND NOT EXISTS(SELECT 1 FROM live l WHERE l.data->>'lookupId'=a.lookup_id)
), counts AS (
 SELECT count(*) AS submitted,
 count(*) FILTER(WHERE data->>'createdAt'>=$2 AND data->>'createdAt'<$3) AS today_submitted,
 count(*) FILTER(WHERE data->>'status' IN ('succeeded','not_found','failed','expired','cancelled')) AS completed,
 count(*) FILTER(WHERE data->>'status'='succeeded' AND btrim(coalesce(data->>'name',''))<>'') AS named,
 count(*) FILTER(WHERE data->>'status'='not_found') AS empty,
 count(*) FILTER(WHERE data->>'status' IN ('failed','expired')) AS failed,
 count(*) FILTER(WHERE data->>'status'='cancelled') AS cancelled,
 count(*) FILTER(WHERE data->>'completedAt'>=$2 AND data->>'completedAt'<$3 AND data->>'status' IN ('succeeded','not_found','failed','expired','cancelled')) AS today_completed,
 count(*) FILTER(WHERE data->>'completedAt'>=$2 AND data->>'completedAt'<$3 AND data->>'status'='succeeded' AND btrim(coalesce(data->>'name',''))<>'') AS today_named,
 count(*) FILTER(WHERE data->>'completedAt'>=$2 AND data->>'completedAt'<$3 AND data->>'status'='not_found') AS today_empty,
 count(*) FILTER(WHERE data->>'completedAt'>=$2 AND data->>'completedAt'<$3 AND data->>'status' IN ('failed','expired')) AS today_failed,
 count(*) FILTER(WHERE data->>'completedAt'>=$2 AND data->>'completedAt'<$3 AND data->>'status'='cancelled') AS today_cancelled
 FROM business
) SELECT counts.*, (SELECT count(DISTINCT a->>'deviceId') FROM business b,LATERAL jsonb_array_elements(coalesce(b.data->'attempts','[]'::jsonb)) a WHERE a->>'at'>=$2 AND a->>'at'<$3 AND coalesce(a->>'deviceId','')<>'') AS today_devices FROM counts`;
export function statisticsFromSql(row,now){
 const result=lookupStatistics([],now);
 for(const k of ['submitted','completed','named','empty','failed','cancelled']){result.all[k]=Number(row[k]);result.today[k]=Number(row['today_'+k]);}
 result.today.devicesUsed=Number(row.today_devices);return result;
}
