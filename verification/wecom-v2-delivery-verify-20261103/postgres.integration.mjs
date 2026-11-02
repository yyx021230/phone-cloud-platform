// Two sequential SQL mechanism fixtures. Never app/HTTP/Agent/native execution.
import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {ownedConfiguration,verifyOwnedServer} from "./owned-pg.mjs";
import {made} from "./fixture.mjs";
import {projectionSql as p} from "../wecom-v2-projection-sql-plan-20261102/verification-queries.mjs";
import {createWecomV2ClaimPostgresRepository} from "../../server/wecom-cleanup-v2-claim-postgres.mjs";
const config=await ownedConfiguration(),db=new config.Pool(config.options);
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const evidence={kind:"delivery-SQL-only-no-route-or-EPQ",server:null,cases:[],attempts:[]};
function canonical(v){return Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;}
const hash=v=>createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
function repository(f,pool=db){return createWecomV2ClaimPostgresRepository({getPool:async()=>pool,readClaimContext:()=>f.context,readDeviceMapping:()=>({device:f.input.device,mappingRevision:1})});}
async function seed(f){
  const {task:t,job:j,businessLock:l,device:d}=f.input,b=f.context.binding;
  await db.query("INSERT INTO phone_cloud_devices VALUES($1,$2::jsonb,NULL)",[d.deviceId,JSON.stringify(d)]);
  await db.query("INSERT INTO phone_cloud_windows_tasks VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",[t.taskId,t.agentId,t.adbSerial,t.status,t.createdAt,t.updatedAt,JSON.stringify(t)]);
  await db.query("INSERT INTO phone_cloud_automation_jobs VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",[j.jobId,j.deviceId,j.userId,j.kind,j.status,j.createdAt,j.updatedAt,JSON.stringify(j)]);
  await db.query("INSERT INTO phone_cloud_device_locks VALUES($1,$2,$3,$4,$5::jsonb)",[l.lockId,l.deviceId,l.status,l.expiresAt,JSON.stringify(l)]);
  const fingerprint=createHash("sha256").update(JSON.stringify([b.deviceId,b.serial,b.agentId,d.deviceName])).digest("hex");
  await db.query("INSERT INTO phone_cloud_wecom_v2_physical_anchors(physical_key,device_id,agent_id,mapping_revision,mapping_fingerprint,mapping_state) VALUES($1,$2,$3,1,$4,'ready')",[b.serial.toLowerCase(),b.deviceId,b.agentId,fingerprint]);
}
function taskRow(r){assert.deepEqual(Object.keys(r).sort(),["task_id","agent_id","adb_serial","status","created_at","updated_at","data"].sort());return {...r,created_at:r.created_at.toISOString(),updated_at:r.updated_at.toISOString()};}
async function readTask(c,f){const r=await c.query("SELECT task_id,agent_id,adb_serial,status,created_at,updated_at,data FROM phone_cloud_windows_tasks WHERE task_id=$1",[f.context.binding.originalTaskId]);assert.equal(r.rowCount,1);return taskRow(r.rows[0]);}
async function protectedRecords(c,f){const b=f.context.binding;return {
  job:(await c.query("SELECT job_id,device_id,user_id,kind,status,created_at,updated_at,data FROM phone_cloud_automation_jobs WHERE job_id=$1",[f.context.originalJobId])).rows[0],
  locks:(await c.query("SELECT lock_id,device_id,status,expires_at,data FROM phone_cloud_device_locks WHERE lock_id=ANY($1::text[]) ORDER BY lock_id",[[b.obligationId,f.context.originalLockId]])).rows,
  ledger:(await c.query("SELECT obligation_id,server_epoch,revision,host_operation_id,close_operation_id,protocol_state,claim_data FROM phone_cloud_wecom_cleanup_v2 WHERE obligation_id=$1",[b.obligationId])).rows[0],
  anchor:(await c.query("SELECT physical_key,device_id,active_obligation_id,active_claim_operation_id,agent_id,mapping_revision,mapping_fingerprint,mapping_state FROM phone_cloud_wecom_v2_physical_anchors WHERE physical_key=$1",[b.serial.toLowerCase()])).rows[0],
  device:(await c.query("SELECT device_id,data,updated_at FROM phone_cloud_devices WHERE device_id=$1",[b.deviceId])).rows[0]};}
