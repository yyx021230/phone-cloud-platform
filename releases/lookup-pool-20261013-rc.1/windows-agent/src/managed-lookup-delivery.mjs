export const MANAGED_LOOKUP_PROTOCOL='managed_lookup_v1';
export async function hydrateManagedLookupTask(task,{request}={}){
  const m=task.payload?.managedLookup;
  if(m?.protocol!==MANAGED_LOOKUP_PROTOCOL||!m.generation||!task.deliveryToken)throw new Error('managed_lookup_delivery_invalid');
  const path='/api/v1/windows-agent-tasks/'+encodeURIComponent(task.taskId);
  const payload=await request(path+'/payload',{method:'POST',body:{deliveryToken:task.deliveryToken}});
  if(payload?.payload?.managedLookup?.generation!==m.generation)throw new Error('managed_lookup_delivery_generation_mismatch');
  const hydrated={...task,payload:{...task.payload,...payload.payload}};
  let acknowledgementError;
  for(let i=0;i<3;i++){
    try{const ack=await request(path+'/ack',{method:'POST',body:{deliveryToken:task.deliveryToken}});if(ack?.ok!==true)throw new Error('managed_lookup_ack_not_confirmed');return {task:hydrated,acknowledged:true};}
    catch(e){acknowledgementError=e;}
  }
  // Never return executable lookup work after an uncertain ACK. The cloud
  // retains the reservation and reconciles the original task; no new query.
  return {task:hydrated,acknowledged:false,acknowledgementError};
}
