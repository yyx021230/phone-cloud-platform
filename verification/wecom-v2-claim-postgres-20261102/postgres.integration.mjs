// NOT EXECUTED. Private owned-cluster entry only, outside normal test globs.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ownedConfiguration, verifyOwnedServer } from "./owned-pg.mjs";
import { fixture } from "../wecom-v2-claim-bundle-20261102/fixture.mjs";
import { fixture as hostFixture } from "../wecom-v2-cas-m2-20261102/fixture.mjs";
import { startCommitReplyProxy } from "../wecom-v2-cas-m2-20261102/pg-commit-proxy.mjs";
import { createFaultClientObserver } from "../wecom-v2-cas-m2-20261102/pg-fault-observer.mjs";
import { createWecomV2ClaimPostgresRepository } from "../../server/wecom-cleanup-v2-claim-postgres.mjs";
import { createWecomV2HostState, createWecomV2HostPreparer } from "../../server/wecom-cleanup-v2-host.mjs";
import { createWecomV2PostgresRepository } from "../../server/wecom-cleanup-v2-postgres.mjs";

const config = await ownedConfiguration(), db = new config.Pool(config.options);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = { kind: "private-claim-storage-only", server: null, cases: [] };
const names = ["physical_key", "device_id", "active_obligation_id", "active_claim_operation_id", "agent_id", "mapping_revision", "mapping_fingerprint", "mapping_state"];
const fingerprint = f => createHash("sha256").update(JSON.stringify([f.context.binding.deviceId, f.context.binding.serial, f.context.binding.agentId, f.context.target.deviceNumber])).digest("hex");
const made = suffix => fixture({ suffix, serial: `fixture-${suffix}` });
const repo = (f, pool = db, device = f.input.device) => createWecomV2ClaimPostgresRepository({ getPool: async () => pool, readClaimContext: () => f.context,
  readDeviceMapping: () => ({ device, mappingRevision: 1 }) });
