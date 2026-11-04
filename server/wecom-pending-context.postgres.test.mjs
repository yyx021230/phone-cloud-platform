import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createPostgresRepositories} from './postgres-repositories.mjs';
import {recoveryProposal} from './wecom-preinput-recovery.mjs';
import {recoveryFixture} from './wecom-preinput-recovery-fixture.mjs';

const url=process.env.WECOM_RECOVERY_TEST_DATABASE_URL;
test('real PG cold-load retains 155-like original context behind 5005 newer rows without changing any record', {skip:!url,timeout:15000},async t=>{
  const parsed=new URL(url);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname));assert.equal(parsed.pathname,'/pc_wecom_recovery_test');
  const schema='pending_context_'+randomUUID().replaceAll('-',''),control=new pg.Client({connectionString:url});
  await control.connect();await control.query('CREATE SCHEMA '+schema);
  const pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema,max:2});
  t.after(async()=>{await pool.end();await control.query('DROP SCHEMA '+schema+' CASCADE');await control.end();});
  // Real indexed queries over a private fixture schema; never an application DB.
  for(const [table,key]of [['users','user_id'],['sessions','session_id'],['devices','device_id'],['sms_messages','message_id'],['windows_tasks','task_id'],['xhs_tasks','task_id'],['automation_jobs','job_id'],['automation_sessions','session_id'],['device_locks','lock_id'],['audit_events','audit_id']]){
    await pool.query(`CREATE TABLE phone_cloud_${table}(${key} text PRIMARY KEY,status text,updated_at timestamptz,expires_at timestamptz,message_at timestamptz,created_at timestamptz,data jsonb)`);
  }
  const f=recoveryFixture(),expected=recoveryProposal(f.state,f.lock),old='2001-01-01T00:00:00Z';
  const originalRows=[['windows_tasks','task_id',f.task.taskId,f.task],['automation_jobs','job_id',f.job.jobId,f.job],['device_locks','lock_id',f.lock.lockId,f.lock],['device_locks','lock_id',f.original.lockId,f.original]];
  for(const [table,key,id,value]of originalRows)await pool.query(`INSERT INTO phone_cloud_${table}(${key},status,updated_at,expires_at,data)VALUES($1,$2,$3,$3,$4::jsonb)`,[id,value.status,old,JSON.stringify(value)]);
  for(const [table,key,jsonKey]of [['windows_tasks','task_id','taskId'],['automation_jobs','job_id','jobId'],['device_locks','lock_id','lockId']]){
    await pool.query(`INSERT INTO phone_cloud_${table}(${key},status,updated_at,expires_at,data)SELECT 'new-'||i,'released',now(),now(),jsonb_build_object($1::text,'new-'||i,'status','released')FROM generate_series(1,5005)i`,[jsonKey]);
  }
  const before=await pool.query("SELECT data FROM phone_cloud_device_locks WHERE lock_id=$1",[f.lock.lockId]);
  const overlay=await createPostgresRepositories({getPool:async()=>pool}).loadOverlay();
  const state={windowsTasks:overlay.windowsTasks,automationJobs:overlay.automationJobs,deviceLocks:overlay.deviceLocks};
  assert.equal(state.windowsTasks.length,5001);assert.equal(state.automationJobs.length,5001);
  const loaded=state.deviceLocks.find(l=>l.lockId===f.lock.lockId);
  assert.deepEqual(recoveryProposal(state,loaded),expected);
  assert.deepEqual((await pool.query("SELECT data FROM phone_cloud_device_locks WHERE lock_id=$1",[f.lock.lockId])).rows,before.rows);
  for(const [table,key,id,value]of originalRows)assert.deepEqual((await pool.query(`SELECT data FROM phone_cloud_${table} WHERE ${key}=$1`,[id])).rows[0].data,value);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM phone_cloud_windows_tasks')).rows[0].n,5006);
});
