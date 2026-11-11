// Dedicated WeCom protocol helpers. No Agent entry, ADB, screen or OS lifecycle.
import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
export const WECOM_CAUSAL_PROTOCOL='wecom-causal-v1';
const fields=['version','obligationId','originalTaskId','executionId','deviceId','serial','agentId','appSlot','androidUser','nonce'];
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const fail=code=>{throw new Error(code);};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
function creationValue(token){
  const m=typeof token==='string'&&/^0x1\.([0-9a-f]{13})p([+-]\d{1,4})$/.exec(token);
  if(!m)return null;
  const value=(1+Number.parseInt(m[1],16)/2**52)*2**Number(m[2]);
  return Number.isFinite(value)&&value>0?value:null;
}
export const WECOM_READY_PREFIX='WECOM_PHYSICAL_READY ';

export function physicalBinding(task,config,{verification=false}={}){
  const value=task.payload?.physicalCleanup;
  if(value===undefined&&!verification)return null;
  if(!exact(value,fields)||value.version!==1||!['obligationId','originalTaskId','executionId','agentId','nonce'].every(k=>id(value[k]))
    ||typeof value.serial!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(value.serial)
    ||typeof value.deviceId!=='string'||!value.deviceId.startsWith('adb:')||value.deviceId.slice(4).toLowerCase()!==value.serial.toLowerCase()
    ||!['main','clone'].includes(value.appSlot)||![0,999].includes(value.androidUser)
    ||value.agentId!==config.agentId||task.agentId!==config.agentId||task.deviceId!==value.deviceId||task.adbSerial!==value.serial
    ||(!verification&&(value.originalTaskId!==task.taskId||value.appSlot!==task.payload.appSlot||value.androidUser!==task.payload.androidUser)))fail('wecom_cleanup_binding_mismatch');
  return Object.freeze({...value});
}

export function physicalHosts(value){
  if(!Array.isArray(value)||value.length<1||value.length>8)fail('wecom_cleanup_host_invalid');
  const result=value.map(h=>{
    if(!exact(h,['role','pid','createdAt','creationToken','machineId'])||typeof h.role!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(h.role)||h.role==='agent'
      ||!Number.isSafeInteger(h.pid)||h.pid<=0||h.pid>0xffffffff||typeof h.createdAt!=='string'||!Number.isFinite(Date.parse(h.createdAt))
      ||new Date(h.createdAt).toISOString()!==h.createdAt||typeof h.creationToken!=='string'||!/^0x1\.[0-9a-f]{13}p[+-]\d{1,4}$/.test(h.creationToken)
      ||typeof h.machineId!=='string'||!/^[a-f0-9]{64}$/.test(h.machineId))fail('wecom_cleanup_host_invalid');
    const created=creationValue(h.creationToken);
    if(created===null||Math.abs(created*1000-Date.parse(h.createdAt))>1.001)fail('wecom_cleanup_host_invalid');
    return Object.freeze({...h});
  });
  if(!result.some(h=>h.role==='reader')||new Set(result.map(h=>h.role)).size!==result.length||new Set(result.map(h=>h.pid)).size!==result.length
    ||new Set(result.map(h=>h.machineId)).size!==1)fail('wecom_cleanup_host_invalid');
  return Object.freeze(result);
}

export function cleanupRoute(binding,action){
  if(!['host','host-closed','verify','lease','challenge','proof','recovery-lease','recovery-challenge','recovery-proof'].includes(action))fail('wecom_cleanup_route_invalid');
  return `/api/v1/windows-agents/${encodeURIComponent(binding.agentId)}/wecom-cleanup/${encodeURIComponent(binding.obligationId)}/${action}`;
}

export function createCleanupRequest(config){
  const base=new URL(config.serverBaseUrl);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password)fail('wecom_cleanup_origin_invalid');
  return async(route,{method='POST',body,timeoutMs=5000}={})=>{
    if(!/^\/api\/v1\/windows-agents\/[^/]+\/wecom-cleanup\/[^/]+\/(host|host-closed|verify|lease|challenge|proof|recovery-lease|recovery-challenge|recovery-proof)(?:\?.*)?$/.test(route))fail('wecom_cleanup_route_invalid');
    let response,value;
    try{
      if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw Error('expired');
      response=await fetch(new URL(route,base),{method,headers:{Authorization:'Bearer '+config.agentToken,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.floor(Math.min(5000,timeoutMs)))),...(body===undefined?{}:{body:JSON.stringify(body)})});
      let raw='',length=0;
      for await(const chunk of response.body){length+=chunk.byteLength;if(length>16384)throw Error('bounded');raw+=Buffer.from(chunk).toString('utf8');}
      value=JSON.parse(raw);
    }catch{throw Object.assign(new Error('wecom_cleanup_response_unknown'),{deliveryUnknown:true});}
    if(!response.ok){
      const code=/^wecom_cleanup_[a-z0-9_]{1,70}$/.test(value?.error||'')?value.error:'wecom_cleanup_request_failed';
      throw Object.assign(new Error(code),{httpStatus:response.status,deliveryUnknown:response.status>=500});
    }
    return value;
  };
}

