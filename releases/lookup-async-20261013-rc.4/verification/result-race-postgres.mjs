// Dedicated loopback PostgreSQL fixture; synthetic state, no physical devices.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import {createManagedLookupStore} from '../server/managed-lookup-store.mjs';
import {createManagedLookupService} from '../server/managed-lookup.mjs';
const url=new URL(process.env.MANAGED_LOOKUP_TEST_DATABASE_URL);
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/lookup_result_fixture');
const pool=new pg.Pool({connectionString:url.toString()});let service;
const key='result-race',clientId='synthetic-client',input={clientId,phoneNumber:'13800000001',key:'original-key'};
let clock=Date.now(),observation={ready:true};const actions=[];
const adapter={clientValid:()=>true,health:()=>({ready:true}),canStop:()=>true,observe:()=>observation,
 start:async c=>{c.sessionId='synthetic-session';actions.push('start');},query:async(c,r)=>{c.queryId=r.queryId='synthetic-query';actions.push('query');},stop:async()=>actions.push('stop')};
const open=async()=>{const store=await createManagedLookupStore({getPool:async()=>pool,key});service=createManagedLookupService({store,adapter,now:()=>clock});return store;};
try{
 for(const file of ['20261013-managed-lookup.sql','20261013-managed-lookup-async.sql'])await pool.query(await fs.readFile(new URL('../deploy/sql/'+file,import.meta.url),'utf8'));
 let store=await open();await store.transact(s=>{s.config.enabled=true;s.devices=[{deviceId:'synthetic118',deviceNumber:118,enabled:true}];s.grants=[{clientId,enabled:true,consentReference:'synthetic-consent'}];});
 const first=await service.submitAsync(input);await service.tick();await service.tick();assert.deepEqual(actions,['start','query']);
 observation={busy:true};await service.cancel(first.lookupId,'fixture');await service.tick();assert.equal(service.reserved('synthetic118').phase,'stopping');
 observation={busy:true,result:{resultId:'synthetic-query',status:'succeeded',name:'测*'}};await service.tick();
 assert.equal((await service.getAsyncResult(first.lookupId,clientId)).name,'测*');
 const archived=(await pool.query('select data from phone_cloud_managed_lookup_results where state_key=$1 and client_id=$2 and lookup_id=$3',[key,clientId,first.lookupId])).rows[0]?.data;
 assert.equal(archived.name,'测*');const completedAt=archived.completedAt;
 clock+=121000;const alias=await service.submitAsync({...input,key:'new-key-after-two-minutes'});assert.equal(alias.lookupId,first.lookupId);
 await service.close();store=await open();assert.equal((await service.getAsyncResult(first.lookupId,clientId)).name,'测*');assert.equal(service.reserved('synthetic118').requestId,first.lookupId);
 clock+=700000;assert.equal((await service.submitAsync({...input,key:'new-key-after-cache-window'})).lookupId,first.lookupId);
 await store.transact(s=>{for(let n=0;n<300;n++)s.requests.push({lookupId:'archive-'+n,clientId,idempotencyKey:'archive-key-'+n,fingerprint:'synthetic-'+n,mode:'async',status:'failed',code:'fixture',name:'',createdAt:new Date().toISOString(),completedAt:new Date().toISOString(),attempts:[]});});
 assert.ok(store.snapshot().requests.some(r=>r.lookupId===first.lookupId));assert.equal((await service.submitAsync({...input,key:'new-key-after-pruning'})).lookupId,first.lookupId);
 observation={stopped:true};await service.tick();assert.equal(service.reserved('synthetic118'),undefined);assert.equal((await service.getAsyncResult(first.lookupId,clientId)).name,'测*');
 await service.close();store=await open();assert.equal((await service.submitAsync({...input,key:'new-key-after-two-minutes'})).lookupId,first.lookupId);assert.equal((await service.getAsyncResult(first.lookupId,clientId)).name,'测*');
 assert.equal((await store.readRequest(first.lookupId,clientId)).completedAt,completedAt);assert.equal(actions.filter(x=>x==='query').length,1);
 assert.notEqual((await service.submitAsync({...input,key:'genuinely-new-after-confirmed-stop'})).lookupId,first.lookupId);
 const proof={localPostgres:true,resultVisibleBeforeStopConfirmation:true,resultDurablyArchived:true,restartPreservesResultAndReservation:true,twoMinuteDifferentKeyUsesOriginal:true,expiredRecentWindowStillBound:true,pruningPreservesUnconfirmedBinding:true,stopConfirmationNeverOverwritesName:true,archivedAliasesSurviveRestart:true,completionTimeUnchanged:true,newBusinessAllowedOnlyAfterConfirmedStopAndCacheWindow:true,syntheticQueryCount:1,clockAdvanceUsed:true,physicalQueries:0,productionConnections:0};
 if(process.env.LOOKUP_RESULT_PROOF_FILE)await fs.writeFile(process.env.LOOKUP_RESULT_PROOF_FILE,JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
}finally{await service?.close();await pool.end();}
