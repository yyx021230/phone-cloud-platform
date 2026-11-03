// Executes the actual reader's control logic with fake PG/runtime views.
// SQL is captured, not executed against a database. No production network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {EventEmitter} from 'node:events';

const source=fs.readFileSync(new URL('./wecom_single_reader.mjs',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'');
const hash='4bcecc8702ea577a77e5f17664b7833ced33b681f88e5beedcdc6875b6f047cc';
async function run(change={}){
  const queries=[],routes=[],logs=[],redisCommands=[];
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
      if(sql.includes('FROM phone_cloud_device_locks'))rows=change.pgLocks||[];
      return{rows};
    }
  }
  const session='11111111-1111-4111-8111-111111111111';
  let getCount=0;
  class RedisSocket extends EventEmitter{
    setTimeout(){} end(){}
    write(payload){
      const values=payload.split('\r\n').filter((x,i)=>i>0&&i%2===0&&x!=='');
      redisCommands.push(values);
      let value;
      if(values[0]==='GET'){getCount++;value=change.swapped&&getCount===2?'changed':change.runtimeLock===undefined?null:JSON.stringify(change.runtimeLock);}
      else if(values[0]==='PTTL')value=Object.hasOwn(change,'ttl')?change.ttl:change.runtimeLock?3600000:-2;
      else throw Error('test observed forbidden Redis command');
      const reply=value===null?'$-1\r\n':typeof value==='number'?':'+value+'\r\n':'$'+Buffer.byteLength(value)+'\r\n'+value+'\r\n';
      queueMicrotask(()=>this.emit('data',Buffer.from(reply)));
    }
  }
  const process={env:{ADMIN_API_TOKEN:'fake-local-only',DATABASE_URL:'fake',REDIS_URL:'redis://127.0.0.1'},exitCode:0,
    stdin:{async *[Symbol.asyncIterator](){yield JSON.stringify({target,...(change.session?{session}:{})});}}};
  const context={fs:{readFileSync:()=>fs.readFileSync(new URL('../../server/index.mjs',import.meta.url),'utf8')},createHash:()=>({update(){return this;},digest:()=>hash}),
    net:{createConnection(){const s=new RedisSocket();queueMicrotask(()=>s.emit('connect'));return s;}},URL,
    pg:{Client},process,Date,Buffer,AbortSignal,console:{log:x=>logs.push(JSON.parse(x))},
    fetch:async url=>{routes.push(url);return{status:200,json:async()=>url.includes('/screen-sessions/')?{session:{sessionId:session,deviceId:target.deviceId,userId:'operator',agentId:'agent',adbSerial:target.serial,status:'ready',expiresAt:new Date(Date.now()+3600000).toISOString()}}:{devices:[{deviceNumber:'59',online:true,listed:true,busy:false}]}};}};
  await vm.runInNewContext('(async()=>{'+source+'})()',context);
  return{result:logs.at(-1),exitCode:process.exitCode,queries,routes,redisCommands};
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
const ownLock=()=>({lockId:'own',lockType:'screen_control',deviceId:'adb:Fixture',appSlot:'',taskId:'11111111-1111-4111-8111-111111111111',ownerUserId:'operator',status:'active',expiresAt:new Date(Date.now()+3600000).toISOString()});
test('real Redis projection supplies own lock absent from structured PG',async()=>{
  const r=await run({runtimeLock:ownLock(),session:true});assert.equal(r.exitCode,0);
  assert.equal(r.result.pgLocks.length,0);assert.equal(r.result.locks.length,1);
  assert.equal(r.result.locks[0].owner,r.result.session.userId);
  assert.deepEqual(r.redisCommands.map(x=>x[0]),['GET','PTTL','GET']);
  assert.ok(r.redisCommands.every(x=>x[1]==='lock:device:adb:Fixture'));
});
test('physical pending remains alongside Redis own lock',async()=>{
  const r=await run({runtimeLock:ownLock(),session:true,pgLocks:[{lock_id:'physical',device_id:'adb:Fixture',status:'cleanup_pending',type:'wecom_physical_cleanup'}]});
  assert.equal(r.result.locks.length,2);assert.equal(r.result.pgLocks.length,1);
});
test('Redis changed value or unknown/expired TTL denies read',async()=>{
  for(const change of [{swapped:true},{ttl:-1},{ttl:0},{ttl:null}]){
    assert.equal((await run({runtimeLock:ownLock(),...change})).exitCode,1);
  }
});
