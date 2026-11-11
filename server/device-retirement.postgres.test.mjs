import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';
import {createPostgresRepositories,applyStructuredOverlay}from './postgres-repositories.mjs';
const url=process.env.DEVICE_RETIREMENT_TEST_DATABASE_URL;
test('real PostgreSQL retirement rejects delayed stale upsert and survives older snapshot load',{skip:!url},async()=>{
 const u=new URL(url);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.pathname,'/device_retirement_fixture');
 const pool=new pg.Pool({connectionString:url,max:3,statement_timeout:5000});let owner;
 try{
  await pool.query('CREATE TABLE phone_cloud_devices(device_id text primary key,data jsonb not null,updated_at timestamptz default now())');
  const repos=createPostgresRepositories({getPool:async()=>pool});
  await repos.persistDeviceBatch({devices:[{deviceId:'adb:old',deviceName:'18'},{deviceId:'adb:new',deviceName:'18',model:'new-hardware'},{deviceId:'unrelated',deviceName:'19'}]});
  owner=await pool.connect();await owner.query('BEGIN');
  await owner.query("UPDATE phone_cloud_devices SET data=data||$1::jsonb WHERE device_id='adb:old'",[JSON.stringify({inventoryRetiredAt:'2026-11-11T08:00:00.000Z',replacementDeviceId:'adb:new'})]);
  const delayed=repos.persistDeviceMutation({device:{deviceId:'adb:old',deviceName:'stale-adb-report'}});
  let blocked=false;
  for(let i=0;i<40;i++){const r=await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='transactionid'");if(r.rows[0].n){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}
  assert.equal(blocked,true,'stale writer really waited for retirement transaction');
  const cutoff=Date.now()+10;
  const before=await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND pid<>pg_backend_pid() AND xact_start<=to_timestamp($1/1000.0)",[cutoff]);assert.ok(before.rows[0].n>=1);
  await owner.query('COMMIT');await delayed;
  const drained=await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND pid<>pg_backend_pid() AND xact_start<=to_timestamp($1/1000.0)",[cutoff]);assert.equal(drained.rows[0].n,0,'checked-out idle lease is not an unfinished transaction');assert.notEqual(pool.idleCount,pool.totalCount);
  owner.release();owner=null;
  await repos.persistDeviceMutation({device:{deviceId:'unrelated',deviceName:'updated-normally'}});
  const rows=(await pool.query('SELECT data FROM phone_cloud_devices ORDER BY device_id')).rows.map(r=>r.data);
  const retired=rows.find(r=>r.deviceId==='adb:old');assert.ok(retired.inventoryRetiredAt);assert.equal(retired.deviceName,'18');
  const snapshot={devices:[{deviceId:'adb:old',deviceName:'older-snapshot'}, {deviceId:'unrelated'}],automationJobs:[{jobId:'history',deviceId:'adb:old'}]};
  applyStructuredOverlay(snapshot,{devices:rows});assert.equal(snapshot.devices.some(d=>d.deviceId==='adb:old'),false);assert.equal(snapshot.devices.find(d=>d.deviceId==='unrelated').deviceName,'updated-normally');assert.equal(snapshot.automationJobs[0].deviceId,'adb:old');
 }finally{await owner?.query('ROLLBACK');owner?.release();await pool.end();}
});
