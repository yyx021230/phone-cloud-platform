import {createHash,randomBytes} from 'node:crypto';
import {AUTH_FIELDS,ROUTES,MEMBER_ID_FIELDS,parseBody,authenticate,dispatchInput,memberKey,fingerprint,signature,stringifyBody,failure} from './protocol.mjs';
import {remarkName,recipientIdentity,physicalRecipientIdentity,memberIdentity,memberLimit,businessDay,businessDayEnd} from './domain.mjs';
import {bounded} from './platform.mjs';
const key=(app,id)=>JSON.stringify([app,id]);
const fixedCode=value=>typeof value==='string'&&/^[a-z0-9_]{1,100}$/.test(value)?value:'execution_outcome_unknown';
const activeStages=new Set(['queued','dispatching','reconcile','submitted','callback_pending','callback_inflight']);
const reasons={member_not_configured:'指定企微成员未配置手机与主号/分身映射',member_binding_unverified:'指定企微成员未启用或未完成账号绑定核验',member_rate_limited:'指定企微成员添加过频，暂停新任务',device_not_listed:'指定成员的设备未上架',adb_offline:'指定成员的手机连接离线',agent_offline:'指定成员的执行端离线',device_busy:'指定成员的设备正在被占用',device_number_conflict:'指定成员的手机编号映射未确认',wecom_not_configured:'指定成员的设备或应用未在已验证企微范围',remark_phone_protocol_not_ready:'指定成员的执行器尚未就绪（备注手机号校验协议）'};

function sameDispatch(prior,input,hash) {
  if(prior.fingerprint===hash)return true;
  if(!input.wecom_phone||input.wecom_phone!==prior.input.wecom_phone)return false;
  // Match the original fingerprint without rewriting historical records.
  const original={...input};
  for(const k of MEMBER_ID_FIELDS){
    const recorded=prior.input[k],expected=recorded??prior.target[k];
    if(input[k]!==undefined&&expected!==undefined&&input[k]!==expected)return false;
    if(recorded===undefined)delete original[k];
    else original[k]=recorded;
  }
  return prior.fingerprint===fingerprint(original);
}

