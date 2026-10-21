import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire('/tmp/pc-lookup-ocr-probe-pressure-20261020/package.json');
const {Pool}=require('pg');
const pool=new Pool({host:'127.0.0.1',port:55439,database:'postgres',user:process.env.USER});
const root=new URL('../',import.meta.url);
const candidate=await fs.readFile(new URL('server/index.mjs',root),'utf8');
const baseline=await fs.readFile('/tmp/pc-lookup-offline-handoff-final-20261020/server/index.mjs','utf8');
const extract=(source,name,next)=>source.slice(source.indexOf(`async function ${name}(`),source.indexOf(`async function ${next}(`));
await pool.query('create table phone_cloud_state(state_key text primary key,data jsonb not null,updated_at timestamptz not null default now())');
// Bind the same fixed synthetic state key as production's function parameter.
// Function keeps its transaction, truncate, insert, rollback and release implementation.
const makeBound=source=>new Function('getPostgresPool','initPostgresStorage','stringifyPostgresJson','STRUCTURED_TABLE_SYNC','POSTGRES_STATE_KEY',extract(source,'savePostgresSnapshot','getPostgresPool')+';return savePostgresSnapshot')(()=>pool,async()=>{},JSON.stringify,false,'synthetic');
const old=makeBound(baseline),updated=makeBound(candidate);
const seed={unicode:'合成验证',nested:[null,true,17,{label:'保留'}]};
await old(seed);
const large={a:'a'.repeat(135*1024*1024),b:'b'.repeat(135*1024*1024),...seed};
let beforeCode;try{await old(large);throw new Error('expected_baseline_failure');}catch(e){assert.equal(e.code,'54000');beforeCode=e.code;}
assert.deepEqual((await pool.query('select data from phone_cloud_state')).rows[0].data,seed);
await pool.query(await fs.readFile(new URL('migrate.sql',root),'utf8'));
assert.deepEqual((await pool.query('select data from phone_cloud_state')).rows[0].data,seed);
const type=(await pool.query("select data_type from information_schema.columns where table_name='phone_cloud_state' and column_name='data'")).rows[0].data_type;assert.equal(type,'json');
const bytes=await updated(large);
const recovered=(await pool.query('select data from phone_cloud_state')).rows[0].data;
assert.deepEqual(recovered,large);
// An explicit failed transaction must retain the full newly written state.
const client=await pool.connect();await client.query('begin');await client.query('truncate phone_cloud_state');await client.query('rollback');client.release();
const counts=(await pool.query("select length(data->>'a') a, length(data->>'b') b, data->>'unicode' label from phone_cloud_state")).rows[0];assert.equal(counts.a,135*1024*1024);assert.equal(counts.b,counts.a);assert.equal(counts.label,seed.unicode);
const results={atUtc:new Date().toISOString(),database:'isolated local PostgreSQL16',baselineError:beforeCode,failedWriteRetainsPrevious:true,migrationPreservesValues:true,columnType:type,snapshotBytes:bytes,fullLargeRoundtrip:true,rollbackTransactionRetainsFullSnapshot:true,productionChanges:false};
await fs.writeFile(new URL('verification/RESULTS.json',root),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));await pool.end();
