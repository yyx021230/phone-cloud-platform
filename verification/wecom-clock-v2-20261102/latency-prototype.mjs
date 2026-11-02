// OFFLINE contract experiment, deliberately incompatible with production APIs.
// Actual OS child/private pipe/HTTP timing; all Android facts are synthetic.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {physicalHosts} from '../../windows-agent/src/wecom-cleanup-protocol.mjs';

const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const fail = code => { throw Error(code); };
export async function offlineExperiment({wallOffsetMs=0,readDelayMs=5,closeDelayMs=0,challengeResponseDelayMs=0,
  fault='',restartBeforeProof=false}={}) {
  for (const value of [wallOffsetMs,readDelayMs,closeDelayMs,challengeResponseDelayMs]) {
    if (!Number.isFinite(value) || Math.abs(value)>600000) fail('fixture_options_invalid');
  }
  const epoch='fixture-'+randomUUID(),executionNonce='fixture-'+randomUUID(),pipeNonce='fixture-'+randomUUID();
  let challenge=null,challengeSent=false,closed=false,child,proofSent=false,serverAgeMs=null,outcome,timer;
  const receipt={fixtureOnly:true,androidFacts:'synthetic',nativeSystemProof:false,events:[],operations:0};
  const server=createServer(async(req,res)=>{
    try {
      const body=JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
      if (req.method!=='POST' || body.fixtureOnly!==true) fail('fixture_route_invalid');
      let reply;
      if (req.url==='/fixture/challenge') {
        if (!challenge) challenge={nonce:'fixture-'+randomUUID(),epoch,issued:performance.now()};
        await sleep(challengeResponseDelayMs);
        reply={fixtureOnly:true,nonce:challenge.nonce,epoch:challenge.epoch};
      } else if (req.url==='/fixture/proof') {
        serverAgeMs=performance.now()-challenge.issued;
        if (!closed || body.nonce!==challenge.nonce || body.epoch!==(restartBeforeProof?'fixture-restarted':epoch)) fail('fixture_binding_or_epoch_invalid');
        if (serverAgeMs<0 || serverAgeMs>3000) fail('fixture_server_challenge_expired');
        if (body.frames?.length!==2 || body.frames.some(f=>f.synthetic!==true || f.packagesAbsent!==true || f.serialForwardCount!==0
          || !Number.isFinite(f.startedAfterChallengeMs) || f.startedAfterChallengeMs<0 || f.startedAfterChallengeMs>3000)
          || body.frames[0].startedAfterChallengeMs>=body.frames[1].startedAfterChallengeMs) fail('fixture_frames_invalid');
        reply={fixtureOnly:true,accepted:true};
      } else fail('fixture_route_invalid');
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(reply));
    } catch(error) {res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({fixtureOnly:true,error:error.message}));}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  const http=async(route,body)=>{
    if (!['/fixture/challenge','/fixture/proof'].includes(route)) fail('fixture_route_invalid');
    const r=await fetch(origin+route,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({fixtureOnly:true,...body}),signal:AbortSignal.timeout(7000)});
    const result=await r.json();if(result.fixtureOnly!==true)fail('fixture_response_invalid');
    if(!r.ok)fail(result.error);return result;
  };
  const queue=[];let waiter=null;
  const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>{waiter=resolve;});
  try {
    child=spawn(process.env.WECOM_TEST_PYTHON||'python3',[fileURLToPath(new URL('fixture_reader.py',import.meta.url))],
      {stdio:['pipe','pipe','pipe'],env:{...process.env,WECOM_OFFLINE_CLOCK_FIXTURE:'1'}});
    const childClosed=once(child,'close');childClosed.catch(()=>{});
    child.once('error',()=>{if(waiter){waiter({eof:true});waiter=null;}});
    child.once('close',()=>{closed=true;receipt.events.push('actual_child_close');if(waiter){waiter({eof:true});waiter=null;}});
    timer=setTimeout(()=>child.kill(),8000);
    // Capture delivery order immediately, not when a buffered line is read later.
    createInterface({input:child.stdout}).on('line',line=>{
      let value;try{value=JSON.parse(line);}catch{value={kind:'fixture_invalid'};}
      const record={value,beforeChallenge:!challengeSent};
      if(waiter){const resolve=waiter;waiter=null;resolve(record);}else queue.push(record);
    });
    child.stderr.resume();
    child.stdin.write(JSON.stringify({purpose:'fixture_bootstrap',executionNonce,pipeNonce,fault})+'\n');
    const first=(await next()).value;
    if(first?.kind!=='fixture_ready' || first.pid!==child.pid || first.executionNonce!==executionNonce || first.pipeNonce!==pipeNonce) fail('fixture_ready_binding_invalid');
    // Reuse the actual product's strict token/ISO parser, but machine ID is
    // explicitly synthetic. This does not claim a native SYSTEM bootstrap.
    physicalHosts([{role:'reader',pid:first.pid,createdAt:first.createdAt,creationToken:first.creationToken,machineId:'a'.repeat(64)}]);
    receipt.events.push('actual_ready_identity_validated');
    const c=await http('/fixture/challenge',{});receipt.events.push('challenge_response_received');
    challengeSent=true;
    child.stdin.write(JSON.stringify({purpose:'fixture_challenge',nonce:c.nonce,epoch:c.epoch,readDelayMs,closeDelayMs,wallOffsetMs})+'\n');
    let result;
    while (true) {
      const message=await next();if(message.eof)fail('fixture_closed_without_result');
      if(message.value.kind==='fixture_fact') {
        if(message.beforeChallenge || message.value.beforeChallenge) fail('fixture_fact_before_challenge');
        receipt.events.push('synthetic_first_fact');
      } else if(message.value.kind==='fixture_error') fail(message.value.code);
      else if(message.value.kind==='fixture_result') {result=message.value;break;}
      else fail('fixture_message_invalid');
    }
    child.stdin.end();await childClosed;
    if(!closed)fail('fixture_close_missing');
    proofSent=true;receipt.operations=result.syntheticReadCount;
    receipt.events.push('fixture_proof_after_actual_close');
    await http('/fixture/proof',{nonce:result.nonce,epoch:result.epoch,frames:result.frames});
    outcome={accepted:true,reason:'fixture_accepted'};
  } catch(error) {
    outcome={accepted:false,reason:/^fixture_[a-z0-9_]+$/.test(error.message)?error.message:'fixture_experiment_error'};
  } finally {
    // Only this local test's own child is cleaned up; never any production PID.
    if(child && !closed) {
      const ending=once(child,'close');child.stdin.end();
      const timer=setTimeout(()=>child.kill(),1000);await ending;clearTimeout(timer);
    }
    clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
  return {...receipt,...outcome,actualChildClosed:closed,proofSent,serverAgeMs};
}