const note = (name, facts = {}) => evidence.cases.push({ name, ...facts });
const row = async (table, column, value) => (await db.query(`SELECT * FROM ${table} WHERE ${column}=$1`, [value])).rows[0]; // table names fixture constants only
const anchor = f => row("phone_cloud_wecom_v2_physical_anchors", "physical_key", f.context.binding.serial.toLowerCase());
const ledger = f => row("phone_cloud_wecom_cleanup_v2", "obligation_id", f.context.binding.obligationId);
const storedTask = f => row("phone_cloud_windows_tasks", "task_id", f.context.binding.originalTaskId);
const lockedOriginal = f => row("phone_cloud_device_locks", "lock_id", f.context.originalLockId);
const isDml = sql => /^(INSERT|UPDATE|DELETE)/.test(sql);
function noPermit(answer) { assert.equal(answer.protocolPermit, false); assert.equal(answer.mappingBarrierVerified, false); assert.equal(answer.productionEnabled, false); assert.equal(answer.liveChecksRequired, true); assert.equal(answer.fence, "held"); }
function adapter(pool, intercept) {
  return { async connect() {
    const client = await pool.connect();
    return { on: (n, fn) => client.on(n, fn), removeListener: (n, fn) => client.removeListener(n, fn), release: e => client.release(e),
      query: (sql, values) => intercept(client, sql, values) };
  } };
}
async function saveData(table, column, id, data, status = data.status) {
  await db.query(`UPDATE ${table} SET status=$2,updated_at=$3,data=$4::jsonb WHERE ${column}=$1`, [id, status, data.updatedAt, JSON.stringify(data)]);
}
async function observedOldTaskWait(oldBackendPid, leafBackendPid, startOldWait) {
  // No sleep or guessed event-loop turn: a third owned backend observes the
  // actual server lock wait, bounded both by deadline and number of reads.
  const control=await db.connect();let failed=null,cleanupError=null;
  try {
    await control.query("BEGIN");await control.query("SET LOCAL statement_timeout='150ms'");
    // Prepare the control backend before starting the old 2s statement budget.
    const started=performance.now(),deadline=started+800;startOldWait();
    for(let reads=1;reads<=32&&performance.now()<deadline;reads++){
      await control.query("SELECT pg_stat_clear_snapshot()");
      const r=await control.query("SELECT pid,state,wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1",[oldBackendPid]);
      const actual=r.rows[0];
      if(r.rowCount===1&&actual.pid===oldBackendPid&&actual.state==="active"&&actual.wait_event_type==="Lock"
        &&Array.isArray(actual.blockers)&&actual.blockers.includes(leafBackendPid)){
        return {oldBackendPid,leafBackendPid,controlBackendPid:control.processID,oldState:actual.state,waitEventType:actual.wait_event_type,
          blockingPids:actual.blockers,reads,elapsedMs:performance.now()-started};
      }
    }
    throw Error("fixture_server_lock_wait_not_observed");
  }catch(error){failed=error;throw error;}
  finally{
    if(!failed){try{await control.query("ROLLBACK");}catch(error){failed=cleanupError=error;}}
    control.release(failed||undefined);if(cleanupError)throw cleanupError;
  }
}
async function seed(f, { extra = false, state = "ready", noAnchor = false, noDevice = false } = {}) {
  const b = f.context.binding, { task: t, job: j, businessLock: l, device } = f.input;
  if (!extra && !noDevice) await db.query("INSERT INTO phone_cloud_devices VALUES ($1,$2::jsonb,NULL)", [b.deviceId, JSON.stringify(device)]);
  await db.query("INSERT INTO phone_cloud_windows_tasks VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)", [t.taskId,t.agentId,t.adbSerial,t.status,t.createdAt,t.updatedAt,JSON.stringify(t)]);
  await db.query("INSERT INTO phone_cloud_automation_jobs VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)", [j.jobId,j.deviceId,j.userId,j.kind,j.status,j.createdAt,j.updatedAt,JSON.stringify(j)]);
  await db.query("INSERT INTO phone_cloud_device_locks VALUES ($1,$2,$3,$4,$5::jsonb)", [l.lockId,l.deviceId,l.status,l.expiresAt,JSON.stringify(l)]);
  if (!extra && !noAnchor) await db.query(`INSERT INTO phone_cloud_wecom_v2_physical_anchors (${names.join(",")}) VALUES ($1,$2,NULL,NULL,$3,1,$4,$5)`,
    [b.serial.toLowerCase(),b.deviceId,b.agentId,fingerprint(f),state]);
  // Test-only checked projection from an actual existing device row. This is
  // NOT production mapping-writer barrier attestation.
  return (await row("phone_cloud_devices", "device_id", b.deviceId))?.data ?? null;
}
before(async () => {
  evidence.server = await verifyOwnedServer(db, config);
  await db.query(`CREATE TABLE phone_cloud_devices(device_id text PRIMARY KEY,data jsonb NOT NULL,updated_at timestamptz);
    CREATE TABLE phone_cloud_windows_tasks(task_id text PRIMARY KEY,agent_id text,adb_serial text,status text,created_at timestamptz,updated_at timestamptz,data jsonb NOT NULL);
    CREATE TABLE phone_cloud_automation_jobs(job_id text PRIMARY KEY,device_id text,user_id text,kind text,status text,created_at timestamptz,updated_at timestamptz,data jsonb NOT NULL);
    CREATE TABLE phone_cloud_device_locks(lock_id text PRIMARY KEY,device_id text,status text,expires_at timestamptz,data jsonb NOT NULL);`);
  await db.query(await fs.readFile(path.join(project,"deploy/sql/wecom-cleanup-v2.sql"),"utf8"));
  await db.query(await fs.readFile(path.join(project,"deploy/sql/wecom-cleanup-v2-claim.sql"),"utf8"));
  await db.query(`CREATE FUNCTION claim_fixture_reject_row() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF to_jsonb(NEW)->>TG_ARGV[0]=TG_ARGV[1] THEN RAISE EXCEPTION 'claim_fixture_reject'; END IF; RETURN NEW; END; $$;`);
});
after(async () => { await db.end(); await fs.writeFile(path.join(config.root,"PG_EVIDENCE.json"),JSON.stringify(evidence,null,2)+"\n",{flag:"wx",mode:0o600}); });

