// Recovery-only durable confirmation. Existing upserts may skip older UTC
// revisions without throwing; an ACK is not evidence until all rows match.
import {isDeepStrictEqual as equal} from 'node:util';
const json=v=>JSON.parse(JSON.stringify(v));
export async function persistWecomRecovery({bundle,repos,getPool,transactionClient=null}){
 const operation=async client=>{
  await repos.persistTaskMutation({...bundle,transactionClient:client});
  for(const [table,key,rows]of [
   ['phone_cloud_device_locks','lock_id',[bundle.deviceLock,...(bundle.deviceLocks||[])]],
   ['phone_cloud_windows_tasks','task_id',bundle.windowsTasks||[]]
  ]){
   const ids=rows.map(r=>r[key==='lock_id'?'lockId':'taskId']);
   if(!ids.length)continue;
   const actual=(await client.query(`SELECT ${key},data FROM ${table} WHERE ${key}=ANY($1::text[]) FOR UPDATE`,[ids])).rows;
   if(actual.length!==ids.length||rows.some(row=>!equal(json(row),actual.find(a=>a[key]===row[key==='lock_id'?'lockId':'taskId'])?.data)))throw Error('wecom_cleanup_recovery_write_unconfirmed');
  }
 };
 if(transactionClient)return operation(transactionClient);
 const client=await(await getPool()).connect();
 try{await client.query('BEGIN');await operation(client);await client.query('COMMIT');}
 catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
 finally{client.release();}
}
