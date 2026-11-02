// WeCom v1 only. Tickets survive storage; their monotonic authority never
// survives this service instance. Audit UTC is deliberately not an input.
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual as equal} from "node:util";
export const WECOM_CAUSAL_PROTOCOL="wecom-causal-v1";
const fail=()=>{throw new Error("wecom_cleanup_causal_context_unconfirmed");};
const exact=(v,keys)=>v&&typeof v==="object"&&!Array.isArray(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),"value"));
const text=v=>typeof v==="string"&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const copy=v=>structuredClone(v);
const freeze=v=>{if(v&&typeof v==="object"){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const bindingKeys=["version","obligationId","originalTaskId","executionId","deviceId","serial","agentId","appSlot","androidUser","nonce"];
function binding(v){
  if(!exact(v,bindingKeys)||v.version!==1||!["obligationId","originalTaskId","executionId","deviceId","serial","agentId","nonce"].every(k=>text(v[k]))
    ||v.deviceId!==`adb:${v.serial}`||!((v.appSlot==="main"&&v.androidUser===0)||(v.appSlot==="clone"&&v.androidUser===999)))fail();
}
function scope(v,purpose){
  if(purpose==="business"){
    const keys=["taskId","jobId","lockId","deviceId","serial","agentId","appSlot","androidUser","operationFingerprint"];
    if(!exact(v,keys)||!keys.slice(0,6).every(k=>text(v[k]))||v.deviceId!==`adb:${v.serial}`
      ||!((v.appSlot==="main"&&v.androidUser===0)||(v.appSlot==="clone"&&v.androidUser===999))||typeof v.operationFingerprint!=="string"||!/^[a-f0-9]{64}$/.test(v.operationFingerprint))fail();
  }else{
    if(!exact(v,["binding","verificationId","verificationNonce","verificationTaskId"])||!["verificationId","verificationNonce","verificationTaskId"].every(k=>text(v[k])))fail();binding(v.binding);
  }
  return copy(v);
}
export function createWecomCausalClock({mono=()=>process.hrtime.bigint(),id=randomUUID,epoch=randomUUID()}={}){
  if(typeof mono!=="function"||typeof id!=="function"||!text(epoch))fail();
  const marks=new WeakMap(),leases=new Map(),challenges=new Map();let last=null,poisoned=false;
  function now(){const n=mono();if(poisoned||typeof n!=="bigint"||n<0n||(last!==null&&n<last)){poisoned=true;fail();}last=n;return n;}
  function newId(){const value=id();if(!text(value)||leases.has(value)||[...challenges.values()].some(c=>c.ticket.challengeId===value))fail();return value;}
  function mark(){const value=Object.freeze({});marks.set(value,now());return value;}
  function start(stamp,value,purpose){
    const context=scope(value,purpose),at=marks.get(stamp),n=now();if(at===undefined||at>n)fail();marks.delete(stamp);
    const ticket=freeze({protocol:WECOM_CAUSAL_PROTOCOL,epoch,leaseId:newId(),purpose});
    const budget=purpose==="business"?300000n:120000n;
    leases.set(ticket.leaseId,{ticket,scope:context,deadline:at+budget*1000000n});return ticket;
  }
  function lease(ticket,value,purpose){
    if(!exact(ticket,["protocol","epoch","leaseId","purpose"])||ticket.protocol!==WECOM_CAUSAL_PROTOCOL||ticket.epoch!==epoch||ticket.purpose!==purpose)fail();
    const entry=leases.get(ticket.leaseId);if(!entry||!equal(ticket,entry.ticket)||!equal(scope(value,purpose),entry.scope))fail();return entry;
  }
  function remaining(ticket,value){const e=lease(ticket,value,ticket?.purpose),n=now();return Number(e.deadline>n?(e.deadline-n)/1000000n:0n);}
  function challenge(ticket,value){
    const e=lease(ticket,value,"verification"),n=now();
    let c=challenges.get(ticket.leaseId);
    if(!c){if(e.deadline-n<=3000000000n)fail();c={issued:n,ticket:freeze({protocol:WECOM_CAUSAL_PROTOCOL,epoch,verificationLeaseId:ticket.leaseId,challengeId:newId()})};challenges.set(ticket.leaseId,c);}
    // A repeated request returns exactly the same authority, never new age.
    return copy(c.ticket);
  }
  function validateChallenge(challengeTicket,ticket,value){
    const e=lease(ticket,value,"verification"),c=challenges.get(ticket.leaseId),n=now();
    if(!c||!equal(challengeTicket,c.ticket)||n>=e.deadline||n-c.issued>3000000000n)fail();return true;
  }
  return Object.freeze({epoch,mark,businessLease:(stamp,v)=>start(stamp,v,"business"),verificationLease:(stamp,v)=>start(stamp,v,"verification"),remaining,challenge,validateChallenge});
}
