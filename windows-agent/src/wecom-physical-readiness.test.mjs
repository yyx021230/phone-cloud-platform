import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {runWecomPreviewTask} from './wecom-preview-task.mjs';

const fixture=JSON.parse(await fs.readFile(new URL('../../verification/wecom-cleanup-v1/fixtures.json',import.meta.url),'utf8'));
const config={agentId:fixture.binding.agentId,pythonCommand:process.env.WECOM_TEST_PYTHON||'python3',serverBaseUrl:'http://127.0.0.1:1',agentToken:'fixture-only-token'};
const task={type:'wecom_customer_preview',taskId:fixture.binding.originalTaskId,agentId:config.agentId,deviceId:fixture.binding.deviceId,adbSerial:fixture.binding.serial,
  payload:{mode:'preview',previewOnly:true,phoneNumber:'13900000000',deviceNumber:'43',appSlot:'main',androidUser:0,physicalCleanup:fixture.binding,
    wecomCausalLease:{protocol:'wecom-causal-v1',epoch:'fixture-epoch',leaseId:'fixture-lease',purpose:'business'}}};
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
async function prepare(t,{wrongPid=false,wrongPipe=false,earlyExit=false,validateAgentEnvelope=false}={}){
  try{await promisify(execFile)(config.pythonCommand,['-c','import psutil'],{timeout:1000});}
  catch{throw Error('fixture_python_psutil_dependency_unavailable');}
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wecom-real-pipe-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'scripts'));
  const marker=path.join(dir,'configuration-released');
  const source=earlyExit?'import sys;sys.exit(7)\n':`import sys,os,json,time,datetime,psutil
from pathlib import Path
bootstrap=json.loads(sys.stdin.readline())
created=psutil.Process(os.getpid()).create_time()
host={'role':'reader','pid':os.getpid()+${wrongPid?1:0},'createdAt':datetime.datetime.fromtimestamp(created,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),'creationToken':created.hex(),'machineId':'a'*64}
proof=bootstrap['bootstrap']
${wrongPipe?"proof=dict(proof,pipeNonce='f'*48)":"pass"}
print('WECOM_PHYSICAL_READY '+json.dumps({'version':1,'hosts':[host],'bootstrap':proof}),file=sys.stderr,flush=True)
line=sys.stdin.readline()
if line:
 payload=json.loads(line)
 ${validateAgentEnvelope?`sys.path.insert(0,${JSON.stringify(fileURLToPath(new URL('../scripts/',import.meta.url)))})
 import wecom_platform_preview as real_host
 real_host.DEVICES={payload['deviceNumber']:{'serial':payload['serial'],'defaultAppSlot':'main','appSlots':{'main':0}}}
 real_host.physical_bootstrap_hosts=[host]
 real_host.physical_bootstrap_runtime=object()
 real_host.physical_bootstrap_causal=bootstrap['bootstrap']
 real_host.validate_config(payload)`:'pass'}
 Path(${JSON.stringify(marker)}).write_text('fixture configuration only')
 print(json.dumps({'previewStatus':'ready_before_send','previewCode':'stopped_before_send','invitationSent':False,'remarkSaveStatus':'not_needed'}),flush=True)
 time.sleep(.2)
else:
 print(json.dumps({'previewStatus':'blocked','previewCode':'fixture_no_config','invitationSent':False}),flush=True)
`;
  await fs.writeFile(path.join(dir,'scripts/wecom_platform_preview.py'),source);
  return{dir,marker};
}
function ownChild(t,child,controller,ack){
  t.after(async()=>{
    controller.abort(Error('fixture_test_cleanup'));ack?.resolve();
    if(child.exitCode===null&&child.signalCode===null){
      const closed=once(child,'close',{signal:AbortSignal.timeout(1000)});child.kill();await closed;
    }
  });
  return child;
}

