import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {EventEmitter} from 'node:events';
import {createStore} from './cps-wecom/store.mjs';

async function directory(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cps-journal-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('journal has one coordinator, durably serializes revisions and refuses an obsolete schema',async t=>{
  const dir=await directory(t),file=path.join(dir,'journal.json'),s=await createStore({file});
  try{
    await assert.rejects(createStore({file}),/lock_unavailable/);
    await Promise.all(Array.from({length:12},()=>s.transact(v=>{v.executionMode='preview';})));assert.equal(s.snapshot().revision,12);
    const before=s.snapshot();await assert.rejects(s.transact(v=>{v.recipients.push({key:'invalid'});}),/schema_invalid/);assert.deepEqual(s.snapshot(),before);assert.equal(s.fenced(),false);
  }finally{await s.close();}
  const next=await createStore({file});assert.equal(next.snapshot().revision,12);await next.close();
  await fs.writeFile(file,JSON.stringify({version:1,revision:0,leads:[],nonces:[]}));await assert.rejects(createStore({file}),/start_failed/);
  await assert.rejects(fs.stat(file+'.owner'),{code:'ENOENT'});
});

test('a stale owner file is never stolen and a failed commit fences all later mutations',async t=>{
  const dir=await directory(t),file=path.join(dir,'journal.json');await fs.writeFile(file+'.owner','{"pid":999999999}');
  await assert.rejects(createStore({file}),/lock_unavailable/);assert.equal(await fs.readFile(file+'.owner','utf8'),'{"pid":999999999}');await fs.unlink(file+'.owner');
  const s=await createStore({file});try{
    await fs.mkdir(file+'.tmp');await assert.rejects(s.transact(v=>{v.executionMode='preview';}),/commit_unknown/);assert.equal(s.fenced(),true);await assert.rejects(s.transact(()=>{}),/fenced/);assert.equal(s.snapshot().revision,0);
  }finally{await s.close();}
});

test('Postgres lost acknowledgement, revision conflict and owner disconnect fence execution',async()=>{
  for(const scenario of ['lost_ack','revision_conflict','disconnect']){
    const owner=new EventEmitter();owner.release=()=>{};let state={version:2,revision:0,executionMode:null,leads:[],nonces:[],recipients:[],limits:[]};
    owner.query=async(sql,args)=>{
      if(sql.includes('pg_try_advisory_lock'))return{rows:[{locked:true}]};
      if(sql.startsWith('select data'))return{rows:[{data:structuredClone(state)}]};
      if(sql.startsWith('update')){if(scenario==='revision_conflict')return{rowCount:0};state=JSON.parse(args[2]);throw Error('lost_ack');}
      return{rows:[],rowCount:1};
    };
    const s=await createStore({getPool:async()=>({connect:async()=>owner})});
    try{
      if(scenario==='disconnect')owner.emit('error',Error('disconnected'));
      await assert.rejects(s.transact(v=>{v.executionMode='preview';}));assert.equal(s.fenced(),true);await assert.rejects(s.transact(()=>{}),/fenced/);
      if(scenario==='lost_ack')assert.equal(state.executionMode,'preview');
    }finally{await s.close();}
  }
});

const databaseUrl=process.env.CPS_WECOM_TEST_DATABASE_URL;
test('isolated real Postgres SQL, advisory owner, CAS conflict and restart persistence',{skip:!databaseUrl},async()=>{
  const u=new URL(databaseUrl);assert.ok(['127.0.0.1','localhost'].includes(u.hostname)&&u.pathname==='/cps_wecom_fixture','dedicated local fixture required');
  const pool=new pg.Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:2000,statement_timeout:5000});
  try{
    await pool.query(await fs.readFile(new URL('../deploy/sql/cps-wecom.sql',import.meta.url),'utf8'));
    const key='fixture_'+process.pid;const s=await createStore({getPool:async()=>pool,key});
    try{
      await assert.rejects(createStore({getPool:async()=>pool,key}),/start_failed/);
      await s.transact(v=>{v.executionMode='preview';});assert.equal(s.snapshot().revision,1);
    }finally{await s.close();}
    const next=await createStore({getPool:async()=>pool,key});
    try{
      assert.equal(next.snapshot().executionMode,'preview');
      await pool.query("update phone_cloud_cps_wecom set data=jsonb_set(data,'{revision}','99') where state_key=$1",[key]);
      await assert.rejects(next.transact(()=>{}),/commit_unknown/);assert.equal(next.fenced(),true);
    }finally{await next.close();}
  }finally{await pool.end();}
});
