// Unexecuted job/hold comparison only. Four private-PG groups, no app wiring.
import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {ownedConfiguration,verifyOwnedServer} from "./owned-pg.mjs";
import {fixture} from "../wecom-v2-claim-bundle-20261102/fixture.mjs";
import {comparisonQueries as q} from "../wecom-v2-writer-epq-plan-20261102/comparison-queries.mjs";
import {projectionSql as p} from "../wecom-v2-projection-sql-plan-20261102/verification-queries.mjs";
import {createWecomV2ClaimPreparer} from "../../server/wecom-cleanup-v2-claim.mjs";
import {createWecomV2ClaimPostgresRepository} from "../../server/wecom-cleanup-v2-claim-postgres.mjs";
const config=await ownedConfiguration(),db=new config.Pool(config.options);
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const evidence={kind:"job-hold-EPQ-only",server:null,cases:[],attempts:[]};
function canonical(v){return Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;}
const hash=v=>createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("fixture_wait_timeout")),ms);})]);}finally{clearTimeout(timer);}}
const made=name=>fixture({suffix:name,serial:`fixture-${name}`});
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
async function projectedRow(client,f,role){return role==="job"?(await client.query("SELECT data,status FROM phone_cloud_automation_jobs WHERE job_id=$1",[f.context.originalJobId])).rows[0]:(await client.query("SELECT data,status,expires_at FROM phone_cloud_device_locks WHERE lock_id=$1",[f.context.binding.obligationId])).rows[0];}
async function observeWait(control,waiter,blocker){
  const start=performance.now(),deadline=start+800;
  for(let reads=1;reads<=32&&performance.now()<deadline;reads++){
    await control.query("SELECT pg_stat_clear_snapshot()");
    const answer=await control.query(`SELECT pid,state,wait_event_type,pg_blocking_pids(pid) AS blockers,
      backend_xmin::text AS backend_xmin,query_start FROM pg_stat_activity WHERE pid=$1`,[waiter]);
    const r=answer.rows[0];
    if(answer.rowCount===1&&r.pid===waiter&&r.state==="active"&&r.wait_event_type==="Lock"&&Array.isArray(r.blockers)&&r.blockers.includes(blocker))
      return {waiter,blocker,controlBackend:control.processID,state:r.state,waitEventType:r.wait_event_type,blockingPids:r.blockers,
        backendXmin:r.backend_xmin,queryStart:r.query_start,reads,elapsedMs:performance.now()-start,exactStatementSnapshotExported:false};
  }throw Error("fixture_backend_lock_wait_not_observed");
}
before(async()=>{
  evidence.server=await verifyOwnedServer(db,config);
  await db.query(`CREATE TABLE phone_cloud_devices(device_id text PRIMARY KEY,data jsonb NOT NULL,updated_at timestamptz);
    CREATE TABLE phone_cloud_windows_tasks(task_id text PRIMARY KEY,agent_id text,adb_serial text,status text,created_at timestamptz,updated_at timestamptz,data jsonb NOT NULL);
    CREATE TABLE phone_cloud_automation_jobs(job_id text PRIMARY KEY,device_id text,user_id text,kind text,status text,created_at timestamptz,updated_at timestamptz,data jsonb NOT NULL);
    CREATE TABLE phone_cloud_device_locks(lock_id text PRIMARY KEY,device_id text,status text,expires_at timestamptz,data jsonb NOT NULL);`);
  await db.query(await fs.readFile(path.join(project,"deploy/sql/wecom-cleanup-v2.sql"),"utf8"));
  await db.query(await fs.readFile(path.join(project,"deploy/sql/wecom-cleanup-v2-claim.sql"),"utf8"));
});
after(async()=>{await db.end();await fs.writeFile(path.join(config.root,"PG_EVIDENCE.json"),JSON.stringify(evidence,null,2)+"\n",{flag:"wx",mode:0o600});});

