import crypto from 'node:crypto';
// Inference and evidence I/O never hold the coordinator transaction. A hard
// deadline bounds even an uncooperative transport; persisted leases cover exits.
export function createLookupAiRecovery({service,reader,loadEvidence,concurrency=5,timeoutMs=120000,onError=()=>{}}){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>5||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw Error('lookup_ai_config_invalid');
  const running=new Map();let closed=false;
  async function run(binding,controller){
    if(!await service.claimAiReading(binding))return;
    let timer;
    try{
      const timeout=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({kind:'unconfirmed',reason:'timeout'});},timeoutMs);});
      const work=(async()=>{
        if(binding.expired)return {kind:'unconfirmed',reason:'interrupted'};
        if(!binding.evidenceId)return {kind:'unconfirmed',reason:'evidence_missing'};
        try{
          const image=await loadEvidence(binding);
          if(controller.signal.aborted)return {kind:'unconfirmed',reason:'timeout'};
          return await reader.read({image,mimeType:binding.mimeType,phoneNumber:binding.phoneNumber,signal:controller.signal});
        }catch{return {kind:'unconfirmed',reason:'unavailable'};}
      })();
      const result=await Promise.race([work,timeout]);
      if(!closed)await service.finishAiReading(binding,result);
    }finally{clearTimeout(timer);}
  }
  return {
    pump(){
      if(closed||!reader.enabled)return;
      for(const candidate of service.aiCandidates()){
        if(running.size>=concurrency)break;
        if(running.has(candidate.lookupId))continue;
        const controller=new AbortController(),binding={...candidate,token:crypto.randomUUID()};
        const promise=run(binding,controller).catch(()=>onError()).finally(()=>running.delete(binding.lookupId));
        running.set(binding.lookupId,{controller,promise});
      }
    },
    active:()=>running.size,
    // Do not delay shutdown on network or persistence; leases survive restart.
    close(){closed=true;for(const r of running.values())r.controller.abort();}
  };
}
