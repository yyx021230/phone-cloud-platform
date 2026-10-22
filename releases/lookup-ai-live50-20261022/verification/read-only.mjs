// Run via docker exec stdin; never prints phone/name/credentials.
import pg from 'pg';
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('BEGIN READ ONLY');
const s=(await c.query("select data from phone_cloud_managed_lookup where state_key='default'")).rows[0].data;
const archived=(await c.query("select data from phone_cloud_managed_lookup_results where state_key='default' and idempotency_key like 'ai-live50-20261022-query-%'")).rows.map(x=>x.data);
const map=new Map(archived.map(r=>[r.lookupId,r]));for(const r of s.requests)if(r.idempotencyKey?.startsWith('ai-live50-20261022-query-'))map.set(r.lookupId,r);
const rows=[...map.values()];const num=id=>s.devices.find(d=>d.deviceId===id)?.deviceNumber;
const result={at:new Date().toISOString(),rows:rows.map(r=>({index:Number(r.idempotencyKey.split('-').at(-1)),lookupId:r.lookupId,status:r.status,code:r.code||'',createdAt:r.createdAt,completedAt:r.completedAt||null,hasName:!!r.name,attempts:r.attempts.map(a=>({device:num(a.deviceId),at:a.at,sessionId:a.sessionId})),ai:r.aiVision?{status:r.aiVision.status,reason:r.aiVision.reason,startedAt:r.aiVision.startedAt,completedAt:r.aiVision.completedAt,elapsedMs:r.aiVision.elapsedMs,jobId:r.aiVision.jobId,evidenceId:r.aiVision.evidenceId}:null})).sort((a,b)=>a.index-b.index),audits:s.audits.filter(a=>a.at>='2026-10-22T09:22:00Z').map(a=>({at:a.at,action:a.action,lookupId:a.lookupId,deviceId:a.deviceId}))};
console.log(JSON.stringify(result));await c.query('ROLLBACK');await c.end();
