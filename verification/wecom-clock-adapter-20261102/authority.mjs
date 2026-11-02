// Local adapter candidate only. No import or wiring from production entrypoints.
// Fixture timing qualification is NEVER a physical cleanup or native permit.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {OfflineClockModel,syntheticProfile} from '../wecom-clock-authority-20261102/model.mjs';

const childFile=fileURLToPath(new URL('./fixture-child.mjs',import.meta.url));
const fail=code=>{throw Error('clock_adapter_'+code);};
const readers=new WeakMap();
const denied=Object.freeze({fixtureOnly:true,nativeExecutionPermitted:false,physicalCleanupVerified:false});

// No public profile/sample/continuity option can convert unmeasured clocks to
// authority. Current Windows and cloud VM characterization remains missing.
export function openProductionAuthority(){fail('production_clock_unsupported');}

function child(mode,nonce=''){
  const process=spawn(globalThis.process.execPath,[childFile,mode,nonce],{
    env:{},stdio:['pipe','pipe','pipe']});
  const closed=new Promise(resolve=>process.once('close',(code,signal)=>resolve({code,signal})));
  return {process,closed};
}

export async function openFixtureReader(){
  const nonce=randomUUID(),owned=child('--reader-fixture',nonce);
  const lines=createInterface({input:owned.process.stdout});
  let didClose=false;owned.closed.then(()=>{didClose=true;});
  const ready=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('clock_adapter_reader_ready_timeout')),2000);
    lines.once('line',raw=>{
      clearTimeout(timer);
      try{const v=JSON.parse(raw);if(!v||typeof v!=='object'||Array.isArray(v)
          ||v.fixtureOnly!==true||v.event!=='ready'||v.nonce!==nonce||v.pid!==owned.process.pid
          ||typeof v.epoch!=='string')fail('reader_identity_invalid');resolve(v);}
      catch(error){reject(error);}
    });
    owned.process.once('error',error=>{clearTimeout(timer);reject(error);});
  }).catch(async error=>{owned.process.kill();await owned.closed;throw error;});
  const handle=Object.freeze({fixtureOnly:true,pid:ready.pid,
    async stop(){owned.process.stdin.end('{"op":"stop"}\n');await owned.closed;},
    async dispose(){if(!didClose){owned.process.kill();await owned.closed;}lines.close();}});
  readers.set(handle,{owned,ready,closed:()=>didClose});return handle;
}