for(const kind of["job-negative","job-guarded","hold-negative","hold-guarded"])test(`actual PG projection EPQ: ${kind}`,async()=>{
  const role=kind.startsWith("job")?"job":"hold",negative=kind.endsWith("negative");
  const f=made(`projection-${kind}`);await seed(f);const expected=createWecomV2ClaimPreparer({readClaimContext:()=>f.context})(f.input).candidate;
  const attempt={name:kind,trace:[],comparisonSql:null};evidence.attempts.push(attempt);
  const aReady=deferred(),releaseA=deferred();let aClient=null,aWrites=0,aSettled=null,bSettled=null,b=null,c=null,bCommitted=false,bError=null,cError=null;
  const pool={async connect(){const client=await db.connect();aClient=client;return {on:(n,fn)=>client.on(n,fn),removeListener:(n,fn)=>client.removeListener(n,fn),release:e=>client.release(e),async query(sql,args){
    if(/^(INSERT|UPDATE)/.test(sql))aWrites++;
    if(sql==="COMMIT"){
      attempt.aTransaction=(await client.query("SELECT pg_current_xact_id()::text AS xid,pg_current_snapshot()::text AS snapshot")).rows[0];
      attempt.aBackend=client.processID;attempt.aDmlCount=aWrites;attempt.trace.push("A_all_five_DML_uncommitted_before_COMMIT");aReady.resolve();
      await bounded(releaseA.promise,3000);
    }const answer=await client.query(sql,args);if(sql==="COMMIT")attempt.aCommitTag=answer.command;return answer;
  }};}};
  try{
    // Reserve B and the third control connection before starting A/B budgets.
    b=await db.connect();c=await db.connect();await b.query("BEGIN ISOLATION LEVEL READ COMMITTED");await b.query("SET LOCAL statement_timeout='2500ms'");
    await c.query("BEGIN");await c.query("SET LOCAL statement_timeout='150ms'");
    aSettled=repository(f,pool).createClaim(f.input).then(result=>({result}),error=>({error}));await bounded(aReady.promise,2000);
    assert.equal(aWrites,5);assert.equal(new Set([aClient.processID,b.processID,c.processID]).size,3);
    const expectedData=role==="job"?expected.automationJob:expected.physicalHold;
    const late=structuredClone(role==="job"?f.input.job:expected.physicalHold);late.updatedAt="2099-01-01T00:00:00.000Z";
    if(role==="hold"){late.status="released";assert.equal(late.expiresAt,"");assert.deepEqual(late.physicalCleanup.binding,f.context.binding);}
    assert.ok(Date.parse(late.updatedAt)>Date.parse(expectedData.updatedAt));
    const sql=role==="job"?(negative?p.unsafeJobUpsert:q.guardedJobUpsert):(negative?p.unsafeHoldUpsert:q.guardedHoldUpsert);
    const values=role==="job"?[late.jobId,late.deviceId,late.userId,late.kind,late.status,late.createdAt,late.updatedAt,JSON.stringify(late)]:[late.lockId,late.deviceId,late.status,null,JSON.stringify(late)];
    attempt.comparisonSql=hash(sql);attempt.bBackend=b.processID;attempt.lateTimestamp=late.updatedAt;attempt.aTimestamp=expectedData.updatedAt;
    attempt.trace.push("B_raw_statement_dispatched_while_A_uncommitted");bSettled=b.query(sql,values).then(result=>({result}),error=>({error}));
    attempt.lockProof=await observeWait(c,b.processID,aClient.processID);attempt.trace.push("C_server_observed_B_active_Lock_blocked_by_A");
    releaseA.resolve();attempt.trace.push("A_COMMIT_released_only_after_server_proof");const a=await bounded(aSettled,5000);if(a.error)throw a.error;
    assert.equal(a.result.storageStatus,"recorded");assert.equal(a.result.protocolPermit,false);assert.equal(attempt.aCommitTag,"COMMIT");
    const done=await bounded(bSettled,3000);if(done.error){bError=done.error;throw done.error;}const returned=done.result;
    attempt.bReturning={command:returned.command,rowCount:returned.rowCount,rows:returned.rows.map(r=>({recordId:r.job_id||r.lock_id,status:r.status,dataSha256:hash(r.data),hasClaim:Object.hasOwn(r.data,"wecomV2Claim"),bindingVersion:r.data.physicalCleanup?.binding?.version??null}))};attempt.trace.push("B_raw_statement_returned");
    if(negative){assert.equal(returned.rowCount,1);assert.equal(returned.rows.length,1);}else{assert.equal(returned.rowCount,0);assert.deepEqual(returned.rows,[]);}
    assert.equal((await b.query("COMMIT")).command,"COMMIT");bCommitted=true;attempt.trace.push("B_COMMIT_confirmed");
    const finalRow=await projectedRow(db,f,role),final=finalRow.data,ledger=(await db.query("SELECT claim_data FROM phone_cloud_wecom_cleanup_v2 WHERE obligation_id=$1",[f.context.binding.obligationId])).rows[0];
    assert.equal(finalRow.status,final.status);
    assert.deepEqual(ledger.claim_data,expected.claimData);const stored=await repository(f).reconcileClaim();
    if(negative){assert.deepEqual(final,late);assert.equal(stored.storageStatus,"conflict");}
    else{assert.deepEqual(final,expectedData);if(role==="job")assert.deepEqual(final.wecomV2Claim,expected.claimData);
      else{assert.equal(final.status,"cleanup_pending");assert.equal(final.expiresAt,"");assert.deepEqual(final.physicalCleanup.binding,f.context.binding);}assert.equal(stored.storageStatus,"recorded");}
    if(role==="hold"){assert.equal(finalRow.expires_at,null);assert.deepEqual(final.physicalCleanup.binding,f.context.binding);}
    const physical=(await db.query("SELECT active_obligation_id FROM phone_cloud_wecom_v2_physical_anchors WHERE physical_key=$1",[f.context.binding.serial.toLowerCase()])).rows[0];
    assert.equal(physical.active_obligation_id,f.context.binding.obligationId);
    attempt.final={role,dataSha256:hash(final),hasClaim:Object.hasOwn(final,"wecomV2Claim"),bindingVersion:final.physicalCleanup?.binding?.version??null,status:final.status,updatedAt:final.updatedAt,claimDataPreserved:true,...(role==="hold"?{sqlExpiresAt:finalRow.expires_at}:{}),physicalAnchorRetained:true,m3StorageStatus:stored.storageStatus};
    evidence.cases.push({name:kind,...attempt,protocolPermit:false,negativeControl:negative});
  }finally{
    let cleanupError=null;releaseA.resolve();
    if(aSettled){try{const done=await bounded(aSettled,5000);if(done.error)attempt.aCleanupFailure="claim_rejected";}catch(error){cleanupError=error;}}
    if(bSettled){try{const done=await bounded(bSettled,3000);if(done.error)bError=done.error;}catch(error){bError=error;cleanupError||=error;}}
    if(b){if(!bError&&!bCommitted){try{await b.query("ROLLBACK");}catch(error){bError=error;}}b.release(bError||undefined);}
    if(c){try{await c.query("ROLLBACK");}catch(error){cError=error;}c.release(cError||undefined);cleanupError||=cError;}
    if(cleanupError)throw cleanupError;
  }
});
