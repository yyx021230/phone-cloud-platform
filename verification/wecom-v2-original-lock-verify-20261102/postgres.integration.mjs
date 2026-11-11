// Unexecuted original-business-lock verification. No app/phone wiring.
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
import {loadFixtureTuple,releaseCandidate,applyFixtureCandidate,isFixtureCasConflict} from "./owner-fixture.mjs";
import {createWecomV2ClaimPreparer} from "../../server/wecom-cleanup-v2-claim.mjs";
import {createWecomV2ClaimPostgresRepository} from "../../server/wecom-cleanup-v2-claim-postgres.mjs";
const config=await ownedConfiguration(),db=new config.Pool(config.options);
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const evidence={kind:"original-business-lock-verification-only",server:null,cases:[],attempts:[]};
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
async function businessData(client,f){return(await client.query("SELECT data FROM phone_cloud_device_locks WHERE lock_id=$1",[f.context.originalLockId])).rows[0]?.data;}
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

test("actual PG original business: unmarked-negative",async()=>{
  const kind="unmarked-negative";
  const f=made("business-unmarked-negative");await seed(f);const expected=createWecomV2ClaimPreparer({readClaimContext:()=>f.context})(f.input).candidate;
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
    const late=structuredClone(f.input.businessLock);late.updatedAt="2099-01-01T00:00:00.000Z";late.ownerUserId="fixture_other_owner";
    assert.equal(Object.hasOwn(late,"wecomV2Claim"),false);assert.equal(Object.hasOwn(expected.businessLock,"wecomV2Claim"),false);
    const sql=p.insufficientOriginalBusinessGuard;
    const values=[late.lockId,late.status,late.expiresAt,JSON.stringify(late)];
    attempt.comparisonSql=hash(sql);attempt.bBackend=b.processID;attempt.lateTimestamp=late.updatedAt;attempt.aTimestamp=expected.businessLock.updatedAt;
    attempt.trace.push("B_raw_statement_dispatched_while_A_uncommitted");bSettled=b.query(sql,values).then(result=>({result}),error=>({error}));
    attempt.lockProof=await observeWait(c,b.processID,aClient.processID);attempt.trace.push("C_server_observed_B_active_Lock_blocked_by_A");
    releaseA.resolve();attempt.trace.push("A_COMMIT_released_only_after_server_proof");const a=await bounded(aSettled,5000);if(a.error)throw a.error;
    assert.equal(a.result.storageStatus,"recorded");assert.equal(a.result.protocolPermit,false);assert.equal(attempt.aCommitTag,"COMMIT");
    const done=await bounded(bSettled,3000);if(done.error){bError=done.error;throw done.error;}const returned=done.result;
    attempt.bReturning={command:returned.command,rowCount:returned.rowCount,rows:returned.rows.map(r=>({lockId:r.lock_id,status:r.status,dataSha256:hash(r.data),hasClaim:Object.hasOwn(r.data,"wecomV2Claim")}))};attempt.trace.push("B_raw_statement_returned");
    assert.equal(returned.rowCount,1);assert.equal(returned.rows.length,1);
    assert.equal((await b.query("COMMIT")).command,"COMMIT");bCommitted=true;attempt.trace.push("B_COMMIT_confirmed");b.release();b=null;attempt.trace.push("B_client_released_before_fresh_reconcile");
    const final=await businessData(db,f),ledger=(await db.query("SELECT claim_data FROM phone_cloud_wecom_cleanup_v2 WHERE obligation_id=$1",[f.context.binding.obligationId])).rows[0];
    assert.deepEqual(ledger.claim_data,expected.claimData);const stored=await repository(f).reconcileClaim();
    assert.deepEqual(final,late);assert.equal(stored.storageStatus,"conflict");
    const hold=(await db.query("SELECT data,status,expires_at FROM phone_cloud_device_locks WHERE lock_id=$1",[f.context.binding.obligationId])).rows[0];
    assert.deepEqual(hold.data,expected.physicalHold);assert.equal(hold.status,"cleanup_pending");assert.equal(hold.expires_at,null);
    const anchor=(await db.query("SELECT active_obligation_id FROM phone_cloud_wecom_v2_physical_anchors WHERE physical_key=$1",[f.context.binding.serial.toLowerCase()])).rows[0];assert.equal(anchor.active_obligation_id,f.context.binding.obligationId);
    attempt.final={dataSha256:hash(final),hasClaim:Object.hasOwn(final,"wecomV2Claim"),status:final.status,updatedAt:final.updatedAt,claimDataPreserved:true,m3StorageStatus:stored.storageStatus};
    evidence.cases.push({name:kind,...attempt,protocolPermit:false,negativeControl:true});
  }finally{
    let cleanupError=null;releaseA.resolve();
    if(aSettled){try{const done=await bounded(aSettled,5000);if(done.error)attempt.aCleanupFailure="claim_rejected";}catch(error){cleanupError=error;}}
    if(bSettled){try{const done=await bounded(bSettled,3000);if(done.error)bError=done.error;}catch(error){bError=error;cleanupError||=error;}}
    if(b){if(!bError&&!bCommitted){try{await b.query("ROLLBACK");}catch(error){bError=error;}}b.release(bError||undefined);}
    if(c){try{await c.query("ROLLBACK");}catch(error){cError=error;}c.release(cError||undefined);cleanupError||=cError;}
    if(cleanupError)throw cleanupError;
  }
});

