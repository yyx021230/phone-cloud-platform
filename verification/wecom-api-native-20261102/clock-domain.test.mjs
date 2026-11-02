// Regression evidence against the UNCHANGED production v1 contract.
// Passing means the failure is reproduced, never that a fix or native test passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createWecomCleanupObligation, recordWecomHosts, recordWecomHostClosed, validateWecomProof, WECOM_PACKAGES} from '../../server/wecom-physical-cleanup.mjs';
import {syntheticHostTime} from '../../server/wecom-cleanup-fixture.mjs';
import {runWecomPreviewTask} from '../../windows-agent/src/wecom-preview-task.mjs';

const origin = Date.parse('2026-11-02T05:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
function fixture() {
  let sequence = 0;
  const device = {deviceId:'adb:fixture',adb:{serial:'fixture',agentId:'fixture-agent'}};
  const job = {jobId:'fixture-job',deviceId:device.deviceId,wecomAppSlot:'main',wecomAndroidUser:0};
  const task = {taskId:'fixture-task',type:'wecom_customer_preview',status:'running',agentId:'fixture-agent',
    deviceId:device.deviceId,adbSerial:'fixture',payload:{automationJobId:job.jobId,mode:'preview',previewOnly:true,appSlot:'main',androidUser:0}};
  const lock = createWecomCleanupObligation(task,job,device,{now:origin,id:()=>`fixture-${++sequence}`});
  task.payload.physicalCleanup = structuredClone(lock.physicalCleanup.binding);
  const hosts = [{role:'reader',pid:123,...syntheticHostTime(origin+50),machineId:'a'.repeat(64)}];
  return {task,lock,hosts,binding:task.payload.physicalCleanup};
}

test('v1 accepts aligned creation, rejects a newly spawned child on a 300ms slow clock', () => {
  const f = fixture();
  recordWecomHosts(f.lock,{binding:f.binding,hosts:f.hosts},f.task,origin+100);
  const slow = fixture();
  slow.hosts[0] = {...slow.hosts[0],...syntheticHostTime(origin+50-300)};
  assert.throws(()=>recordWecomHosts(slow.lock,{binding:slow.binding,hosts:slow.hosts},slow.task,origin+100),{message:'wecom_cleanup_host_unconfirmed',statusCode:409});
  assert.equal(slow.task.status,'running');
  assert.equal(slow.lock.physicalCleanup.originalTerminalAt,'');
  assert.equal(slow.lock.physicalCleanup.hosts,null);
});

test('v1 also rejects a fresh child on a 300ms fast clock', () => {
  const f = fixture(); f.hosts[0] = {...f.hosts[0],...syntheticHostTime(origin+350)};
  assert.throws(()=>recordWecomHosts(f.lock,{binding:f.binding,hosts:f.hosts},f.task,origin+100),{message:'wecom_cleanup_host_invalid',statusCode:400});
});

test('bypassing only registration would still reject future host-close wall time', () => {
  const f = fixture(); recordWecomHosts(f.lock,{binding:f.binding,hosts:f.hosts},f.task,origin+100);
  assert.throws(()=>recordWecomHostClosed(f.lock,{binding:f.binding,hosts:f.hosts,observedAt:iso(origin+500),exited:true,observerMachineId:f.hosts[0].machineId},origin+200),/host_unconfirmed/);
  assert.equal(f.lock.physicalCleanup.hostClosedAt,'');
});

for (const [label,offset] of [['slow',-300],['fast',300]]) {
  test(`v1 ${label} first-fact frames cannot be repaired by changing only registration`, () => {
    const f = fixture();
    f.lock.physicalCleanup.hosts = f.hosts;
    f.lock.physicalCleanup.hostClosedAt = iso(origin+100);
    f.lock.physicalCleanup.originalTerminalAt = iso(origin+110);
    const v = {verificationId:'fixture-v',verificationNonce:'fixture-nonce',verificationTaskId:'fixture-verify',
      issuedAt:iso(origin+120),pickedAt:iso(origin+200),expiresAt:iso(origin+120120)};
    f.lock.physicalCleanup.verification = v;
    const task = {taskId:v.verificationTaskId,type:'wecom_cleanup_verify',status:'running',agentId:f.task.agentId,
      deviceId:f.task.deviceId,adbSerial:f.task.adbSerial,pickedAt:v.pickedAt,payload:{physicalCleanup:f.binding,...v}};
    const body = {binding:f.binding,verificationId:v.verificationId,verificationNonce:v.verificationNonce,verificationTaskId:v.verificationTaskId,
      snapshots:[250,260].map(delta=>({observedAt:iso(origin+delta+offset),packagesAbsent:true,packageNames:[...WECOM_PACKAGES],serialForwardCount:0}))};
    assert.throws(()=>validateWecomProof(f.lock,task,body,f.task.agentId,origin+280),/proof_invalid/);
    assert.equal(f.lock.status,'cleanup_pending');
  });
}

test('actual local child + HTTP409 exits with no config release; hold remains (not SYSTEM/phone)',{timeout:7000},async t => {
  const f = fixture(),dir = await fs.mkdtemp(path.join(os.tmpdir(),'wecom-skew-counterexample-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'scripts'));
  const marker = path.join(dir,'config-released');
  await fs.writeFile(path.join(dir,'scripts/wecom_platform_preview.py'),`import os,sys,json,datetime,psutil\nfrom pathlib import Path\nc=psutil.Process(os.getpid()).create_time()\nh={'role':'reader','pid':os.getpid(),'createdAt':datetime.datetime.fromtimestamp(c,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),'creationToken':c.hex(),'machineId':'a'*64}\nprint('WECOM_PHYSICAL_READY '+json.dumps({'version':1,'hosts':[h]}),file=sys.stderr,flush=True)\nline=sys.stdin.readline()\nif line: Path(${JSON.stringify(marker)}).write_text('fixture config only')\n`);
  const receipts = []; let actualClosed = false,child;
  const server = createServer(async(req,res)=>{
    const body = JSON.parse(await Array.fromAsync(req).then(parts=>Buffer.concat(parts).toString()));
    let status=200,code='';
    try {
      if (req.url.endsWith('/host')) {
        assert.equal(body.hosts[0].pid,child.pid);
        // Pure server-wall fixture: OS identity stays exact. Child is freshly
        // spawned, while server's lock time is 250ms ahead of its birth wall time.
        const born=Date.parse(body.hosts[0].createdAt);
        f.lock.createdAt=iso(born+250);
        recordWecomHosts(f.lock,body,f.task,born+500);
      } else if (req.url.endsWith('/host-closed')) {
        assert.equal(actualClosed,true);
        recordWecomHostClosed(f.lock,body,Date.now()+500);
      } else throw Error('unexpected_fixture_route');
    } catch(error) { status=error.statusCode||500;code=error.message; }
    receipts.push({action:req.url.split('/').at(-1),status,code});
    res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(status===200?{ok:true}:{error:code}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const config = {agentId:f.task.agentId,pythonCommand:process.env.WECOM_TEST_PYTHON||'python3',
    serverBaseUrl:`http://127.0.0.1:${server.address().port}`,agentToken:'fixture-only-token'};
  await assert.rejects(runWecomPreviewTask(f.task,{config,agentDir:dir,signal:t.signal,
    spawnChild:(...args)=>{child=spawn(...args);child.once('close',()=>{actualClosed=true;});return child;}}),/wecom_cleanup_host_unconfirmed/);
  assert.deepEqual(receipts.map(r=>[r.action,r.status]),[['host',409],['host-closed',409]]);
  assert.equal(actualClosed,true);
  assert.equal(await fs.stat(marker).then(()=>true,()=>false),false);
  assert.equal(f.lock.status,'cleanup_pending');assert.equal(f.lock.physicalCleanup.hosts,null);
});
