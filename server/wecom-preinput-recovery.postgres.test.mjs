// Opt-in real local PG transaction. No production/default DATABASE_URL fallback.
import {persistWecomRecovery} from './wecom-recovery-postgres.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
import {recoveryFixture} from './wecom-preinput-recovery-fixture.mjs';import {createPostgresRepositories} from './postgres-repositories.mjs';import {createWecomCleanupService} from './wecom-cleanup-service.mjs';import {createWecomCausalClock} from './wecom-causal-clock.mjs';
const url=process.env.WECOM_RECOVERY_TEST_DATABASE_URL;
test('real PG rollback, original history, other-phone sentinel, lost commit reply and restart proof ACK',{skip:!url,timeout:15000},async t=>{
 const parsed=new URL(url);assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname));assert.match(parsed.pathname,/\/pc_wecom_recovery_test$/);
 const schema='wecom_recovery_'+randomUUID().replaceAll('-',''),control=new pg.Client({connectionString:url});await control.connect();await control.query('CREATE SCHEMA '+schema);
 const pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema,max:2});
 t.after(async()=>{await pool.end();await control.query('DROP SCHEMA '+schema+' CASCADE');await control.end();});
 await pool.query(`CREATE TABLE phone_cloud_device_locks(lock_id text PRIMARY KEY,device_id text,status text,expires_at timestamptz,data jsonb);
 CREATE TABLE phone_cloud_windows_tasks(task_id text PRIMARY KEY,agent_id text,adb_serial text,status text,created_at timestamptz,updated_at timestamptz,data jsonb);
 CREATE TABLE phone_cloud_automation_jobs(job_id text PRIMARY KEY,device_id text,user_id text,kind text,status text,created_at timestamptz,updated_at timestamptz,data jsonb);`);
 const repos=createPostgresRepositories({getPool:async()=>pool});let failBefore=false,loseAfter=false;
 const f=recoveryFixture({persist:async bundle=>{
  if(failBefore){const client=await pool.connect();try{await client.query('BEGIN');await repos.persistTaskMutation({...bundle,transactionClient:client});await client.query('ROLLBACK');}finally{client.release();}throw Error('synthetic rolled back transaction');}
  await persistWecomRecovery({bundle,repos,getPool:async()=>pool});if(loseAfter){loseAfter=false;throw Error('synthetic COMMIT reply lost');}
 }});
 const original=structuredClone([f.task,f.job]);await repos.persistTaskMutation({windowsTask:f.task,automationJob:f.job,deviceLock:f.lock,deviceLocks:[f.original,{lockId:'other-phone',deviceId:'adb:other',status:'active',data:'untouched'}]});
 const sentinel=(await pool.query("SELECT data FROM phone_cloud_device_locks WHERE lock_id='other-phone'")).rows[0].data;
 await f.start();f.pick();await f.challenge();const proof=f.proof();failBefore=true;
 await assert.rejects(f.call('recovery-proof',proof),/storage_unavailable/);
 assert.equal((await pool.query("SELECT status FROM phone_cloud_device_locks WHERE lock_id='obligation'")).rows[0].status,'cleanup_pending');assert.equal(f.lock.status,'cleanup_pending');
 failBefore=false;
 // A future stored revision makes the legacy upsert return zero rows. The new
 // recovery-only readback must abort, preserving BOTH task and fence.
 await pool.query("UPDATE phone_cloud_device_locks SET data=jsonb_set(data,'{updatedAt}',to_jsonb('2099-01-01T00:00:00.000Z'::text)) WHERE lock_id='obligation'");
 await assert.rejects(f.call('recovery-proof',proof),/storage_unavailable/);assert.equal(f.lock.status,'cleanup_pending');
 assert.equal((await pool.query('SELECT status FROM phone_cloud_windows_tasks WHERE task_id=$1',[f.getTask().taskId])).rows[0].status,'queued');
 await pool.query("UPDATE phone_cloud_device_locks SET data=jsonb_set(data,'{updatedAt}',to_jsonb('2026-11-03T09:00:00.000Z'::text)) WHERE lock_id='obligation'");
 loseAfter=true;await assert.rejects(f.call('recovery-proof',proof),/storage_unavailable/);assert.equal(f.lock.status,'cleanup_pending');
 const saved=(await pool.query("SELECT data FROM phone_cloud_device_locks WHERE lock_id='obligation'")).rows[0].data;assert.equal(saved.status,'released');assert.equal(saved.physicalCleanup.hosts,null);assert.equal(saved.physicalCleanup.hostClosedAt,'');
 const savedVerify=(await pool.query('SELECT data FROM phone_cloud_windows_tasks WHERE task_id=$1',[f.getTask().taskId])).rows[0].data;
 const state=structuredClone(f.state);state.deviceLocks=state.deviceLocks.map(l=>l.lockId===saved.lockId?saved:l);state.windowsTasks=state.windowsTasks.map(x=>x.taskId===savedVerify.taskId?savedVerify:x);
 const restarted=createWecomCleanupService({...f.options,state,clock:createWecomCausalClock()});assert.equal((await restarted.recoveryHandle(f.binding.agentId,f.lock.lockId,'recovery-proof',proof)).reused,true);
 assert.deepEqual((await pool.query("SELECT data FROM phone_cloud_windows_tasks WHERE task_id='original-task'")).rows[0].data,original[0]);
 assert.deepEqual((await pool.query("SELECT data FROM phone_cloud_automation_jobs WHERE job_id='job'")).rows[0].data,original[1]);
 assert.deepEqual((await pool.query("SELECT data FROM phone_cloud_device_locks WHERE lock_id='other-phone'")).rows[0].data,sentinel);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM phone_cloud_device_locks')).rows[0].n,3);
});
