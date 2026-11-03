// Executes the actual reader's control logic with fake PG/runtime views.
// SQL is captured, not executed against a database. No production network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=fs.readFileSync(new URL('./wecom_single_reader.mjs',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'');
const hash='4bcecc8702ea577a77e5f17664b7833ced33b681f88e5beedcdc6875b6f047cc';
async function run(change={}){
  const queries=[],routes=[],logs=[];
  const target={deviceId:'adb:Fixture',serial:'Fixture',deviceNumber:'59'};
  const pool={devices:[],channels:[],preparations:[],roundStops:[],...change.pool};
  class Client{
    async connect(){}
    async end(){}
    async query(sql,values){
      queries.push({sql,values});let rows=[];
      if(sql.includes('transaction_read_only'))rows=[{mode:'on',at:new Date().toISOString()}];
      if(sql.includes('FROM phone_cloud_devices'))rows=change.devices||[{device_id:target.deviceId,data:{deviceId:target.deviceId,deviceName:'59',listingStatus:'listed',adb:{serial:target.serial,agentId:'agent',state:'device'}}}];
      if(sql.includes('FROM phone_cloud_managed_lookup'))rows=[{data:pool}];
      return{rows};
    }
  }
  const process={env:{ADMIN_API_TOKEN:'fake-local-only',DATABASE_URL:'fake'},exitCode:0,
    stdin:{async *[Symbol.asyncIterator](){yield JSON.stringify({target});}}};
  const context={fs:{readFileSync:()=>''},createHash:()=>({update(){return this;},digest:()=>hash}),
    pg:{Client},process,Date,Buffer,AbortSignal,console:{log:x=>logs.push(JSON.parse(x))},
    fetch:async url=>{routes.push(url);return{status:200,json:async()=>({devices:[{deviceNumber:'59',online:true,listed:true,busy:false}]})};}};
  await vm.runInNewContext('(async()=>{'+source+'})()',context);
  return{result:logs.at(-1),exitCode:process.exitCode,queries,routes};
}

test('target snapshot stays read-only and uses pure runtime inventory',async()=>{
  const r=await run();assert.equal(r.exitCode,0);assert.equal(r.result.lookupExcluded,true);
  assert.equal(r.queries[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(r.queries.at(-1).sql,'ROLLBACK');
  assert.deepEqual(r.routes,['http://127.0.0.1:8787/api/v1/wecom/devices']);
  assert.ok(r.queries.every(q=>!/^(?:INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i.test(q.sql)));
  const lock=r.queries.find(q=>q.sql.includes('phone_cloud_device_locks')).sql;
  assert.match(lock,/physicalCleanup,legacySerial/);assert.match(lock,/lower\(/);
});
test('unknown stop array shape rejects rather than treating it as empty',async()=>{
  for(const key of ['preparations','roundStops']){
    const r=await run({pool:{[key]:null}});assert.equal(r.exitCode,1);assert.equal(r.result.error,'qa_single_read_unknown');
  }
});
test('failed matching stop and disabled device channel are still exclusion evidence',async()=>{
  for(const pool of [{roundStops:[{status:'failed',serial:'FIXTURE'}]},
    {preparations:[{status:'stopped',deviceId:'ADB:FIXTURE'}]},
    {channels:[{deviceId:'Adb:FiXtUrE'}]}]){
    assert.equal((await run({pool})).result.lookupExcluded,false);
  }
});
test('another phones historical stop does not block this target',async()=>{
  assert.equal((await run({pool:{roundStops:[{status:'failed',deviceId:'adb:other'}]}})).result.lookupExcluded,true);
});
test('multiple physical aliases deny admission',async()=>{
  const r=await run({devices:[{device_id:'adb:Fixture'},{device_id:'adb:FIXTURE'}]});
  assert.equal(r.exitCode,1);assert.equal(r.result.error,'qa_single_read_unknown');
});
