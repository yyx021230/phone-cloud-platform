import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {recoveryFixture} from '../../server/wecom-preinput-recovery-fixture.mjs';
import {runWecomPreinputRecovery,recoveryConfig,recoveryProof} from './wecom-preinput-recovery.mjs';
const config={agentId:'fixture-agent',serverBaseUrl:'http://127.0.0.1:10000',agentToken:'synthetic',pythonCommand:'synthetic-python'};
async function setup(){const f=recoveryFixture();await f.start();const task=f.pick();return {f,task};}
function childFixture(f,{closeDelay=0}={}){
 const child=new EventEmitter();child.pid=300;child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>assert.fail('unexpected kill');
 let closed=false;
 child.stdin.once('data',raw=>{const input=JSON.parse(raw);assert.equal(input.serial,f.binding.serial);const p=f.proof();child.stdout.write(JSON.stringify({ok:true,proof:p}));setTimeout(()=>{closed=true;child.emit('close',0);},closeDelay);});
 return {child,closed:()=>closed};
}
test('real private child close precedes durable proof; lost ACK replays identical bytes only',async()=>{
 const {f,task}=await setup(),wire=childFixture(f),proofs=[];
 const request=async(route,options={})=>{
  if(route.includes('recovery-lease?'))return f.service.recoveryLease(config.agentId,f.lock.lockId,f.fields());
  if(route.endsWith('recovery-challenge'))return f.call('recovery-challenge',options.body);
  assert.ok(route.endsWith('recovery-proof'));assert.equal(wire.closed(),true);proofs.push(JSON.stringify(options.body));
  const response=await f.call('recovery-proof',options.body);if(proofs.length===1)throw Object.assign(Error('lost ACK'),{deliveryUnknown:true});return response;
 };
 const result=await runWecomPreinputRecovery(task,{config,agentDir:'/synthetic',spawnChild:(cmd,args)=>{assert.ok(args[0].endsWith('/wecom_preinput_recovery.py'));return wire.child;},cleanupRequest:request});
 assert.equal(result.verified,true);assert.equal(proofs.length,2);assert.equal(proofs[0],proofs[1]);assert.equal(f.lock.status,'released');
});
test('missing child close cannot submit proof; real late close exceeds original challenge', {timeout:7000},async()=>{
 const {f,task}=await setup(),wire=childFixture(f,{closeDelay:3100});let submitted=false;
 const request=async(route,options={})=>{
  if(route.includes('recovery-lease?'))return f.service.recoveryLease(config.agentId,f.lock.lockId,f.fields());
  if(route.endsWith('recovery-challenge'))return f.call('recovery-challenge',options.body);
  submitted=true;return {};
 };
 await assert.rejects(runWecomPreinputRecovery(task,{config,agentDir:'/synthetic',spawnChild:()=>wire.child,cleanupRequest:request}),/recovery_invalid/);
 assert.equal(submitted,false);assert.equal(f.lock.status,'cleanup_pending');
});
test('invalid input and proof cannot spawn or upload',async()=>{
 const {f,task}=await setup();for(const change of [t=>t.payload.preinputRecovery='old',t=>t.payload.retiredProducer.pid=0,t=>t.payload.physicalCleanup.serial='other',t=>t.payload.cleanupConfirmed=true]){
  const bad=structuredClone(task);change(bad);assert.throws(()=>recoveryConfig(bad,config),/wecom_cleanup/);
 }
 await f.challenge();const input={...recoveryConfig(task,config),challenge:f.lock.physicalCleanup.recovery.challenge};
 for(const change of [p=>p.observer={...p.retiredProducer},p=>p.snapshots[0].wecomWorkersAbsent=false,p=>p.snapshots[0].serialForwardCount=1]){const p=f.proof();change(p);assert.throws(()=>recoveryProof(p,input),/invalid/);}
});