async function protectedRecords(client,f){
  const b=f.context.binding;
  return {hold:(await client.query("SELECT status,expires_at,data FROM phone_cloud_device_locks WHERE lock_id=$1",[b.obligationId])).rows[0],
    ledger:(await client.query("SELECT obligation_id,server_epoch,revision,host_operation_id,close_operation_id,protocol_state,claim_data FROM phone_cloud_wecom_cleanup_v2 WHERE obligation_id=$1",[b.obligationId])).rows[0],
    anchor:(await client.query("SELECT physical_key,device_id,active_obligation_id,active_claim_operation_id,agent_id,mapping_revision,mapping_fingerprint,mapping_state FROM phone_cloud_wecom_v2_physical_anchors WHERE physical_key=$1",[b.serial.toLowerCase()])).rows[0]};
}
async function knownClaim(f){await seed(f);const answer=await repository(f).createClaim(f.input);assert.equal(answer.storageStatus,"recorded");assert.equal(answer.protocolPermit,false);return protectedRecords(db,f);}
async function ownerTransaction(body){
  const client=await db.connect(),state={backend:client.processID,ended:false,released:false,commitTag:null};let failure=null;
  try{
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");await client.query("SET LOCAL lock_timeout='2000ms'");await client.query("SET LOCAL statement_timeout='3000ms'");await client.query("SET LOCAL idle_in_transaction_session_timeout='5000ms'");
    const value=await body(client,state);const committed=await client.query("COMMIT");state.commitTag=committed.command;assert.equal(committed.command,"COMMIT");state.ended=true;
    return {value,state};
  }catch(error){failure=error;throw error;}
  finally{
    if(!state.ended&&!failure){try{const r=await client.query("ROLLBACK");assert.equal(r.command,"ROLLBACK");state.ended=true;}catch(error){failure=error;}}
    client.release(failure||undefined);state.released=true;
  }
}
async function reconcileAfterEnd(f,state){
  assert.equal(state.ended,true,"owner transaction must end before a new connection is used");assert.equal(state.released,true,"owner client must be released before fresh M3");
  const answer=await repository(f).reconcileClaim();assert.equal(answer.storageStatus,"recorded");assert.equal(answer.protocolPermit,false);return answer;
}
async function newBackendReadback(records,oldPids){
  const pool=new config.Pool({...config.options,max:1});let client=null;
  try{client=await pool.connect();assert.ok(!oldPids.includes(client.processID));for(const [f,expected]of records)assert.deepEqual(await businessData(client,f),expected);return {backend:client.processID,records:records.map(([f,data])=>({lockId:f.context.originalLockId,dataSha256:hash(data),status:data.status}))};}
  finally{client?.release();await pool.end();}
}
test("actual PG original business: owner-status-known",async()=>{
  const attempt={name:"owner-status-known",trace:[]};evidence.attempts.push(attempt);
  const f=made("business-owner-status"),before=await knownClaim(f);let next=null;
  const {state,value}=await ownerTransaction(async(client,state)=>{
    attempt.ownerBackend=state.backend;attempt.trace.push("same_client_full_tuple_loading");
    const canonical=await loadFixtureTuple(client,f.context);next=releaseCandidate(canonical);
    const changed=await applyFixtureCandidate(client,canonical,f.context,next);assert.equal(changed.writePermit,false);assert.equal(changed.protocolPermit,false);return {returnedRows:1,canonicalSourceVerified:changed.canonicalSourceVerified};
  });
  attempt.commitTag=state.commitTag;attempt.trace.push("known_commit_and_client_release_before_fresh_M3");const readback=await newBackendReadback([[f,next]],[state.backend]);await reconcileAfterEnd(f,state);assert.deepEqual(await protectedRecords(db,f),before);
  evidence.cases.push({name:"owner-status-known",ownerBackend:state.backend,commitKnown:true,clientReleased:state.released,...value,readback,physicalObligationUnchanged:true,syntheticFixtureOwnerOnly:true,protocolPermit:false});
});
test("actual PG original business: target-nowait",async()=>{
  const attempt={name:"target-nowait",trace:[]};evidence.attempts.push(attempt);
  const f=made("business-nowait-one"),g=made("business-nowait-two"),fBefore=await knownClaim(f),gBefore=await knownClaim(g),firstData=await businessData(db,f);
  const holder=await db.connect();let holderReleased=false,next=null,state=null;
  try{
    await holder.query("BEGIN");assert.equal((await holder.query(q.readHold,[f.context.originalLockId])).rowCount,1);
    ({state}=await ownerTransaction(async(client,state)=>{
      attempt.ownerBackend=state.backend;attempt.holderBackend=holder.processID;
      await client.query("SAVEPOINT first_target");let caught=null;
      try{await loadFixtureTuple(client,f.context);}catch(error){caught=error;}
      assert.equal(caught?.code,"55P03");attempt.firstTargetError=caught.code;await client.query("ROLLBACK TO SAVEPOINT first_target");await client.query("RELEASE SAVEPOINT first_target");attempt.trace.push("first_target_55P03_rolled_back_to_savepoint");
      const c=await loadFixtureTuple(client,g.context);next=releaseCandidate(c);await applyFixtureCandidate(client,c,g.context,next);
    }));
    assert.equal((await holder.query("ROLLBACK")).command,"ROLLBACK");holder.release();holderReleased=true;
    attempt.commitTag=state.commitTag;const readback=await newBackendReadback([[f,firstData],[g,next]],[state.backend,holder.processID]);
    await reconcileAfterEnd(f,state);await reconcileAfterEnd(g,state);assert.deepEqual(await protectedRecords(db,f),fBefore);assert.deepEqual(await protectedRecords(db,g),gBefore);
    evidence.cases.push({name:"target-nowait",holderBackend:holder.processID,ownerBackend:state.backend,firstTargetError:"55P03",rollbackToTarget:true,secondTargetSameTransactionCommitted:true,readback,allPhysicalObligationsUnchanged:true,protocolPermit:false});
  }finally{if(!holderReleased){try{await holder.query("ROLLBACK");}finally{holder.release();}}}
});
test("actual PG original business: target-cas-zero",async()=>{
  const attempt={name:"target-cas-zero",trace:[]};evidence.attempts.push(attempt);
  const f=made("business-cas-one"),g=made("business-cas-two"),fBefore=await knownClaim(f),gBefore=await knownClaim(g),firstData=await businessData(db,f);let next=null;
  const {state}=await ownerTransaction(async(client,state)=>{
    attempt.ownerBackend=state.backend;
    await client.query("SAVEPOINT first_target");const original=await loadFixtureTuple(client,f.context),candidate=releaseCandidate(original);
    // Verification-only same-TX fault: actual JSONB differs from the frozen
    // expected snapshot, producing a REAL zero-row CAS (not a fake response).
    const injection=await client.query("UPDATE phone_cloud_device_locks SET data=jsonb_set(data,'{fixtureFault}',to_jsonb('changed-before-CAS'::text),true) WHERE lock_id=$1 RETURNING lock_id",[f.context.originalLockId]);assert.equal(injection.rowCount,1);
    let caught=null;try{await applyFixtureCandidate(client,original,f.context,candidate);}catch(error){caught=error;}
    assert.equal(isFixtureCasConflict(caught),true);attempt.actualCasRowCount=0;await client.query("ROLLBACK TO SAVEPOINT first_target");await client.query("RELEASE SAVEPOINT first_target");attempt.trace.push("owned_real_zero_CAS_and_fault_injection_rolled_back_to_target");
    const current=await loadFixtureTuple(client,g.context);next=releaseCandidate(current);await applyFixtureCandidate(client,current,g.context,next);
  });
  attempt.commitTag=state.commitTag;const readback=await newBackendReadback([[f,firstData],[g,next]],[state.backend]);await reconcileAfterEnd(f,state);await reconcileAfterEnd(g,state);
  assert.equal(Object.hasOwn(await businessData(db,f),"fixtureFault"),false);assert.deepEqual(await protectedRecords(db,f),fBefore);assert.deepEqual(await protectedRecords(db,g),gBefore);
  evidence.cases.push({name:"target-cas-zero",ownerBackend:state.backend,actualCasRowCount:0,injectedFaultRolledBackWithTarget:true,secondTargetSameTransactionCommitted:true,readback,allPhysicalObligationsUnchanged:true,protocolPermit:false});
});