async function sameAcknowledgement(route,body,request,remaining){
  const original=JSON.stringify(body);
  for(let attempt=0;attempt<2;attempt++){
    const timeoutMs=Math.min(5000,remaining());
    if(timeoutMs<=0)throw new Error('wecom_cleanup_ack_budget_exhausted');
    try{
      const result=await request(route,{body:JSON.parse(original),timeoutMs});
      if(result?.ok!==true)throw Object.assign(new Error('wecom_cleanup_ack_unknown'),{deliveryUnknown:true});
      return result;
    }catch(error){if(error.deliveryUnknown!==true||attempt===1)throw error;}
  }
}

export function createPhysicalLifecycle(task,{config,request=createCleanupRequest(config),wall=()=>new Date().toISOString(),remainingMs=()=>Infinity}={}){
  const binding=physicalBinding(task,config);
  if(!binding)return null;
  const ticket=task.payload.wecomCausalLease;
  if(!exact(ticket,['protocol','epoch','leaseId','purpose'])||ticket.protocol!==WECOM_CAUSAL_PROTOCOL||ticket.purpose!=='business'||!id(ticket.epoch)||!id(ticket.leaseId))fail('wecom_cleanup_causal_context_unconfirmed');
  const bootstrap=Object.freeze({protocol:WECOM_CAUSAL_PROTOCOL,bindingNonce:binding.nonce,pipeNonce:randomBytes(24).toString('hex')});
  let hosts=null,registration=null,closed=false;
  return{
    binding,bootstrap,bootstrapInput:Object.freeze({version:1,binding,bootstrap}),
    async ready(frame,actualPid){
      if(hosts||!exact(frame,['version','hosts','bootstrap'])||frame.version!==1||!isDeepStrictEqual(frame.bootstrap,bootstrap))fail('wecom_cleanup_host_invalid');
      const observed=physicalHosts(frame.hosts);
      // The current product creates exactly one task child. Do not invent a
      // supervisor or include the long-lived shared Agent in the exit set.
      if(observed.length!==1||observed[0].role!=='reader'||observed[0].pid!==actualPid)fail('wecom_cleanup_host_invalid');
      hosts=observed;
      registration=sameAcknowledgement(cleanupRoute(binding,'host'),{binding,hosts,bootstrap},request,()=>remainingMs('host'));
      const result=await registration;
      if(result?.ok!==true)fail('wecom_cleanup_host_registration_unconfirmed');
    },
    async closed(){
      if(closed)return;closed=true;
      if(!hosts)return;
      // If the ACK was lost the exact registered IDs can still be closed;
      // unknown storage never permits config release or invented host IDs.
      if(registration)await registration.catch(()=>{});
      const body={binding,hosts,bootstrap,observedAt:wall(),exited:true,observerMachineId:hosts[0].machineId};
      const result=await sameAcknowledgement(cleanupRoute(binding,'host-closed'),body,request,()=>remainingMs('host-closed'));
      if(result?.ok!==true)fail('wecom_cleanup_host_close_unconfirmed');
    }
  };
}

export async function submitSamePhysicalProof(binding,body,{request,action='proof'}={}){
  if(!['proof','recovery-proof'].includes(action))fail('wecom_cleanup_route_invalid');
  const original=JSON.stringify(body);
  let unknown=false;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const result=await request(cleanupRoute(binding,action),{body:JSON.parse(original)});
      if(result?.ok!==true||result.verified!==true)throw Object.assign(new Error('wecom_cleanup_proof_ack_unknown'),{deliveryUnknown:true});
      return result;
    }catch(error){
      unknown ||= error.deliveryUnknown===true;
      if(unknown&&attempt===0)continue;
      if(unknown)throw Object.assign(new Error('wecom_cleanup_proof_ack_unknown'),{proofDeliveryUnknown:true});
      throw error;
    }
  }
}