export async function openFixtureAuthority({persist=async()=>{}}={}){
  if(typeof persist!=='function')fail('fixture_persistence_invalid');
  const owned=child('--clock-fixture');
  let pending=null,poison=null,disposed=false,childEpoch='',bytes=[],active=false,sequence=0;
  const authorityEpoch=Symbol('fixture-authority-epoch');
  const model=new OfflineClockModel(syntheticProfile('linux'));
  const hosts=new WeakMap(),frames=new WeakMap();
  function invalidate(code){
    poison=poison||(code instanceof Error?code:Error('clock_adapter_'+code));
    if(pending){clearTimeout(pending.timer);pending.reject(poison);pending=null;}
  }
  function line(raw){
    try{
      const value=JSON.parse(raw);
      if(!value||typeof value!=='object'||Array.isArray(value))fail('response_invalid');
      if(!pending)fail('response_not_current');
      const payload=pending.op==='sample'?'sample':pending.op==='advance'?'advanced':'armed';
      const keys=['pid','epoch','nonce','fixtureOnly',payload].sort().join(',');
      if(Object.keys(value).sort().join(',')!==keys)fail('response_invalid');
      if(value.nonce!==pending.nonce||value.fixtureOnly!==true)fail('response_not_current');
      if(value.pid!==owned.process.pid||typeof value.epoch!=='string'
        ||(childEpoch&&value.epoch!==childEpoch))fail('foreign_child');
      childEpoch=value.epoch;
      const item=pending;pending=null;clearTimeout(item.timer);item.resolve(value);
    }catch(error){
      invalidate(/^clock_adapter_/.test(error?.message)?error:Error('clock_adapter_response_invalid',{cause:error}));
    }
  }
  owned.process.stdout.on('data',chunk=>{
    for(const byte of chunk){
      if(poison)return;
      if(byte===10){const raw=Buffer.from(bytes).toString('utf8');bytes=[];line(raw);}
      else{bytes.push(byte);if(bytes.length>4096){invalidate('response_oversized');return;}}
    }
  });
  owned.process.on('error',()=>invalidate('child_failed'));
  owned.closed.then(()=>{if(!disposed)invalidate(bytes.length?'response_incomplete':'child_closed');});
  async function request(op,body={}){
    if(poison)throw poison;if(disposed)fail('disposed');
    if(pending){invalidate('concurrent_request');fail('concurrent_request');}
    const nonce=randomUUID();
    return new Promise((resolve,reject)=>{
      pending={op,nonce,resolve,reject,timer:setTimeout(()=>invalidate(bytes.length?'response_incomplete':'sample_timeout'),1000)};
      owned.process.stdin.write(JSON.stringify({op,nonce,...body})+'\n',error=>{if(error)invalidate('pipe_failed');});
    });
  }
  async function sample(){
    try{
      const {sample:s}=await request('sample');
      if(poison)throw poison;
      if(!s||Object.keys(s).sort().join(',')!=='bootAfterUs,bootBeforeUs,domain,sequence,wallAfterUs,wallBeforeUs,workUs')fail('sample_invalid');
      if(s.domain?.processEpoch!==childEpoch)fail('foreign_child');
      if(s.sequence!==sequence+1)fail('sample_sequence_changed');
      sequence=s.sequence;
      for(const key of ['bootBeforeUs','bootAfterUs','workUs','wallBeforeUs','wallAfterUs']){
        if(typeof s[key]!=='string'||!/^\d{1,20}$/.test(s[key]))fail('sample_invalid');s[key]=BigInt(s[key]);
      }
      return s;
    }catch(error){invalidate(error);throw poison;}
  }
  async function observe(){
    try{return model.observe(await sample());}
    catch(error){invalidate(error);throw poison;}
  }
  async function write(row){
    try{await persist(Object.freeze({...row,fixtureOnly:true}));}
    catch(error){invalidate(Error('clock_adapter_persistence_unknown',{cause:error}));throw poison;}
  }
  async function action(body){
    if(poison)throw poison;
    if(active){invalidate('concurrent_action');throw poison;}
    active=true;
    try{return await body();}catch(error){invalidate(error);throw poison;}finally{active=false;}
  }
  function host(handle){const h=hosts.get(handle);if(!h)fail('foreign_host');return h;}
  async function guardAfterPersistence(){await observe();}
  return Object.freeze({
    ...denied,
    async register(handle){return action(async()=>{
      const r=readers.get(handle);if(!r||r.closed()||hosts.has(handle)||r.claimedBy)fail('reader_not_current');
      r.claimedBy=authorityEpoch; // Never clear or reissue after unknown persistence.
      await observe();
      await write({stage:'registered',pid:r.ready.pid,epoch:r.ready.epoch});
      await guardAfterPersistence();
      if(r.closed())fail('reader_closed_during_registration');
      hosts.set(handle,{reader:r,closed:false,challenge:null});return denied;
    });},
    async close(handle){return action(async()=>{
      const h=host(handle);if(!h.reader.closed())fail('actual_child_close_missing');
      await observe();await write({stage:'closed',pid:handle.pid});await guardAfterPersistence();h.closed=true;return denied;
    });},
    async challenge(handle){return action(async()=>{
      const h=host(handle);if(!h.closed||h.challenge)fail('challenge_not_available');
      const anchor=await observe();
      const challenge={nonce:randomUUID(),anchor,used:false};h.challenge=challenge;
      await write({stage:'challenge',nonce:challenge.nonce});
      // Anchor precedes persistence. Fixture elapsed time is explicitly injected;
      // static counters do NOT measure real HTTP/fsync wall time or prove 3s.
      if(!model.proofWithinThreeSeconds(anchor,await sample())){invalidate('challenge_expired');fail('challenge_expired');}
      return Object.freeze({...denied,challengeId:challenge.nonce});
    });},
    async frame(handle){return action(async()=>{
      const h=host(handle),c=h.challenge;if(!c||c.used)fail('challenge_not_current');
      const stamp=await observe();const f=Object.freeze({...denied,id:randomUUID()});
      frames.set(f,{challenge:c,stamp});return f;
    });},
    async proof(handle,pair){return action(async()=>{
      const h=host(handle),c=h.challenge;
      if(!c||c.used||!Array.isArray(pair)||pair.length!==2||pair[0]===pair[1]
          ||pair.some(f=>frames.get(f)?.challenge!==c)
          ||frames.get(pair[0]).stamp.sequence>=frames.get(pair[1]).stamp.sequence)fail('proof_not_current');
      c.used=true; // One shot even if persistence or acknowledgement is unknown.
      if(!model.proofWithinThreeSeconds(c.anchor,await sample())){invalidate('proof_expired');fail('proof_expired');}
      await write({stage:'timing_proof',nonce:c.nonce,frameIds:pair.map(f=>f.id)});
      // A pre-journal observation cannot authorize a post-journal result.
      if(!model.proofWithinThreeSeconds(c.anchor,await sample())){invalidate('proof_expired');fail('proof_expired');}
      return Object.freeze({...denied,timingWithinThreeSeconds:true});
    });},
    async advanceFixture(bootUs,workUs=bootUs,wallShiftUs=0n){
      return request('advance',{bootUs:String(bootUs),workUs:String(workUs),wallShiftUs:String(wallShiftUs)});
    },
    async replayFixtureSample(){return request('replay-next');},
    async faultFixture(fault){return request('fault-next',{fault});},
    async dispose(){disposed=true;invalidate('disposed');owned.process.stdin.end();await owned.closed;},
  });
}
