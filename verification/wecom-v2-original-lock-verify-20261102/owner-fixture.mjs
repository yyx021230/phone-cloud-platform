// VERIFICATION LOCAL ONLY. Not a production authorizer, handler or executor.
// Its S1 classification never grants writes; raw fixture SQL is restricted by
// the separately reviewed owned private-cluster test entry.
import {isDeepStrictEqual as equal} from "node:util";
import {createWecomV2ProjectionPolicy} from "../../server/wecom-v2-projection-policy.mjs";
import {createWecomV2ClaimPreparer} from "../../server/wecom-cleanup-v2-claim.mjs";
import {comparisonQueries as q} from "../wecom-v2-writer-epq-plan-20261102/comparison-queries.mjs";
import {projectionSql as p} from "../wecom-v2-projection-sql-plan-20261102/verification-queries.mjs";
const ownErrors=new WeakSet();
const fail=code=>{const error=Error(`fixture_business_${code}`);ownErrors.add(error);throw error;};
export const isFixtureCasConflict=error=>ownErrors.has(error)&&error.message==="fixture_business_cas_conflict";
const time=v=>typeof v==="string"&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const mutable=new Set(["status","updatedAt","releasedAt","releaseReason"]);
const keep=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!mutable.has(k)));
const copy=v=>JSON.parse(JSON.stringify(v));
export function validateFixtureCandidate(canonical,context,candidate){
  try{
    createWecomV2ClaimPreparer({readClaimContext:()=>context}); // strict context only, no I/O
    const b=context.binding,target={deviceId:b.deviceId,serial:b.serial,agentId:b.agentId};
    const observation={version:1,kind:"present",observationId:"fixture-business-observation",serverEpoch:b.serverEpoch,target,canonical,legacyPending:[]};
    const policy=createWecomV2ProjectionPolicy({readPolicyEpoch:()=>b.serverEpoch,readCanonicalProjection:()=>observation});
    const answer=policy({targets:[{target,writes:[{kind:"businessLock",record:candidate}]}]}).results[0];
    if(answer?.decision!=="retain_canonical"||answer.writePermit!==false||answer.protocolPermit!==false||answer.canonicalSourceVerified!==false)fail("candidate_rejected");
    // Policy validated strict JSON with no accessors before these copies.
    const c=copy(canonical),next=copy(candidate),ctx=copy(context),original=c.businessLock.data;
    const claim={version:1,...Object.fromEntries(["claimOperationId","originalJobId","originalLockId","ownerUserId","requestId","mode","businessFingerprint","recordedAt","binding"].map(k=>[k,ctx[k]]))};
    if(!equal(c.ledger.claim_data,claim)||c.device.deviceName!==ctx.target.deviceNumber||c.ledger.claim_data.mode!==ctx.mode)fail("candidate_rejected");
    // ALL nonmutable JSON fields, including unknown extensions, must survive.
    if(!equal(keep(original),keep(next))||original.status!=="active"||next.status!=="released"
      ||!time(next.updatedAt)||next.releasedAt!==next.updatedAt||typeof next.releaseReason!=="string"
      ||!next.releaseReason||next.releaseReason!==next.releaseReason.trim()||next.releaseReason.length>120
      ||/[\u0000-\u001f\u007f]/.test(next.releaseReason))fail("candidate_rejected");
    return Object.freeze({fixtureValidation:"candidate_matches_given_snapshot",writePermit:false,protocolPermit:false,canonicalSourceVerified:false});
  }catch{fail("candidate_rejected");}
}
function normalize(row,dateColumns){
  const out={...row};for(const key of dateColumns){const v=out[key];
    if(v===null)continue;if(v instanceof Date&&Number.isFinite(v.getTime()))out[key]=v.toISOString();else if(!time(v))fail("row_invalid");
  }return out;
}
function one(result){if(result?.rowCount!==1||!Array.isArray(result.rows)||result.rows.length!==1)fail("tuple_incomplete");return result.rows[0];}
export async function loadFixtureTuple(client,context){
  const b=context.binding;
  const anchor=one(await client.query(q.anchor,[b.serial.toLowerCase()]));
  const windowsTask=normalize(one(await client.query(q.readTask,[b.originalTaskId])),["created_at","updated_at"]);
  const automationJob=normalize(one(await client.query(q.readJob,[context.originalJobId])),["created_at","updated_at"]);
  const physicalHold=normalize(one(await client.query(q.readHold,[b.obligationId])),["expires_at"]);
  const businessLock=normalize(one(await client.query(q.readHold,[context.originalLockId])),["expires_at"]);
  const ledger=one(await client.query(q.activeLedger,[b.obligationId]));
  const device=one(await client.query("SELECT data FROM phone_cloud_devices WHERE device_id=$1",[b.deviceId])).data;
  if(typeof anchor.mapping_revision!=="string"||!/^[1-9][0-9]*$/.test(anchor.mapping_revision))fail("row_invalid");
  return {anchor,windowsTask,automationJob,physicalHold,businessLock,ledger,device};
}
export function releaseCandidate(canonical){return {...copy(canonical.businessLock.data),status:"released",updatedAt:"2099-01-01T00:00:00.000Z",releasedAt:"2099-01-01T00:00:00.000Z",releaseReason:"fixture_owner_complete"};}
export async function applyFixtureCandidate(client,canonical,context,candidate){
  validateFixtureCandidate(canonical,context,candidate); // any rejection BEFORE DML
  const result=await client.query(p.ownerBusinessStatusCas,[context.originalLockId,candidate.status,candidate.expiresAt,JSON.stringify(candidate),context.binding.deviceId,JSON.stringify(canonical.businessLock.data)]);
  if(result?.rowCount===0&&Array.isArray(result.rows)&&result.rows.length===0)fail("cas_conflict");
  const row=normalize(one(result),["expires_at"]);
  if(Object.keys(row).sort().join(",")!==["lock_id","device_id","status","expires_at","data"].sort().join(",")
    ||row.lock_id!==context.originalLockId||row.device_id!==context.binding.deviceId||row.status!==candidate.status
    ||row.expires_at!==candidate.expiresAt||!equal(row.data,candidate))fail("returning_conflict");
  return {row,writePermit:false,protocolPermit:false,canonicalSourceVerified:false};
}
