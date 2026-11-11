import {remarkName} from './domain.mjs';
// Existing platform administrator credential stays inside this server adapter.
// CPS callers never receive it. No ADB, scanning, recovery or control calls.
export function createPlatform({baseUrl,token,fetchImpl=fetch,mode='preview'}={}) {
  const base=new URL(baseUrl);
  if(!['https:','http:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||base.pathname!=='/'||typeof token!=='string'||!token||/[\r\n]/.test(token)||!['preview','send'].includes(mode))throw Error('cps_platform_config_invalid');
  async function call(method,route,input) {
    let response,data;
    try {response=await fetchImpl(new URL(route,base),{method,redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(5000)});const raw=await bounded(response);data=JSON.parse(raw);}
    catch{throw Error('cps_platform_outcome_unknown');}
    if(!response.ok){const noAdmission=[409,429].includes(response.status)&&['device_busy','wecom_cleanup_pending','wecom_preview_capacity_full','device_not_available'].includes(data.error);
      throw Object.assign(Error('cps_platform_request_rejected'),{noAdmission});}return data;
  }
  return {mode,
    async inventory(){
      const [v,internal]=await Promise.all([call('GET','/api/v1/wecom/devices'),call('GET','/api/v1/user/automation/wecom-cps-devices')]);
      if(!Array.isArray(v.devices)||!Array.isArray(internal.devices)||!v.capacity||!['limit','active','remaining'].every(k=>Number.isSafeInteger(v.capacity[k])&&v.capacity[k]>=0))throw Error('cps_platform_inventory_invalid');
      return {...v,devices:v.devices.map(d=>{const matches=internal.devices.filter(i=>i.deviceNumber===d.deviceNumber);return {...d,deviceId:matches.length===1?matches[0].deviceId:null,remarkPhoneReady:matches.length===1&&matches[0].cpsRemarkPhoneReady===true};})};
    },
    async submit(lead){
      const name=remarkName({...lead.input,lead_id:lead.leadId});
      const v=await call('POST','/api/v1/user/automation/wecom-preview-tasks',{deviceId:lead.deviceId,requestId:lead.requestId,appSlot:lead.target.appSlot,phoneNumber:lead.input.phone,remarkName:name,description:'leadId:'+lead.leadId,requireRemarkPhone:true,mode});
      if(typeof v.task?.jobId!=='string')throw Error('cps_platform_outcome_unknown');return v.task;
    },
    async find(lead){
      if(lead.jobId){const v=await call('GET','/api/v1/user/automation/wecom-preview-tasks/'+encodeURIComponent(lead.jobId));return v.task||null;}
      const v=await call('GET','/api/v1/user/automation/wecom-preview-tasks');if(!Array.isArray(v.tasks))throw Error('cps_platform_outcome_unknown');
      return v.tasks.find(t=>t.requestId===lead.requestId)||null;
    }
  };
}
export async function bounded(response,maximum=1048576) {
  let size=0;const chunks=[];
  for await(const part of response.body){size+=part.length;if(size>maximum)throw Error('cps_response_too_large');chunks.push(part);}
  return Buffer.concat(chunks).toString('utf8');
}
