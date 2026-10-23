import assert from 'node:assert/strict';import crypto from 'node:crypto';import pg from 'pg';
import {createManagedLookupStore,initialManagedLookupState} from '../server/managed-lookup-store.mjs';import {lookupStatistics} from '../server/lookup-admin-statistics.mjs';import {parseLookupCursor} from '../server/lookup-admin-console.mjs';
const url=process.env.MANAGED_LOOKUP_TEST_DATABASE_URL;assert.equal(new URL(url).hostname,'127.0.0.1');
const db=new pg.Pool({connectionString:url}),key='admin-readonly-'+crypto.randomUUID(),at='2026-10-21T01:00:00.000Z';let store;
try{
 const state=initialManagedLookupState();state.requests=Array.from({length:12},(_,i)=>({lookupId:'q'+String(i).padStart(3,'0'),clientId:'test',idempotencyKey:'id-'+i,createdAt:at,status:'succeeded',name:'测',completedAt:at}));
 await db.query('insert into phone_cloud_managed_lookup(state_key,data) values($1,$2)',[key,state]);
 for(let i=0;i<65;i++){const r={lookupId:'q'+String(i).padStart(3,'0'),clientId:'test',idempotencyKey:'id-'+i,createdAt:at,status:'succeeded',name:'测',completedAt:at};await db.query('insert into phone_cloud_managed_lookup_results(state_key,lookup_id,client_id,idempotency_key,completed_at,data) values($1,$2,$3,$4,$5,$6)',[key,r.lookupId,r.clientId,r.idempotencyKey,at,r]);}
 store=await createManagedLookupStore({getPool:async()=>db,key});const before=JSON.stringify(store.snapshot());let cursor=null,ids=[];
 do{const page=await store.adminRequests(cursor);ids.push(...page.requests.map(r=>r.lookupId));cursor=parseLookupCursor(page.nextCursor);}while(cursor);
 const stats=await store.adminStatistics(Date.parse(at));assert.equal(stats.all.submitted,65);assert.equal(stats.today.submitted,65);assert.equal(stats.today.named,65);
 assert.equal(ids.length,65);assert.equal(new Set(ids).size,65);assert.equal((await store.adminRequest('q064')).name,'测');assert.equal(await store.adminRequest('no-such-id'),null);assert.equal(JSON.stringify(store.snapshot()),before);
 assert.equal(JSON.stringify((await db.query('select data from phone_cloud_managed_lookup where state_key=$1',[key])).rows[0].data),JSON.stringify(JSON.parse(before)));
 const revision=store.snapshot().revision;await store.transact(s=>{s.config.concurrency=8;});await store.close();store=await createManagedLookupStore({getPool:async()=>db,key});assert.equal(store.snapshot().config.concurrency,8);assert.equal((await store.adminStatistics(Date.parse(at))).all.submitted,65);
 console.log(JSON.stringify({statisticsArchiveOverlapExact:true,statisticsAfterRestart:true,configPersisted:true,storage:'isolated-postgres',archiveRows:65,liveOverlap:12,paginationExact:true,archivedDetail:true,statisticsReadOnly:true,productionConnections:0}));
}finally{if(store)await store.close();await db.query('delete from phone_cloud_managed_lookup_results where state_key=$1',[key]);await db.query('delete from phone_cloud_managed_lookup where state_key=$1',[key]);await db.end();}