test('real OS pipe keeps config behind durable host ACK and result behind actual close (fixture machine)',{timeout:5000},async t=>{
  const{dir,marker}=await prepare(t),hostSeen=defer(),ack=defer(),jsonSeen=defer(),controller=new AbortController();let child,closed=false,finished=false,args;
  const pending=runWecomPreviewTask(task,{config,agentDir:dir,signal:AbortSignal.any([controller.signal,t.signal]),spawnChild:(...input)=>{
    args=input;child=ownChild(t,spawn(...input),controller,ack);child.once('close',()=>closed=true);child.stdout.once('data',()=>jsonSeen.resolve());return child;
  },cleanupRequest:async(route,{body})=>{
    if(route.endsWith('/host')){assert.equal(body.hosts[0].pid,child.pid);hostSeen.resolve();await ack.promise;}
    else{assert.equal(closed,true);assert.equal(body.exited,true);assert.equal(body.observerMachineId,'a'.repeat(64));}
    return{ok:true};
  }}).finally(()=>finished=true);
  const early=pending.then(()=>{throw Error('fixture_child_closed_before_expected_event');});early.catch(()=>{});
  await Promise.race([hostSeen.promise,early]);assert.equal(await fs.stat(marker).then(()=>true,()=>false),false);
  assert.ok(!JSON.stringify(args).includes(config.agentToken));assert.ok(!JSON.stringify(args).includes(task.payload.phoneNumber));
  ack.resolve();await Promise.race([jsonSeen.promise,early]);assert.equal(finished,false);
  assert.equal((await pending).previewStatus,'ready_before_send');assert.equal(closed,true);
  assert.equal(await fs.readFile(marker,'utf8'),'fixture configuration only');
});

test('actual Node payload crosses the real Python causal configuration validator after host ACK',{timeout:5000},async t=>{
  const{dir,marker}=await prepare(t,{validateAgentEnvelope:true}),controller=new AbortController();
  const result=await runWecomPreviewTask(task,{config,agentDir:dir,signal:AbortSignal.any([controller.signal,t.signal]),
    spawnChild:(...args)=>ownChild(t,spawn(...args),controller),cleanupRequest:async()=>({ok:true})});
  assert.equal(result.previewStatus,'ready_before_send');
  assert.equal(await fs.readFile(marker,'utf8'),'fixture configuration only');
});

test('cancel during host ACK cannot release config after a late ACK (real pipe)',{timeout:5000},async t=>{
  const{dir,marker}=await prepare(t),hostSeen=defer(),ack=defer(),closeSeen=defer(),controller=new AbortController();
  const pending=runWecomPreviewTask(task,{config,agentDir:dir,signal:AbortSignal.any([controller.signal,t.signal]),spawnChild:(...args)=>{
    const c=ownChild(t,spawn(...args),controller,ack);c.once('close',()=>closeSeen.resolve());return c;
  },cleanupRequest:async route=>{if(route.endsWith('/host')){hostSeen.resolve();await ack.promise;}return{ok:true};}});
  const rejected=assert.rejects(pending,/fixture_cancel/);
  await Promise.race([hostSeen.promise,pending]);controller.abort(Error('fixture_cancel'));await closeSeen.promise;ack.resolve();await rejected;
  assert.equal(await fs.stat(marker).then(()=>true,()=>false),false);
});

test('mismatched ready PID stops before registration and config (real pipe)',{timeout:5000},async t=>{
  const{dir,marker}=await prepare(t,{wrongPid:true}),controller=new AbortController();let calls=0;
  await assert.rejects(runWecomPreviewTask(task,{config,agentDir:dir,signal:AbortSignal.any([controller.signal,t.signal]),spawnChild:(...args)=>ownChild(t,spawn(...args),controller),cleanupRequest:async()=>{calls++;return{ok:true};}}),/wecom_cleanup_host_invalid/);
  assert.equal(calls,0);assert.equal(await fs.stat(marker).then(()=>true,()=>false),false);
});

