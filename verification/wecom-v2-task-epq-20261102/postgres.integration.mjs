// Unexecuted verification only. Four owned private-PG groups, no app wiring.
import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {ownedConfiguration,verifyOwnedServer} from "./owned-pg.mjs";
import {fixture} from "../wecom-v2-claim-bundle-20261102/fixture.mjs";
import {comparisonQueries as q} from "../wecom-v2-writer-epq-plan-20261102/comparison-queries.mjs";
import {createWecomV2ClaimPreparer} from "../../server/wecom-cleanup-v2-claim.mjs";
import {createWecomV2ClaimPostgresRepository} from "../../server/wecom-cleanup-v2-claim-postgres.mjs";
const config=await ownedConfiguration(),db=new config.Pool(config.options);
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const evidence={kind:"task-EPQ-and-target-savepoint-only",server:null,cases:[],attempts:[]};
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
async function taskData(client,f){return(await client.query("SELECT data FROM phone_cloud_windows_tasks WHERE task_id=$1",[f.context.binding.originalTaskId])).rows[0]?.data;}
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

for(const kind of["unsafe-not-exists","guarded-update","guarded-upsert"])test(`actual PG task EPQ: ${kind}`,async()=>{
  const f=made(`epq-${kind}`);await seed(f);const expected=createWecomV2ClaimPreparer({readClaimContext:()=>f.context})(f.input).candidate;
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
    const late=structuredClone(f.input.task);late.updatedAt="2099-01-01T00:00:00.000Z";assert.ok(Date.parse(late.updatedAt)>Date.parse(expected.windowsTask.updatedAt));
    const sql=kind==="unsafe-not-exists"?q.unsafeTaskNotExists:kind==="guarded-update"?q.guardedTaskUpdate:q.guardedTaskUpsert;
    const values=kind==="guarded-upsert"?[late.taskId,late.agentId,late.adbSerial,late.status,late.createdAt,late.updatedAt,JSON.stringify(late)]:[late.taskId,late.status,late.updatedAt,JSON.stringify(late)];
    attempt.comparisonSql=hash(sql);attempt.bBackend=b.processID;attempt.lateTimestamp=late.updatedAt;attempt.aTimestamp=expected.windowsTask.updatedAt;
    attempt.trace.push("B_raw_statement_dispatched_while_A_uncommitted");bSettled=b.query(sql,values).then(result=>({result}),error=>({error}));
    attempt.lockProof=await observeWait(c,b.processID,aClient.processID);attempt.trace.push("C_server_observed_B_active_Lock_blocked_by_A");
    releaseA.resolve();attempt.trace.push("A_COMMIT_released_only_after_server_proof");const a=await bounded(aSettled,5000);if(a.error)throw a.error;
    assert.equal(a.result.storageStatus,"recorded");assert.equal(a.result.protocolPermit,false);assert.equal(attempt.aCommitTag,"COMMIT");
    const done=await bounded(bSettled,3000);if(done.error){bError=done.error;throw done.error;}const returned=done.result;
    attempt.bReturning={command:returned.command,rowCount:returned.rowCount,rows:returned.rows.map(r=>({taskId:r.task_id,status:r.status,dataSha256:hash(r.data),hasClaim:Object.hasOwn(r.data,"wecomV2Claim")}))};attempt.trace.push("B_raw_statement_returned");
    if(kind==="unsafe-not-exists"){assert.equal(returned.rowCount,1);assert.equal(returned.rows.length,1);}else{assert.equal(returned.rowCount,0);assert.deepEqual(returned.rows,[]);}
    assert.equal((await b.query("COMMIT")).command,"COMMIT");bCommitted=true;attempt.trace.push("B_COMMIT_confirmed");
    const final=await taskData(db,f),ledger=(await db.query("SELECT claim_data FROM phone_cloud_wecom_cleanup_v2 WHERE obligation_id=$1",[f.context.binding.obligationId])).rows[0];
    assert.deepEqual(ledger.claim_data,expected.claimData);const stored=await repository(f).reconcileClaim();
    if(kind==="unsafe-not-exists"){assert.deepEqual(final,late);assert.equal(stored.storageStatus,"conflict");}
    else{assert.deepEqual(final,expected.windowsTask);assert.deepEqual(final.wecomV2Claim,expected.claimData);assert.deepEqual(final.payload.physicalCleanup,f.context.binding);assert.equal(stored.storageStatus,"recorded");}
    attempt.final={dataSha256:hash(final),hasClaim:Object.hasOwn(final,"wecomV2Claim"),status:final.status,updatedAt:final.updatedAt,claimDataPreserved:true,m3StorageStatus:stored.storageStatus};
    evidence.cases.push({name:kind,...attempt,protocolPermit:false,negativeControl:kind==="unsafe-not-exists"});
  }finally{
    let cleanupError=null;releaseA.resolve();
    if(aSettled){try{const done=await bounded(aSettled,5000);if(done.error)attempt.aCleanupFailure="claim_rejected";}catch(error){cleanupError=error;}}
    if(bSettled){try{const done=await bounded(bSettled,3000);if(done.error)bError=done.error;}catch(error){bError=error;cleanupError||=error;}}
    if(b){if(!bError&&!bCommitted){try{await b.query("ROLLBACK");}catch(error){bError=error;}}b.release(bError||undefined);}
    if(c){try{await c.query("ROLLBACK");}catch(error){cError=error;}c.release(cError||undefined);cleanupError||=cError;}
    if(cleanupError)throw cleanupError;
  }
});
test("actual PG target SAVEPOINT: first NOWAIT failure, second same transaction commits",async()=>{
  const f=made("savepoint-one"),g=made("savepoint-two");await seed(f);await seed(g);
  const hold=await db.connect(),writer=await db.connect();let writerCommitted=false,failure=null;
  const attempt={name:"target-savepoint",holderBackend:hold.processID,writerBackend:writer.processID,trace:[]};evidence.attempts.push(attempt);
  try{
    await hold.query("BEGIN");await hold.query(q.anchor,[f.context.binding.serial]);
    await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");await writer.query("SET LOCAL statement_timeout='3000ms'");await writer.query("SAVEPOINT target_one");
    let caught=null;try{await writer.query(q.anchor,[f.context.binding.serial]);}catch(error){caught=error;}
    assert.equal(caught?.code,"55P03");attempt.firstTargetError=caught.code;await writer.query("ROLLBACK TO SAVEPOINT target_one");await writer.query("RELEASE SAVEPOINT target_one");attempt.trace.push("first_target_SQL_NOWAIT_failed_and_savepoint_rolled_back");
    const secondAnchor=await writer.query(q.anchor,[g.context.binding.serial]);assert.equal(secondAnchor.rows[0].active_obligation_id,null);
    const next=structuredClone(g.input.task);next.status="stalled";next.updatedAt="2099-01-01T00:00:00.000Z";
    const updated=await writer.query(q.guardedTaskUpdate,[next.taskId,next.status,next.updatedAt,JSON.stringify(next)]);assert.equal(updated.rowCount,1);assert.deepEqual(updated.rows[0].data,next);
    assert.equal((await writer.query("COMMIT")).command,"COMMIT");writerCommitted=true;attempt.trace.push("second_target_same_writer_transaction_COMMIT_confirmed");
    const freshPool=new config.Pool({...config.options,max:1});let fresh=null;
    try{fresh=await freshPool.connect();assert.notEqual(fresh.processID,writer.processID);assert.notEqual(fresh.processID,hold.processID);
      const first=await taskData(fresh,f),second=await taskData(fresh,g);assert.deepEqual(first,f.input.task);assert.deepEqual(second,next);
      attempt.readbackBackend=fresh.processID;attempt.firstUnchanged=true;attempt.secondDataSha256=hash(second);attempt.secondStatus=second.status;
    }finally{fresh?.release();await freshPool.end();}
    evidence.cases.push({name:"target-savepoint",...attempt,commitKnown:true,physicalPermission:false});
  }catch(error){failure=error;throw error;}
  finally{if(!writerCommitted&&!failure){try{await writer.query("ROLLBACK");}catch(error){failure=error;}}writer.release(failure||undefined);try{await hold.query("ROLLBACK");}finally{hold.release();}}
});
