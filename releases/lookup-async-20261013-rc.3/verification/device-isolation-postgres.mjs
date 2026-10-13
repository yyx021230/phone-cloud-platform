// Isolated PostgreSQL only. Synthetic state, no Agent/ADB or physical queries.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import {createManagedLookupStore} from '../server/managed-lookup-store.mjs';
import {createManagedLookupService} from '../server/managed-lookup.mjs';

const url=new URL(process.env.MANAGED_LOOKUP_TEST_DATABASE_URL);
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/lookup_isolation_fixture');
const pool=new pg.Pool({connectionString:url.toString()}),services=[];
const row=async key=>(await pool.query('select data from phone_cloud_managed_lookup where state_key=$1',[key])).rows[0].data;
const r=(id,status='running')=>({lookupId:id,clientId:'fixture',idempotencyKey:'key-'+id,fingerprint:'synthetic-'+id,phoneNumber:'13800000001',mode:'async',status,attempts:[],createdAt:new Date().toISOString(),deadline:Date.now()+1800000,executionDeadline:Date.now()+3600000,name:''});
const c=(n,id,phase='querying')=>({deviceId:'d'+n,deviceNumber:n,clientId:'fixture',generation:'gen-'+n,sessionId:'s-'+id,queryId:'q-'+id,requestId:id,phase});
async function setup(key,numbers,channels,requests){
  const store=await createManagedLookupStore({getPool:async()=>pool,key});
  await store.transact(s=>{s.config.enabled=true;s.config.concurrency=5;s.devices=numbers.map(n=>({deviceId:'d'+n,deviceNumber:n,enabled:true}));s.grants=[{clientId:'fixture',enabled:true,consentReference:'synthetic-consent'}];s.channels=channels;s.requests=requests;});
  const observations={},events=[];
  const adapter={clientValid:()=>true,health:()=>({ready:true}),canStop:()=>true,observe:channel=>observations[channel.deviceId]||{busy:true},start:async()=>events.push('start'),query:async()=>events.push('query'),stop:async()=>events.push('stop')};
  const service=createManagedLookupService({store,adapter});services.push(service);return {store,service,adapter,observations,events};
}
try{
  for(const file of ['20261013-managed-lookup.sql','20261013-managed-lookup-async.sql'])await pool.query(await fs.readFile(new URL('../deploy/sql/'+file,import.meta.url),'utf8'));
  await pool.query(`create table fixture_commit_observations(id bigint generated always as identity, state_key text, done_count integer);
    create function fixture_watch_commits() returns trigger language plpgsql as $$ begin
      if NEW.state_key='storage-failure' and exists(select 1 from jsonb_array_elements(NEW.data->'requests') r where r->>'lookupId'='second' and r->>'status'='succeeded') then raise exception 'synthetic persistence rejection'; end if;
      insert into fixture_commit_observations(state_key,done_count) select NEW.state_key,count(*) from jsonb_array_elements(NEW.data->'requests') r where r->>'status'='succeeded'; return NEW;
    end $$;
    create trigger fixture_commit_watch before update on phone_cloud_managed_lookup for each row execute function fixture_watch_commits();`);

  const numbers=[118,130,161,162,142],five=await setup('five',numbers,numbers.map(n=>c(n,'r'+n)),numbers.map(n=>r('r'+n)));
  for(const n of numbers)five.observations['d'+n]={result:{status:'succeeded',name:'测*'}};
  const before=(await pool.query('select coalesce(max(id),0) as id from fixture_commit_observations')).rows[0].id;
  await five.service.tick();
  const visible=(await pool.query('select done_count from fixture_commit_observations where state_key=$1 and id>$2 order by id',['five',before])).rows.map(x=>x.done_count);
  assert.deepEqual(visible,[1,2,3,4,5]);assert.equal((await pool.query('select count(*) from phone_cloud_managed_lookup_results where state_key=$1',['five'])).rows[0].count,'5');

  const held=await setup('held',[130,118],[c(130,'done'),{...c(118,'old','idle'),requestId:'',idleAt:1}],[r('done')]);
  held.observations.d130={result:{status:'succeeded',name:'测*'}};held.observations.d118={ready:true};
  let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  held.adapter.stop=async()=>{entered();await gate;throw Error('synthetic device failure');};
  const tick=held.service.tick(),rejected=assert.rejects(tick);
  try{await started;assert.equal((await row('held')).requests[0].status,'succeeded');assert.equal((await held.service.getAsyncResult('done','fixture')).name,'测*');}
  finally{release();await rejected;}
  assert.equal((await row('held')).channels.find(x=>x.deviceId==='d118').phase,'idle');
  await held.service.close();services.splice(services.indexOf(held.service),1);
  const reopened=await createManagedLookupStore({getPool:async()=>pool,key:'held'});
  assert.equal((await reopened.readRequest('done','fixture')).name,'测*');assert.equal(reopened.snapshot().channels.find(x=>x.deviceId==='d118').sessionId,'s-old');
  await assert.rejects(createManagedLookupStore({getPool:async()=>pool,key:'held'}),/already_active/);await reopened.close();

  const failed=await setup('storage-failure',[118,130],[c(118,'first'),c(130,'second')],[r('first'),r('second'),r('queued','queued')]);
  failed.observations.d118={result:{status:'succeeded',name:'测*'}};failed.observations.d130={result:{status:'succeeded',name:'测*'}};
  await assert.rejects(failed.service.tick(),/synthetic persistence rejection/);
  const after=await row('storage-failure');assert.equal(after.requests[0].status,'succeeded');assert.equal(after.requests[1].status,'running');assert.equal(failed.events.length,0);

  const proof={postgresOnly:true,independentCommitCounts:visible,resultReadableWhileOtherStopPending:true,deviceErrorRollsBackOnlyItsDevice:true,reopenPreservesNameAndUnconfirmedReservation:true,ownerLock:true,laterSqlFailureKeepsPriorResult:true,storageFailureStopsNewDispatch:true,physicalPhoneQueries:0,productionConnections:0};
  if(process.env.LOOKUP_ISOLATION_PROOF_FILE)await fs.writeFile(process.env.LOOKUP_ISOLATION_PROOF_FILE,JSON.stringify(proof,null,2)+'\n');
  console.log(JSON.stringify(proof));
}finally{for(const service of services)await service.close();await pool.end();}