const stripThree=data=>{const r=structuredClone(data);for(const k of ["delivery","deliveryAttempts","updatedAt"])delete r[k];return r;};
function expectedRow(old,d){return {...old,updated_at:d.at,data:{...old.data,delivery:d.value,deliveryAttempts:d.attempt,updatedAt:d.at}};}
async function update(f,d,attempt){
  const c=await db.connect(),state={backend:c.processID,commitTag:null,released:false};let failure=null;
  try{
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");await c.query("SET LOCAL lock_timeout='2000ms'");await c.query("SET LOCAL statement_timeout='3000ms'");await c.query("SET LOCAL idle_in_transaction_session_timeout='5000ms'");
    const r=await c.query(p.originalDeliveryUpdate,[f.context.binding.originalTaskId,d.at,JSON.stringify(d.value),d.attempt,d.at]);
    assert.equal(r.command,"UPDATE");assert.equal(r.rowCount,1);assert.equal(r.rows.length,1);const row=taskRow(r.rows[0]);
    const committed=await c.query("COMMIT");assert.equal(committed.command,"COMMIT");state.commitTag=committed.command;
    attempt.writes.push({backend:state.backend,command:r.command,rowCount:r.rowCount,returning:row,commitTag:state.commitTag});return {row,state};
  }catch(error){failure=error;throw error;}
  finally{c.release(failure||undefined);state.released=true;}
}
async function fresh(f,expected,protectedBefore,states){
  for(const s of states){assert.equal(s.commitTag,"COMMIT");assert.equal(s.released,true);}
  const pool=new config.Pool({...config.options,max:1});let c=null;
  try{c=await pool.connect();assert.ok(!states.some(s=>s.backend===c.processID));const row=await readTask(c,f);assert.deepEqual(row,expected);assert.deepEqual(await protectedRecords(c,f),protectedBefore);return {backend:c.processID,row};}
  finally{c?.release();await pool.end();}
}
async function setup(f){await seed(f);const answer=await repository(f).createClaim(f.input);assert.equal(answer.storageStatus,"recorded");assert.equal(answer.protocolPermit,false);const old=await readTask(db,f);assert.deepEqual(old.data.fixtureOpaque,f.input.task.fixtureOpaque);return {old,protectedBefore:await protectedRecords(db,f)};}
async function reconciled(f){const r=await repository(f).reconcileClaim();assert.equal(r.storageStatus,"recorded");assert.equal(r.protocolPermit,false);return r.storageStatus;}
before(async()=>{
  evidence.server=await verifyOwnedServer(db,config);
  await db.query(`CREATE TABLE phone_cloud_devices(device_id text PRIMARY KEY,data jsonb NOT NULL,updated_at timestamptz);
    CREATE TABLE phone_cloud_windows_tasks(task_id text PRIMARY KEY,agent_id text,adb_serial text,status text,created_at timestamptz,updated_at timestamptz,data jsonb NOT NULL);
    CREATE TABLE phone_cloud_automation_jobs(job_id text PRIMARY KEY,device_id text,user_id text,kind text,status text,created_at timestamptz,updated_at timestamptz,data jsonb NOT NULL);
    CREATE TABLE phone_cloud_device_locks(lock_id text PRIMARY KEY,device_id text,status text,expires_at timestamptz,data jsonb NOT NULL);`);
  await db.query(await fs.readFile(path.join(project,"deploy/sql/wecom-cleanup-v2.sql"),"utf8"));await db.query(await fs.readFile(path.join(project,"deploy/sql/wecom-cleanup-v2-claim.sql"),"utf8"));
});
after(async()=>{await db.end();await fs.writeFile(path.join(config.root,"PG_EVIDENCE.json"),JSON.stringify(evidence,null,2)+"\n",{flag:"wx",mode:0o600});});
test("actual PG delivery: delivery-fields",async()=>{
  const attempt={name:"delivery-fields",writes:[]};evidence.attempts.push(attempt);const f=made("delivery-fields"),{old,protectedBefore}=await setup(f);
  const d={value:{token:"synthetic-current",attempt:2,leasedAt:"2099-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:01:00.000Z",ackedAt:"",unknownNested:{keep:[true,null]}},attempt:2,at:"2099-01-01T00:00:00.000Z"};
  const changed=await update(f,d,attempt),expected=expectedRow(old,d);assert.deepEqual(changed.row,expected);assert.deepEqual(stripThree(changed.row.data),stripThree(old.data));
  const readback=await fresh(f,expected,protectedBefore,[changed.state]),m3=await reconciled(f);
  evidence.cases.push({name:attempt.name,...attempt,readback,onlyThreeDataPathsChanged:true,allOtherKnownUnknownFieldsPreserved:true,protectedRecordsPreserved:true,m3StorageStatus:m3,comparisonSqlSha256:hash(p.originalDeliveryUpdate),protocolPermit:false,routeReachabilityProven:false,auditMethodTested:false});
});
test("actual PG delivery: delivery-stale-proposal",async()=>{
  const attempt={name:"delivery-stale-proposal",writes:[]};evidence.attempts.push(attempt);const f=made("delivery-stale-proposal"),{old,protectedBefore}=await setup(f);
  const newer={value:{token:"synthetic-newer",attempt:8,leasedAt:"2099-02-01T00:00:00.000Z",expiresAt:"2099-02-01T00:01:00.000Z",ackedAt:""},attempt:8,at:"2099-02-01T00:00:00.000Z"};
  const older={value:{token:"synthetic-older",attempt:1,leasedAt:"2099-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:01:00.000Z",ackedAt:""},attempt:1,at:"2099-01-01T00:00:00.000Z"};assert.ok(Date.parse(older.at)<Date.parse(newer.at));
  const first=await update(f,newer,attempt),firstExpected=expectedRow(old,newer);assert.deepEqual(first.row,firstExpected);const firstRead=await fresh(f,firstExpected,protectedBefore,[first.state]);
  const second=await update(f,older,attempt),expected=expectedRow(old,older);assert.deepEqual(second.row,expected);assert.deepEqual(stripThree(second.row.data),stripThree(first.row.data));
  const readback=await fresh(f,expected,protectedBefore,[first.state,second.state]),m3=await reconciled(f);
  evidence.cases.push({name:attempt.name,...attempt,firstRead,readback,sequentialNotConcurrent:true,olderProposalReplacedNewerDelivery:true,allOtherKnownUnknownFieldsPreserved:true,protectedRecordsPreserved:true,m3StorageStatus:m3,protocolPermit:false,negativeControl:true,routeReachabilityProven:false,auditMethodTested:false});
});