export function createService({store,clients,platform,fetchImpl=fetch,clock=Date.now,nonce=()=>randomBytes(16).toString('hex'),maxCallbackAttempts=5}={}) {
  if(!Number.isInteger(maxCallbackAttempts)||maxCallbackAttempts<1||maxCallbackAttempts>10||!['preview','send'].includes(platform.mode))throw Error('cps_service_config_invalid');
  const ready=store.transact(s=>{if(s.executionMode!==null&&s.executionMode!==platform.mode)throw Error('cps_journal_mode_changed');s.executionMode=platform.mode;});
  ready.catch(()=>{}); // Report initialization failure through the bounded API.
  const inFlight=new Set();let stopping=false,pumping=false;
  const response=(success,code,message,result=null)=>({success,code,message,result,timestamp:clock()});
  const find=(s,app,id)=>s.leads.find(r=>r.appId===app&&r.leadId===id);
  const update=(lead,fn)=>store.transact(s=>{const r=find(s,lead.appId,lead.leadId);if(!r)throw Error('cps_lead_missing');return fn(r,s);});
  function recipient(r,s,state) {
    const record=s.recipients.find(x=>x.key===r.recipientKey);
    if(!record||record.appId!==r.appId||record.leadId!==r.leadId)throw Error('cps_recipient_binding_changed');
    record.state=state;record.updatedAt=clock();
  }
  function matchedDevice(inventory,target) {
    const rows=inventory.devices.filter(d=>d.deviceNumber===target.deviceNumber);
    return rows.length===1?rows[0]:null;
  }
  async function consume(client,body) {
    const digest=createHash('sha256').update(JSON.stringify([client.appId,body.nonce])).digest('hex');
    await store.transact(s=>{
      s.nonces=s.nonces.filter(n=>n.expiresAt>clock());
      if(s.nonces.some(n=>n.key===digest))throw failure(1003,'nonce重复',401);
      if(s.nonces.length>=10000)throw failure(500,'签名请求容量已满',503);
      s.nonces.push({key:digest,expiresAt:Math.max(clock(),body.timestamp)+300001});
    });
  }
  function targetReason(row,target,state) {
    if(target.enabled===false||target.bindingVerified!==true)return 'member_binding_unverified';
    if(memberLimit(state,target,clock()))return 'member_rate_limited';
    if(!row)return 'wecom_not_configured';
    if(row.listed!==true)return 'device_not_listed';
    if(row.adbOnline!==true)return 'adb_offline';
    if(row.agentOnline!==true)return 'agent_offline';
    if(row.busy===true)return 'device_busy';
    if(row.wecomAllowed!==true)return row.unavailableReason==='device_number_conflict'?'device_number_conflict':'wecom_not_configured';
    if(typeof row.deviceId!=='string'||!row.deviceId.startsWith('adb:'))return 'device_number_conflict';
    if(row.remarkPhoneReady!==true)return 'remark_phone_protocol_not_ready';
    if(!Array.isArray(row.appSlots)||!row.appSlots.some(a=>a.appSlot===target.appSlot))return 'wecom_not_configured';
    return row.available===true?'':'device_busy';
  }
  function rejectPriorRecipient(s,recipientKey,physicalKey,legacyKey,input,target) {
    const leads=new Map(s.leads.map(l=>[key(l.appId,l.leadId),l]));
    const legacyPhysical=r=>{
      const lead=leads.get(key(r.appId,r.leadId));
      return !r.physicalKey&&lead?.target?.deviceNumber===target.deviceNumber&&lead.target.appSlot===target.appSlot
        &&r.key===recipientIdentity({...lead.input,phone:input.phone});
    };
    if(s.recipients.some(r=>(r.key===recipientKey||r.key===legacyKey||r.physicalKey===physicalKey||legacyPhysical(r))&&r.state!=='not_sent'))throw failure(2003,'该企微成员与客户已有已处理或待确认任务，请核对原线索，不能重复添加');
  }
  async function dispatch(client,body) {
    const input=dispatchInput(body),id=input.lead_id,hash=fingerprint(input),snapshot=store.snapshot();
    const old=find(snapshot,client.appId,id);
    if(old){if(!sameDispatch(old,input,hash))throw failure(2003,'同一lead_id的业务参数发生变化');return response(true,200,'已接收');}
    if(client.phoneRouting&&!input.wecom_phone)throw failure(2003,'请传企微登录手机号wecom_phone，phone为客户手机号');
    remarkName(input); // Reject >20 before acknowledging or reserving a phone.
    const target=client.members.get(memberKey(input));
    if(!target)throw failure(2003,reasons.member_not_configured);
    if(input.wecom_phone&&MEMBER_ID_FIELDS.some(k=>input[k]!==undefined&&target[k]!==undefined&&target[k]!==input[k]))throw failure(2003,'企微登录手机号与配置的企业或成员ID不一致');
    const recipientKey=recipientIdentity(input),physicalKey=physicalRecipientIdentity(input,target);
    const legacyInput={phone:input.phone,wecom_userid:input.wecom_userid??target.wecom_userid,wecom_corp_id:input.wecom_corp_id??target.wecom_corp_id};
    const legacyKey=MEMBER_ID_FIELDS.every(k=>legacyInput[k]!==undefined)?recipientIdentity(legacyInput):undefined;
    rejectPriorRecipient(snapshot,recipientKey,physicalKey,legacyKey,input,target);
    const inventory=await platform.inventory(),row=matchedDevice(inventory,target);
    const unavailable=targetReason(row,target,store.snapshot());
    if(unavailable)throw failure(2003,reasons[unavailable]);
    if(inventory.capacity.remaining<=0)throw failure(2003,'平台企微执行容量已满，请稍后按原lead_id重试');
    const requestId='cps_'+createHash('sha256').update(key(client.appId,id)).digest('hex');
    await store.transact(s=>{
      const prior=find(s,client.appId,id);
      if(prior){if(!sameDispatch(prior,input,hash))throw failure(2003,'同一lead_id的业务参数发生变化');return;}
      rejectPriorRecipient(s,recipientKey,physicalKey,legacyKey,input,target);
      if(memberLimit(s,target,clock()))throw failure(2003,reasons.member_rate_limited);
      if(s.leads.length>=10000)throw failure(500,'任务账本容量已满，请联系维护人员',503);
      const reservation={key:recipientKey,physicalKey,appId:client.appId,leadId:id,state:'reserved',updatedAt:clock()};
      const previous=s.recipients.findIndex(r=>r.key===recipientKey);
      if(previous<0)s.recipients.push(reservation);else s.recipients[previous]=reservation;
      s.leads.push({appId:client.appId,leadId:id,input,fingerprint:hash,target:{...target},recipientKey,callbackUrl:client.callbackUrl,
        requestId,deviceId:row.deviceId,stage:'queued',createdAt:clock(),nextAt:clock(),attempts:0});
    });
    return response(true,200,platform.mode==='preview'?'已接收（本地预览，不发送邀请）':'已接收');
  }
  async function devices(client,body) {
    if(Object.keys(body).some(k=>!AUTH_FIELDS.has(k)&&k!=='online_only')||body.online_only!==undefined&&typeof body.online_only!=='boolean')throw failure(2003,'设备查询参数错误');
    const v=await platform.inventory(),state=store.snapshot();
    const visible=v.devices.filter(d=>client.allDeviceStatus||[...client.members.values()].some(m=>m.deviceNumber===d.deviceNumber));
    const rows=visible.filter(d=>body.online_only!==true||d.online===true).map(d=>{
      const accounts=[...client.members.values()].filter(m=>m.deviceNumber===d.deviceNumber).map(m=>{
        const reason=targetReason(d,m,state);
        return {app_slot:m.appSlot,binding_verified:m.bindingVerified===true,enabled:m.enabled!==false,...(m.wecom_phone?{wecom_phone:m.wecom_phone}:{}),wecom_name:m.wecom_name??null,wecom_corp_id:m.wecom_corp_id,wecom_userid:m.wecom_userid,available:reason==='',unavailable_reason:reason};
      });
      const available=accounts.some(a=>a.available);
      return {device_number:d.deviceNumber,device_name:d.deviceName||d.deviceNumber,online:d.online===true,adb_online:d.adbOnline===true,agent_online:d.agentOnline===true,listed:d.listed===true,busy:d.busy===true,
        busy_reason:d.busyReason||'',occupancy:d.occupancy?{type:d.occupancy.type,label:d.occupancy.label}:null,accounts,available,
        unavailable_reason:available?'':accounts[0]?.unavailable_reason||'member_not_configured',last_seen_at:d.lastSeenAt||null,adb_last_seen_at:d.adbLastSeenAt||null};
    });
    return response(true,200,'查询成功',{devices:rows,total:rows.length,updated_at:v.updatedAt||null,capacity:v.capacity});
  }
  async function handle(method,route,raw) {
    if(!Object.values(ROUTES).includes(route))return {status:404,body:response(false,2003,'接口不存在')};
    if(method!=='POST')return {status:405,body:response(false,2003,'只支持POST请求')};
    try {
      await ready;const body=parseBody(raw),client=authenticate(body,clients,clock());await consume(client,body);
      return {status:200,body:await(route===ROUTES.dispatch?dispatch(client,body):devices(client,body))};
    }catch(error){return {status:error.httpStatus||503,body:response(false,error.businessCode||500,error.businessCode?error.message:'服务暂不可用，保留原lead_id核对')};}
  }
  function ownedJob(lead,job) {
    return job&&job.deviceId===lead.deviceId&&job.requestId===lead.requestId&&job.appSlot===lead.target.appSlot&&job.deviceNumber===lead.target.deviceNumber&&job.mode===platform.mode;
  }
  const provenNotSent=result=>result.sendStatus==='not_attempted'&&result.sendClaimed!==true&&result.invitationSent===false&&result.remarkSaveStatus!=='unknown'&&result.execution?.cleanupConfirmed===true;
  async function inspect(lead,job) {
    if(!ownedJob(lead,job))return update(lead,(r,s)=>{r.stage='needs_attention';r.error='original_task_binding_unconfirmed';recipient(r,s,'unknown');});
    const result=job.result||{};
    if(!['succeeded','failed','stalled','expired','cancelled'].includes(job.status))return update(lead,(r,s)=>{r.stage='submitted';r.jobId=job.jobId;r.nextAt=clock()+2000;recipient(r,s,result.sendStatus==='unknown'?'unknown':'submitted');});
    let outcome;
    if(result.code==='already_contact'&&result.sendStatus==='not_attempted'&&result.remarkSaveStatus!=='unknown')outcome={result:'duplicate'};
    else if(job.status==='succeeded'&&result.invitationRequestConfirmed===true&&result.invitationRequestProof==='wecom_system_dialog_v1'&&result.remarkPhoneSet===true)outcome={result:'success',remark_phone_set:true};
    else if(result.code==='wecom_add_friend_too_frequent'&&result.addFriendLimitConfirmed===true&&result.addFriendLimitProof==='wecom_system_dialog_v1')outcome={result:'failed',fail_reason:'添加好友过于频繁'};
    await update(lead,(r,s)=>{
      r.jobId=job.jobId;
      const state=outcome?.result==='duplicate'?'already_contact':outcome?.result==='success'?'request_confirmed':provenNotSent(result)?'not_sent':'unknown';recipient(r,s,state);
      if(outcome?.result==='failed'){
        const at=Date.parse(job.completedAt||'');
        const valid=Number.isFinite(at)&&at>=r.createdAt-300000&&at<=clock()+300000;
        const limit={key:memberIdentity(r.target),until:valid?businessDayEnd(at):null,observedAt:valid?at:null};
        const index=s.limits.findIndex(x=>x.key===limit.key);if(index<0)s.limits.push(limit);else s.limits[index]=limit;
        if(!valid){r.stage='needs_attention';r.error='limit_time_unconfirmed';return;}
        r.outcomeObservedAt=at;
      }
      if(platform.mode==='preview'){
        r.stage=result.status==='ready_before_send'?'preview_complete':'needs_attention';r.error=result.status==='ready_before_send'?'preview_only_not_sent':fixedCode(result.code);return;
      }
      if(!outcome){r.stage='needs_attention';r.error=fixedCode(result.code);return;}
      r.stage='callback_pending';r.outcome=outcome;r.nextAt=clock();
    });
  }
  async function callback(lead,client) {
    if(lead.callbackUrl!==client.callbackUrl)return update(lead,r=>{r.stage='needs_attention';r.error='callback_configuration_changed';});
    // CPS v1 pauses the receiving day's allocation. An old frequency callback
    // must not silently disable the same member again on a new business day.
    if(lead.outcome.result==='failed'&&businessDay(lead.outcomeObservedAt)!==businessDay(clock()))return update(lead,r=>{r.stage='needs_attention';r.error='rate_limit_callback_day_changed';});
    if(lead.attempts>=maxCallbackAttempts)return update(lead,r=>{r.stage='needs_attention';r.error='callback_retry_exhausted';});
    const body={lead_id:BigInt(lead.leadId),...lead.outcome,app_id:lead.appId,timestamp:clock(),nonce:nonce()};body.sign=signature(body,client.secret);
    await update(lead,r=>{r.stage='callback_inflight';r.attempts++;r.lastCallbackAt=clock();});
    let ok=false,code=500,retry=true;
    try {
      const res=await fetchImpl(client.callbackUrl,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json; charset=utf-8'},body:stringifyBody(body),signal:AbortSignal.timeout(5000)});
      const answer=JSON.parse(await bounded(res,65536));code=Number.isSafeInteger(answer.code)?answer.code:500;
      ok=res.ok&&answer.success===true&&code===200;retry=!ok&&(res.status>=500||res.status===429||[500,1002,1003].includes(code));
    }catch{code=500;}
    await update(lead,r=>{
      r.callbackCode=code;
      if(ok){r.stage='completed';r.completedAt=clock();delete r.input.phone;}
      else{r.stage=retry&&r.attempts<maxCallbackAttempts?'callback_pending':'needs_attention';r.error=retry?'callback_ack_unconfirmed':'callback_rejected';r.nextAt=clock()+Math.min(60000,5000*2**(r.attempts-1));}
    });
  }
  async function processLead(lead) {
    const client=clients.get(lead.appId);if(!client)return update(lead,r=>{r.stage='needs_attention';r.error='client_configuration_unavailable';});
    if(['callback_pending','callback_inflight'].includes(lead.stage))return callback(lead,client);
    const current=client.members.get(memberKey(lead.input));
    if(!current||current.enabled===false||current.bindingVerified!==true||current.deviceNumber!==lead.target.deviceNumber||current.appSlot!==lead.target.appSlot||current.wecom_phone!==lead.target.wecom_phone
      ||MEMBER_ID_FIELDS.some(k=>current[k]!==undefined&&current[k]!==(lead.input[k]??lead.target[k])))return update(lead,r=>{r.stage='needs_attention';r.error='member_mapping_changed';});
    if(lead.stage==='queued') {
      const inv=await platform.inventory(),row=matchedDevice(inv,lead.target);
      if(row?.deviceId&&row.deviceId!==lead.deviceId)return update(lead,r=>{r.stage='needs_attention';r.error='physical_device_mapping_changed';});
      const reason=targetReason(row,lead.target,store.snapshot());
      if(reason==='member_rate_limited')return update(lead,r=>{r.stage='needs_attention';r.error=reason;});
      if(reason||inv.capacity.remaining<=0)return update(lead,r=>{r.nextAt=clock()+5000;r.error=reason||'platform_capacity_full';});
      await update(lead,(r,s)=>{r.stage='dispatching';r.dispatchStartedAt=clock();recipient(r,s,'submission_unknown');});
      try {
        const job=await platform.submit(lead);
        await update(lead,r=>{r.jobId=job.jobId;r.stage='submitted';r.nextAt=clock();});return inspect(lead,job);
      }catch(error){return update(lead,(r,s)=>{r.stage=error.noAdmission===true?'queued':'reconcile';r.error=error.noAdmission===true?'platform_busy_not_admitted':'submission_outcome_unknown';r.nextAt=clock()+5000;recipient(r,s,error.noAdmission===true?'reserved':'submission_unknown');});}
    }
    const job=await platform.find(lead);if(job)return inspect(lead,job);
    return update(lead,(r,s)=>{r.stage='needs_attention';r.error='original_submission_not_found_no_replay';recipient(r,s,'unknown');});
  }
  async function tick() {
    if(stopping||pumping||store.fenced())return;pumping=true;
    try {
      await ready;
      const due=store.snapshot().leads.filter(r=>activeStages.has(r.stage)&&r.nextAt<=clock()&&!inFlight.has(key(r.appId,r.leadId))).sort((a,b)=>a.nextAt-b.nextAt);
      const queued=[],other=[],phones=new Set();
      for(const r of due){if(r.stage==='queued'){if(queued.length<2&&!phones.has(r.deviceId)){phones.add(r.deviceId);queued.push(r);}}else if(other.length<6)other.push(r);}
      await Promise.allSettled([...queued,...other].map(async lead=>{
        const id=key(lead.appId,lead.leadId);inFlight.add(id);
        try{await processLead(lead);}catch{await update(lead,r=>{r.nextAt=clock()+5000;r.error='upstream_or_storage_unavailable';}).catch(()=>{});}finally{inFlight.delete(id);}
      }));
    }finally{pumping=false;}
  }
  function status() {
    const counts={};for(const r of store.snapshot().leads)counts[r.stage]=(counts[r.stage]||0)+1;
    return {mode:platform.mode,fenced:store.fenced(),stages:counts};
  }
  return {handle,tick,status,initialize:()=>ready,async close(){stopping=true;while(pumping)await new Promise(r=>setTimeout(r,10));await ready.catch(()=>{});await store.close();}};
}