test('actual child with stale private pipe nonce stops before registration/config',{timeout:5000},async t=>{
  const{dir,marker}=await prepare(t,{wrongPipe:true}),controller=new AbortController();let calls=0;
  await assert.rejects(runWecomPreviewTask(task,{config,agentDir:dir,signal:AbortSignal.any([controller.signal,t.signal]),spawnChild:(...args)=>ownChild(t,spawn(...args),controller),cleanupRequest:async()=>{calls++;return{ok:true};}}),/wecom_cleanup_host_invalid/);
  assert.equal(calls,0);assert.equal(await fs.stat(marker).then(()=>true,()=>false),false);
});

test('real pipe and loopback HTTP keep config behind fsynced same-body registration ACK',{timeout:6000},async t=>{
  const{dir,marker}=await prepare(t),ack=defer(),registered=defer(),controller=new AbortController();let child,closed=false,hostCalls=0,firstBody;
  const server=http.createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.authorization,'Bearer '+config.agentToken);let raw='';for await(const b of req){raw+=b.toString();assert.ok(raw.length<=8192);}
      const body=JSON.parse(raw);
      if(req.url.endsWith('/host')){
        hostCalls++;assert.equal(body.hosts[0].pid,child.pid);
        if(!firstBody)firstBody=structuredClone(body);else assert.deepEqual(body,firstBody);
        const handle=await fs.open(path.join(dir,'host-receipt.json'),'w',0o600);
        try{await handle.writeFile(JSON.stringify(body));await handle.sync();}finally{await handle.close();}
        if(hostCalls===1){req.socket.destroy();return;} // committed receipt, lost reply
        registered.resolve();await ack.promise;
      }else{assert.ok(req.url.endsWith('/host-closed'));assert.equal(closed,true);assert.deepEqual(body.bootstrap,firstBody.bootstrap);}
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));
    }catch{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'wecom_cleanup_fixture_failure'}));}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{ack.resolve();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const local={...config,serverBaseUrl:`http://127.0.0.1:${server.address().port}`};
  const pending=runWecomPreviewTask(task,{config:local,agentDir:dir,signal:AbortSignal.any([controller.signal,t.signal]),spawnChild:(...args)=>{child=ownChild(t,spawn(...args),controller,ack);child.once('close',()=>closed=true);return child;}});
  const early=pending.then(()=>{throw Error('fixture_early_end');});early.catch(()=>{});
  await Promise.race([registered.promise,early]);assert.equal(hostCalls,2);assert.equal(await fs.stat(marker).then(()=>true,()=>false),false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'host-receipt.json'),'utf8')),firstBody);
  ack.resolve();assert.equal((await pending).previewStatus,'ready_before_send');assert.equal(closed,true);
});

test('two unknown registration ACKs never allow config, even if close is acknowledged',{timeout:5000},async t=>{
  const{dir,marker}=await prepare(t),controller=new AbortController();let hosts=0,closes=0;
  await assert.rejects(runWecomPreviewTask(task,{config,agentDir:dir,signal:AbortSignal.any([controller.signal,t.signal]),spawnChild:(...args)=>ownChild(t,spawn(...args),controller),cleanupRequest:async route=>{
    if(route.endsWith('/host')){hosts++;throw Object.assign(Error('wecom_cleanup_response_unknown'),{deliveryUnknown:true});}
    closes++;return{ok:true};
  }}),/wecom_cleanup_response_unknown/);
  assert.equal(hosts,2);assert.equal(closes,1);assert.equal(await fs.stat(marker).then(()=>true,()=>false),false);
});

test('fixture exit before ready wakes the waiter instead of hanging',{timeout:5000},async t=>{
  const{dir}=await prepare(t,{earlyExit:true}),controller=new AbortController(),hostSeen=defer();
  const pending=runWecomPreviewTask(task,{config,agentDir:dir,signal:AbortSignal.any([controller.signal,t.signal]),spawnChild:(...args)=>ownChild(t,spawn(...args),controller),cleanupRequest:async()=>{hostSeen.resolve();return{ok:true};}});
  await assert.rejects(Promise.race([hostSeen.promise,pending]),/wecom_cleanup_input_not_released/);
});
