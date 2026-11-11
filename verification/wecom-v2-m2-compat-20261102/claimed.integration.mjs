// Unexecuted private-cluster SECOND phase only. M2 fourteen tests initialize
// its exact original schema plus new claim DDL before this entry is invoked.
import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {ownedConfiguration,verifyOwnedServer} from "./owned-pg.mjs";
import {fixture as claimFixture} from "../wecom-v2-claim-bundle-20261102/fixture.mjs";
import {fixture as hostFixture} from "./fixture.mjs";
import {createWecomV2ClaimPostgresRepository} from "../../server/wecom-cleanup-v2-claim-postgres.mjs";
import {createWecomV2PostgresRepository} from "../../server/wecom-cleanup-v2-postgres.mjs";
const config=await ownedConfiguration(),db=new config.Pool(config.options),evidence={kind:"claimed-row-M2-storage-compat-only",server:null,cases:[]};
before(async()=>{
  evidence.server=await verifyOwnedServer(db,config);
  // No IF NOT EXISTS / schema reset: any unexpected first-phase state fails.
  await db.query(`CREATE TABLE phone_cloud_devices(device_id text PRIMARY KEY,data jsonb NOT NULL,updated_at timestamptz);
    CREATE TABLE phone_cloud_windows_tasks(task_id text PRIMARY KEY,agent_id text,adb_serial text,status text,created_at timestamptz,updated_at timestamptz,data jsonb NOT NULL);
    CREATE TABLE phone_cloud_automation_jobs(job_id text PRIMARY KEY,device_id text,user_id text,kind text,status text,created_at timestamptz,updated_at timestamptz,data jsonb NOT NULL);
    CREATE TABLE phone_cloud_device_locks(lock_id text PRIMARY KEY,device_id text,status text,expires_at timestamptz,data jsonb NOT NULL);`);
});
after(async()=>{await db.end();await fs.writeFile(path.join(config.root,"CLAIMED_EVIDENCE.json"),JSON.stringify(evidence,null,2)+"\n",{flag:"wx",mode:0o600});});
for(const slot of["main","clone"])test(`actual PG compatibility: claimed ${slot} through unchanged M2 host/close`,async()=>{
  const f=claimFixture({suffix:`compat-${slot}`,serial:`fixture-compat-${slot}`,slot,mode:slot==="main"?"preview":"send"}),b=f.context.binding;
  const {task:t,job:j,businessLock:l,device:d}=f.input;
  await db.query("INSERT INTO phone_cloud_devices VALUES($1,$2::jsonb,NULL)",[d.deviceId,JSON.stringify(d)]);
  await db.query("INSERT INTO phone_cloud_windows_tasks VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",[t.taskId,t.agentId,t.adbSerial,t.status,t.createdAt,t.updatedAt,JSON.stringify(t)]);
  await db.query("INSERT INTO phone_cloud_automation_jobs VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",[j.jobId,j.deviceId,j.userId,j.kind,j.status,j.createdAt,j.updatedAt,JSON.stringify(j)]);
  await db.query("INSERT INTO phone_cloud_device_locks VALUES($1,$2,$3,$4,$5::jsonb)",[l.lockId,l.deviceId,l.status,l.expiresAt,JSON.stringify(l)]);
  const fingerprint=createHash("sha256").update(JSON.stringify([b.deviceId,b.serial,b.agentId,d.deviceName])).digest("hex");
  await db.query("INSERT INTO phone_cloud_wecom_v2_physical_anchors(physical_key,device_id,agent_id,mapping_revision,mapping_fingerprint,mapping_state) VALUES($1,$2,$3,1,$4,'ready')",[b.serial.toLowerCase(),b.deviceId,b.agentId,fingerprint]);
  const actualDevice=(await db.query("SELECT data FROM phone_cloud_devices WHERE device_id=$1",[b.deviceId])).rows[0].data;
  const m3=createWecomV2ClaimPostgresRepository({getPool:async()=>db,readClaimContext:()=>f.context,readDeviceMapping:()=>({device:actualDevice,mappingRevision:1})});
  const claim=await m3.createClaim(f.input);assert.equal(claim.storageStatus,"recorded");assert.equal(claim.protocolPermit,false);
  const original=(await db.query("SELECT claim_data FROM phone_cloud_wecom_cleanup_v2 WHERE obligation_id=$1",[b.obligationId])).rows[0].claim_data;
  const hf=hostFixture(`compat-host-${slot}`);hf.body.binding=b;hf.body.readyNonce=b.handshakeNonce;hf.facts.agentInstanceId=b.agentInstanceId;hf.facts.spawnNonce=b.handshakeNonce;
  const m2=createWecomV2PostgresRepository({getPool:async()=>db,readAuthenticatedBinding:()=>b,readParentInstanceFacts:()=>hf.facts});
  const host=await m2.commitHostOperation("host",hf.body);assert.equal(host.commitKnown,true);assert.equal(host.protocolPermit,false);assert.equal(host.revision,1);
  assert.equal((await m3.reconcileClaim()).storageStatus,"recorded");
  const close={...hf.body,operationId:`compat-close-${slot}`,expectedRevision:1,closeEventId:`compat-close-event-${slot}`};hf.facts.closeEventId=close.closeEventId;
  const closed=await m2.commitHostOperation("host-closed",close);assert.equal(closed.commitKnown,true);assert.equal(closed.protocolPermit,false);assert.equal(closed.revision,2);
  assert.equal((await m3.reconcileClaim()).storageStatus,"recorded");
  const row=(await db.query("SELECT claim_data,revision FROM phone_cloud_wecom_cleanup_v2 WHERE obligation_id=$1",[b.obligationId])).rows[0];assert.deepEqual(row.claim_data,original);assert.equal(row.revision,2);
  evidence.cases.push({name:`claimed-${slot}`,dataMode:f.context.mode,hostRevision:1,closedRevision:2,originalClaimDataPreserved:true,m3ReconciledAfterBoth:true,protocolPermit:false,syntheticHostFactsNotOsAttestation:true});
});
