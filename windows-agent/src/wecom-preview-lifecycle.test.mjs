import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runWecomPreviewTask} from './wecom-preview-task.mjs';

const task={type:'wecom_customer_preview',taskId:'fixture',deviceId:'fixture',adbSerial:'fixture',payload:{previewOnly:true,phoneNumber:'13900000000',deviceNumber:'25',androidUser:0}};
const config={pythonCommand:'fixture-python',agentId:'fixture',serverBaseUrl:'http://127.0.0.1:1',agentToken:'fixture-only'};
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
function fixture(pid=123){const c=new EventEmitter();c.pid=pid;for(const key of ['stdin','stdout','stderr'])c[key]=new PassThrough();return c;}
function observe(child){let settled=null;const pending=runWecomPreviewTask(task,{config,agentDir:'/fixture',spawnChild:()=>child}).then(v=>{settled='resolved';return v;},e=>{settled=e.message;return e;});return{pending,settled:()=>settled};}

for(const mode of ['false','throw','error'])test(`hard kill ${mode} cannot release a started child before close`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const child=fixture();let attempts=0,cancels=0;
  child.stdin.on('data',b=>{if(String(b)==='cancel\n')cancels++;});
  child.kill=()=>{attempts++;if(mode==='throw')throw Error('private');if(mode==='error')child.emit('error',Error('private'));return false;};
  const run=observe(child);
  try{
    t.mock.timers.tick(230000);await flush();assert.equal(cancels,1);assert.equal(run.settled(),null);
    assert.doesNotThrow(()=>t.mock.timers.tick(15000));await flush();assert.equal(attempts,1);assert.equal(run.settled(),null);
    child.emit('exit',1);await flush();assert.equal(run.settled(),null);
    t.mock.timers.tick(60000);await flush();assert.equal(attempts,1);assert.equal(run.settled(),null);
  }finally{child.emit('close',1);await run.pending;}
  assert.equal(run.settled(),'wecom_preview_worker_timeout_no_replay');
});

test('error after spawn waits for close and preserves unknown outcome',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const child=fixture(null);child.kill=()=>false;const run=observe(child);
  child.emit('spawn');child.emit('error',Error('private failure'));await flush();
  try{assert.equal(run.settled(),null);t.mock.timers.tick(15000);await flush();assert.equal(run.settled(),null);}
  finally{child.emit('close',1);await run.pending;}
  assert.equal(run.settled(),'wecom_preview_worker_outcome_unknown');
});

test('true spawn failure without OS child ends with fixed start error',async()=>{
  const child=fixture(null);const run=observe(child);child.emit('error',Error('private failure'));
  await run.pending;assert.equal(run.settled(),'wecom_preview_worker_start_failed');
});

test('synchronous spawn failure has the same fixed start error',async()=>{
  await assert.rejects(runWecomPreviewTask(task,{config,agentDir:'/fixture',spawnChild:()=>{throw Error('private failure');}}),/^Error: wecom_preview_worker_start_failed$/);
});

test('final JSON and exit still wait for close',async()=>{
  const child=fixture();child.kill=()=>assert.fail('no kill');const run=observe(child);
  child.stdout.write(JSON.stringify({previewStatus:'ready_before_send',previewCode:'stopped_before_send',invitationSent:false}));
  child.emit('exit',0);await flush();assert.equal(run.settled(),null);
  child.emit('close',0);assert.equal((await run.pending).previewStatus,'ready_before_send');
});