for (const slot of ["main","clone"]) test(`actual PG: ${slot} complete tuple only`, async () => {
  const f=fixture({suffix:`basic-${slot}`,serial:`fixture-basic-${slot}`,slot});const device=await seed(f);const answer=await repo(f,db,device).createClaim(f.input);
  assert.equal(answer.storageStatus,"recorded");noPermit(answer);assert.equal((await anchor(f)).active_obligation_id,f.context.binding.obligationId);
  const v=await ledger(f);assert.equal(v.claim_data.mode,"preview");assert.equal(v.revision,0);assert.equal((await storedTask(f)).data.wecomV2Claim.claimOperationId,f.context.claimOperationId);
  note(`basic-${slot}`,{fullTupleRecorded:true,permission:false});
});
test("actual PG: different task/main+clone one physical anchor",async()=>{
  const f=made("physical-one"),g=fixture({suffix:"physical-two",serial:f.context.binding.serial,slot:"clone"});
  g.context.target.deviceNumber=f.context.target.deviceNumber;g.input.device.deviceName=f.context.target.deviceNumber;
  g.input.job.wecomDeviceNumber=f.context.target.deviceNumber;g.input.task.payload.deviceNumber=f.context.target.deviceNumber;
  await seed(f);await seed(g,{extra:true});let arrivals=0,release;const wait=new Promise(resolve=>{release=resolve;});const timer=setTimeout(release,2000);
  const pids=[];const pool=adapter(db,async(c,sql,args)=>{if(sql.includes("FROM phone_cloud_wecom_v2_physical_anchors")){pids.push(c.processID);if(++arrivals===2)release();await wait;}return c.query(sql,args);});
  try { const results=await Promise.all([repo(f,pool).createClaim(f.input),repo(g,pool).createClaim(g.input)]);
    assert.equal(results.filter(a=>a.storageStatus==="recorded").length,1);assert.ok(results.every(a=>["recorded","busy","unavailable"].includes(a.storageStatus)));
    assert.equal(new Set(pids).size,2);note("same-physical",{results:results.map(a=>a.storageStatus),backendPids:pids,narrowAnchorOnly:true,oldBusinessAdmissionNotExercised:true});
  } finally {clearTimeout(timer);}
});
test("actual PG: different serial commits while first anchor held",async()=>{
  const f=made("independent-one"),g=made("independent-two");await seed(f);await seed(g);const c=await db.connect();
  try {await c.query("BEGIN");await c.query("SELECT physical_key FROM phone_cloud_wecom_v2_physical_anchors WHERE physical_key=$1 FOR UPDATE",[f.context.binding.serial]);
    assert.equal((await repo(g).createClaim(g.input)).storageStatus,"recorded");assert.equal((await repo(f).createClaim(f.input)).storageStatus,"unavailable");
    note("different-physical",{secondCommittedWhileFirstLocked:true});
  } finally {await c.query("ROLLBACK");c.release();}
});
test("actual PG: missing anchor/device and case alias do not create mapping",async()=>{
  const f=made("missing-anchor");await seed(f,{noAnchor:true});assert.equal((await repo(f).createClaim(f.input)).storageStatus,"conflict");assert.equal(await anchor(f),undefined);
  const g=made("missing-device"),device=await seed(g,{noDevice:true});assert.equal(device,null);assert.throws(()=>repo(g,db,device),/mapping_unconfirmed/);
  const h=fixture({suffix:"case-alias",serial:"Fixture-case"});await seed(h);const a=await anchor(h);assert.equal(a.physical_key,"fixture-case");
  await assert.rejects(db.query("INSERT INTO phone_cloud_wecom_v2_physical_anchors SELECT * FROM phone_cloud_wecom_v2_physical_anchors WHERE physical_key=$1",[a.physical_key]),e=>e.code==="23505");note("mapping-missing",{noImplicitRows:true,caseKeyUnique:true});
});
test("actual PG: default disabled and mismatch gates refuse",async()=>{
  const f=made("disabled");await seed(f,{state:"disabled"});assert.equal((await repo(f).createClaim(f.input)).storageStatus,"conflict");
  await db.query("UPDATE phone_cloud_wecom_v2_physical_anchors SET mapping_state='ready',mapping_revision=2 WHERE physical_key=$1",[f.context.binding.serial]);
  assert.equal((await repo(f).createClaim(f.input)).storageStatus,"conflict");
  const g=made("default-disabled");await seed(g,{noAnchor:true});await db.query("INSERT INTO phone_cloud_wecom_v2_physical_anchors(physical_key,device_id,agent_id,mapping_revision,mapping_fingerprint) VALUES($1,$2,$3,1,$4)",[g.context.binding.serial,g.context.binding.deviceId,g.context.binding.agentId,fingerprint(g)]);
  assert.equal((await anchor(g)).mapping_state,"disabled");note("mapping-disabled",{defaultDisabled:true,mismatchRejected:true});
});
test("actual PG: synthetic mapping barrier disables first, active rebind rejected",async()=>{
  const f=made("rebind");await seed(f);const c=await db.connect();
  try {await c.query("BEGIN");await c.query("SELECT physical_key FROM phone_cloud_wecom_v2_physical_anchors WHERE physical_key=$1 FOR UPDATE NOWAIT",[f.context.binding.serial]);
    await c.query("UPDATE phone_cloud_wecom_v2_physical_anchors SET mapping_state='disabled',mapping_revision=mapping_revision+1 WHERE physical_key=$1",[f.context.binding.serial]);
    assert.equal((await repo(f).createClaim(f.input)).storageStatus,"unavailable");await c.query("COMMIT");
  } finally {await c.query("ROLLBACK");c.release();}
  assert.equal((await repo(f).createClaim(f.input)).storageStatus,"conflict");
  const g=made("active-rebind");await seed(g);await repo(g).createClaim(g.input);
  const result=await db.query("UPDATE phone_cloud_wecom_v2_physical_anchors SET mapping_state='disabled' WHERE physical_key=$1 AND active_obligation_id IS NULL RETURNING physical_key",[g.context.binding.serial]);assert.equal(result.rowCount,0);
  note("mapping-rebind",{syntheticParticipatingWriterOnly:true,productionBarrierImplemented:false});
});
test("actual PG: same claim duplicate no new writes, changed original snapshot rejected",async()=>{
  const f=made("duplicate");await seed(f);const r=repo(f);assert.equal((await r.createClaim(f.input)).storageStatus,"recorded");assert.equal((await r.createClaim(f.input)).storageStatus,"recorded");
  const original=(await ledger(f)).claim_data;const g=structuredClone(f);g.context.claimOperationId="different-claim";assert.equal((await repo(g).createClaim(g.input)).storageStatus,"busy");assert.deepEqual((await ledger(f)).claim_data,original);
  const h=made("snapshot-changed");await seed(h);const changed=structuredClone(h.input.task);changed.extra="changed-while-queued";await saveData("phone_cloud_windows_tasks","task_id",changed.taskId,changed);
  assert.equal((await repo(h).createClaim(h.input)).storageStatus,"conflict");assert.equal((await anchor(h)).active_obligation_id,null);note("duplicate",{originalClaimPreserved:true,queuedSnapshotChangedRejected:true});
});
test("actual PG: legacy NULL and unique claims cannot be promoted",async()=>{
  const f=made("legacy");await seed(f);const s=createWecomV2HostState(f.context.binding);await db.query("INSERT INTO phone_cloud_wecom_cleanup_v2(obligation_id,server_epoch,revision,protocol_state) VALUES($1,$2,0,$3::jsonb)",[s.binding.obligationId,s.binding.serverEpoch,JSON.stringify(s)]);
  assert.equal((await repo(f).createClaim(f.input)).storageStatus,"conflict");assert.equal((await ledger(f)).claim_data,null);
  const g=made("unique-original");await seed(g);await repo(g).createClaim(g.input);const v=await ledger(g),dup=structuredClone(v.claim_data);dup.binding.obligationId="other-obligation";
  for(const kind of ["task","operation"]){const c=structuredClone(dup);c.binding.obligationId=`other-${kind}`;if(kind==="task")c.claimOperationId="different-operation";else c.binding.originalTaskId="different-task";
    const otherState=createWecomV2HostState(c.binding);await assert.rejects(db.query("INSERT INTO phone_cloud_wecom_cleanup_v2(obligation_id,server_epoch,revision,protocol_state,claim_data) VALUES($1,$2,0,$3::jsonb,$4::jsonb)",[c.binding.obligationId,c.binding.serverEpoch,JSON.stringify(otherState),JSON.stringify(c)]),e=>e.code==="23505"&&e.constraint===(kind==="task"?"wecom_v2_one_claim_per_task":"wecom_v2_claim_operation_once"));}
  const hf=hostFixture("legacy-compatible"),old=createWecomV2PostgresRepository({getPool:async()=>db,...hf.providers});await old.createPending(hf.binding);assert.equal((await old.commitHostOperation("host",hf.body)).protocolPermit,false);note("legacy-and-uniques",{legacyNullUnchanged:true,M2NarrowCompatibility:true,old14NotRepeated:true});
});
test("actual PG: each write failure/RETURNING corruption rolls full tuple back",async()=>{
  const statuses=[];
  for(let i=1;i<=5;i++){const f=made(`write-${i}`);await seed(f);let count=0;
    const pool=adapter(db,async(c,sql,args)=>{const answer=await c.query(sql,args);if(isDml(sql)&&++count===i)return {...answer,rowCount:0,rows:[]};return answer;});
    const r=await repo(f,pool).createClaim(f.input);assert.equal(r.storageStatus,"conflict");assert.equal((await storedTask(f)).status,"queued");assert.equal((await anchor(f)).active_obligation_id,null);assert.equal(await ledger(f),undefined);statuses.push(r.storageStatus);}
  const points=[["phone_cloud_windows_tasks","task_id"],["phone_cloud_automation_jobs","job_id"],["phone_cloud_device_locks","lock_id"],["phone_cloud_wecom_cleanup_v2","obligation_id"],["phone_cloud_wecom_v2_physical_anchors","physical_key"]];
  for(let i=0;i<5;i++){
    const f=made(`sql-write-${i+1}`);await seed(f);const [table,key]=points[i];
    const id=[f.context.binding.originalTaskId,f.context.originalJobId,f.context.binding.obligationId,f.context.binding.obligationId,f.context.binding.serial][i];
    // All identifiers/trigger args are source-defined synthetic fixture values.
    await db.query(`CREATE TRIGGER claim_fixture_reject BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION claim_fixture_reject_row('${key}','${id}')`);
    try{assert.equal((await repo(f).createClaim(f.input)).storageStatus,"unavailable");assert.equal((await storedTask(f)).status,"queued");assert.equal((await anchor(f)).active_obligation_id,null);assert.equal(await ledger(f),undefined);}
    finally{await db.query(`DROP TRIGGER claim_fixture_reject ON ${table}`);}
  }
  note("write-rollback",{allFiveReturnValuesEnforced:statuses,allFiveRealSqlRejectionsRolledBack:true});
});
async function fault(mode,mutate=false){
  const name=mutate?"client-context":mode==="after_commit"?"commit-after":"commit-before",f=made(name);await seed(f);
  const proxy=await startCommitReplyProxy({backendPort:config.port,mode,onBackendCompletion:()=>{if(mutate)f.context.claimOperationId="obsolete-context";}});
  const pool=new config.Pool({...config.options,port:proxy.port,max:1});const pids=[];const observer=createFaultClientObserver({mode,readWire:()=>proxy.snapshot()});
  pool.on("connect",c=>{pids.push(c.processID);observer.attach(c);});pool.on("error",observer.poolError);
  try {const answer=await repo(f,pool).createClaim(f.input),wire=proxy.snapshot(),errors=observer.snapshot();noPermit(answer);
    assert.ok(errors.length>=1&&errors.every(e=>e.expected));const writes=wire.events.filter(e=>e.event==="query"&&["INSERT","UPDATE"].includes(e.command));assert.equal(writes.length,5);
    if(mode==="after_commit"){const proof=wire.events.find(e=>e.event==="backend_commit_completion");assert.ok(proof?.commitConfirmedFromBackend);assert.equal(proof.commandTag,"COMMIT");assert.equal(proof.readyForQuery,"I");assert.equal(proof.errorResponseCount,0);
      assert.equal((await storedTask(f)).status,"running");assert.ok(await ledger(f));assert.equal(answer.storageStatus,mutate?"unknown":"recorded");assert.equal(new Set(pids).size,mutate?1:2);
    }else{assert.equal(answer.storageStatus,"unknown");assert.equal(answer.commitKnown,false);assert.equal((await storedTask(f)).status,"queued");assert.equal(await ledger(f),undefined);assert.ok(wire.events.some(e=>e.event==="dropped_before_commit"));}
    note(name,{wire,backendPids:pids,driverErrors:errors,storageStatus:answer.storageStatus,writeCount:writes.length});
  }finally{await pool.end();await proxy.close();}
}
test("actual PG: commit confirmed backend response dropped",()=>fault("after_commit"));
test("actual PG: cut before COMMIT no replay even if all absent",()=>fault("before_commit"));
test("actual PG: known claim legitimate progress/lock release/M1 revisions",async()=>{
  const f=made("progress");await seed(f);const r=repo(f);await r.createClaim(f.input);
  const task=(await storedTask(f)).data,j=(await row("phone_cloud_automation_jobs","job_id",f.context.originalJobId)).data;
  for(const [ts,js] of [["stalled","stalled"],["succeeded","failed"],["running","cancelled"]]){task.status=ts;j.status=js;task.result={stage:"later"};j.result={stage:"later"};await saveData("phone_cloud_windows_tasks","task_id",task.taskId,task);await saveData("phone_cloud_automation_jobs","job_id",j.jobId,j);assert.equal((await r.reconcileClaim()).storageStatus,"recorded");}
  const lock=(await lockedOriginal(f)).data;lock.status="released";await db.query("UPDATE phone_cloud_device_locks SET status='released',data=$2::jsonb WHERE lock_id=$1",[lock.lockId,JSON.stringify(lock)]);
  const hf=hostFixture("claim-progress"),b=f.context.binding;hf.body.binding=b;hf.body.readyNonce=b.handshakeNonce;hf.facts.agentInstanceId=b.agentInstanceId;hf.facts.spawnNonce=b.handshakeNonce;
  const prepare=createWecomV2HostPreparer({readAuthenticatedBinding:()=>b,readParentInstanceFacts:()=>hf.facts});let s=(await ledger(f)).protocol_state;
  for(const action of ["host","host-closed"]){const body=action==="host"?hf.body:{...hf.body,operationId:"claim-close-progress",expectedRevision:1,closeEventId:"claim-close-event"};if(action==="host-closed")hf.facts.closeEventId=body.closeEventId;
    s=prepare(s,action,body).nextState;await db.query("UPDATE phone_cloud_wecom_cleanup_v2 SET revision=$2,host_operation_id=$3,close_operation_id=$4,protocol_state=$5::jsonb WHERE obligation_id=$1",[b.obligationId,s.revision,s.hostOperationId,s.closeOperationId,JSON.stringify(s)]);assert.equal((await r.reconcileClaim()).storageStatus,"recorded");}
  note("progress",{legitimateDivergentStatus:true,releasedBusinessLock:true,ledgerRevision:s.revision});
});
test("actual PG: old projection regressions never reopen canonical duty",async()=>{
  for(const kind of ["queued","claim","phone","remark"]){const f=made(`regress-${kind}`);await seed(f);const r=repo(f);await r.createClaim(f.input);const t=(await storedTask(f)).data;
    if(kind==="queued")t.status="queued";if(kind==="claim")delete t.wecomV2Claim;if(kind==="phone")t.payload.phoneNumber="13900000001";if(kind==="remark")t.payload.remarkName="changed";
    await saveData("phone_cloud_windows_tasks","task_id",t.taskId,t);assert.equal((await r.reconcileClaim()).storageStatus,"conflict");assert.notEqual((await anchor(f)).active_obligation_id,null);}
  note("regression",{fourRegressionsRefused:true});
});
test("actual PG: legacy task/job lock orders reject promptly, other device works",async()=>{
  const seen=[];for(const table of ["phone_cloud_windows_tasks","phone_cloud_automation_jobs"]){const f=made(table.endsWith("jobs")?"job-first":"task-first"),g=made(`${f.context.originalJobId}-other`);await seed(f);await seed(g);const c=await db.connect();
    try{await c.query("BEGIN");const key=table.endsWith("jobs")?"job_id":"task_id",id=key==="job_id"?f.context.originalJobId:f.context.binding.originalTaskId;await c.query(`SELECT ${key} FROM ${table} WHERE ${key}=$1 FOR UPDATE`,[id]);
      await c.query("SET LOCAL statement_timeout='2000ms'");let oldTaskCompletion=null,lockProof=null;
      const pool=adapter(db,async(client,sql,args)=>{
        if(table.endsWith("jobs")&&sql.includes("FROM phone_cloud_automation_jobs")){
          // Legacy job→task is now waiting on the task already locked by the
          // new task→job path. Its NOWAIT job read must break that cycle.
          lockProof=await observedOldTaskWait(c.processID,client.processID,()=>{
            oldTaskCompletion=c.query("SELECT task_id FROM phone_cloud_windows_tasks WHERE task_id=$1 FOR UPDATE",[f.context.binding.originalTaskId])
              .then(result=>({result}),error=>({error}));
          });
        }return client.query(sql,args);
      });
      const start=performance.now();assert.equal((await repo(f,pool).createClaim(f.input)).storageStatus,"unavailable");const elapsed=performance.now()-start;assert.ok(elapsed<1500);
      if(table.endsWith("jobs")){assert.ok(oldTaskCompletion,"old task wait must have started");assert.ok(lockProof,"server-side Lock wait and exact blocker must be observed");const done=await oldTaskCompletion;if(done.error)throw done.error;assert.equal(done.result.rowCount,1);}
      else assert.equal((await c.query("SELECT job_id FROM phone_cloud_automation_jobs WHERE job_id=$1 FOR UPDATE",[f.context.originalJobId])).rowCount,1);
      assert.equal((await repo(g).createClaim(g.input)).storageStatus,"recorded");seen.push({table,elapsed,legacySecondLockAcquired:true,lockProof});
    }finally{await c.query("ROLLBACK");c.release();}}
  note("old-lock-orders",{seen,syntheticLegacyOrderPrefixesOnly:true,fullCheckpointWriterNotExecuted:true});
});
test("actual PG: reconcile same six locks, all absent no write",async()=>{
  const f=made("read-only");await seed(f);const queries=[],pool=adapter(db,(c,sql,args)=>{queries.push(sql);return c.query(sql,args);});const r=repo(f,pool);
  assert.equal((await r.reconcileClaim()).storageStatus,"not_recorded");assert.equal(queries.filter(isDml).length,0);assert.equal(queries.filter(s=>s.startsWith("SELECT")).length,6);assert.equal(queries.at(-1),"ROLLBACK");
  for(const [table,key,id] of [["phone_cloud_windows_tasks","task_id",f.context.binding.originalTaskId],["phone_cloud_automation_jobs","job_id",f.context.originalJobId],["phone_cloud_device_locks","lock_id",f.context.originalLockId]])await db.query(`DELETE FROM ${table} WHERE ${key}=$1`,[id]);
  assert.equal((await r.reconcileClaim()).storageStatus,"not_recorded");assert.equal(queries.filter(isDml).length,0);
  const missing=[];
  for(const kind of ["anchor","task","job","hold","business","ledger"]){const g=made(`reconcile-missing-${kind}`);await seed(g);const gr=repo(g);await gr.createClaim(g.input);
    const [table,key,id]=kind==="anchor"?["phone_cloud_wecom_v2_physical_anchors","physical_key",g.context.binding.serial]:kind==="task"?["phone_cloud_windows_tasks","task_id",g.context.binding.originalTaskId]:kind==="job"?["phone_cloud_automation_jobs","job_id",g.context.originalJobId]:kind==="ledger"?["phone_cloud_wecom_cleanup_v2","obligation_id",g.context.binding.obligationId]:["phone_cloud_device_locks","lock_id",kind==="hold"?g.context.binding.obligationId:g.context.originalLockId];
    if(kind==="ledger"){await assert.rejects(db.query(`DELETE FROM ${table} WHERE ${key}=$1`,[id]),e=>e.code==="23503");assert.equal((await gr.reconcileClaim()).storageStatus,"recorded");missing.push({kind,fkPreventedDelete:true});}
    else{await db.query(`DELETE FROM ${table} WHERE ${key}=$1`,[id]);assert.equal((await gr.reconcileClaim()).storageStatus,"conflict");missing.push({kind,refused:true});}
  }
  note("read-only-reconcile",{allAbsentNoRewrite:true,missing});
});
test("actual PG: complete claim SQL type/field/date/constraint negatives",async()=>{
  const f=made("ddl");await seed(f);await repo(f).createClaim(f.input);const original=(await ledger(f)).claim_data;
  const bad=[];for(const key of Object.keys(original)){const c=structuredClone(original);delete c[key];bad.push(c);}for(const key of Object.keys(original)){const c=structuredClone(original);c[key]=null;bad.push(c);}
  bad.push({...original,extra:"forbidden"},{...original,version:"1"},{...original,recordedAt:"2026-02-30T00:00:00.000Z"},{...original,recordedAt:"2026-11-02T00:00:00Z"},
    {...original,mode:"other"},{...original,requestId:"short"},{...original,claimOperationId:"bad id"},{...original,businessFingerprint:"A".repeat(64)});
  for(const key of Object.keys(original.binding)){const c=structuredClone(original);delete c.binding[key];bad.push(c);}
  for(const c of bad)await assert.rejects(db.query("UPDATE phone_cloud_wecom_cleanup_v2 SET claim_data=$2::jsonb WHERE obligation_id=$1",[f.context.binding.obligationId,JSON.stringify(c)]),e=>e.code==="23514");
  let jointBindingNegatives=0;
  for(const key of Object.keys(original.binding).filter(k=>!["obligationId","serverEpoch"].includes(k))){
    const c=structuredClone(original),s=structuredClone((await ledger(f)).protocol_state);c.binding[key]=null;s.binding=structuredClone(c.binding);
    await assert.rejects(db.query("UPDATE phone_cloud_wecom_cleanup_v2 SET claim_data=$2::jsonb,protocol_state=$3::jsonb WHERE obligation_id=$1",[f.context.binding.obligationId,JSON.stringify(c),JSON.stringify(s)]),e=>e.code==="23514"&&e.constraint==="wecom_v2_claim_shape");jointBindingNegatives++;
  }
  assert.deepEqual((await ledger(f)).claim_data,original);note("ddl-negatives",{rejectedClaimMutations:bad.length,jointBindingNegatives});
});
test("actual PG: COMMIT unknown plus changed context no extra checkout",()=>fault("after_commit",true));
