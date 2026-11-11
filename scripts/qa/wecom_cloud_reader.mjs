// Read-only JSON-lines client inside the existing cloud container. No listener,
// file writes, Agent registration, task submission or credential export.
import readline from 'node:readline';
const headers={Authorization:'Bearer '+process.env.ADMIN_API_TOKEN};
async function get(route){
 const r=await fetch('http://127.0.0.1:8787'+route,{headers,redirect:'error',signal:AbortSignal.timeout(2000)});
 if(r.status!==200)throw Error('qa_cloud_state_unavailable');return r.json();
}
console.log(JSON.stringify({ready:true}));
for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
 let seq=null;
 try{
  if(line.length>4096)throw Error();const q=JSON.parse(line);seq=q.seq;
  if(!Number.isSafeInteger(seq)||seq<1||!q.target||! /^[A-Za-z0-9_.:-]+$/.test(q.target.serial)
    ||q.target.deviceId!=='adb:'+q.target.serial||q.session&&! /^[a-f0-9-]{36}$/.test(q.session))throw Error();
  const v=await Promise.all([get('/api/v1/devices'),get('/api/v1/device-locks'),get('/api/v1/admin/lookup-pool'),...(q.session?[get('/api/v1/screen-sessions/'+q.session)]:[])]);
  const pool=v[2].pool;
  if(!Array.isArray(v[0].devices)||!Array.isArray(v[1].locks)||!Array.isArray(pool?.devices)||!Array.isArray(pool.channels))throw Error();
  const devices=v[0].devices.filter(d=>d.deviceId===q.target.deviceId&&d.adb?.serial===q.target.serial)
    .map(d=>({deviceId:d.deviceId,deviceName:d.deviceName,adb:{agentId:d.adb.agentId,serial:d.adb.serial,state:d.adb.state},occupancy:d.occupancy}));
  const locks=v[1].locks.filter(l=>l.deviceId===q.target.deviceId&&l.status==='active');
  console.log(JSON.stringify({seq,result:{devices,locks,session:v[3]?.session||null,
   lookupExcluded:!pool.devices.some(d=>d.enabled&&d.deviceId===q.target.deviceId)&&!pool.channels.some(d=>d.deviceId===q.target.deviceId),lookupCounts:pool.counts}}));
 }catch{console.log(JSON.stringify({seq,error:'qa_cloud_read_failed'}));}
}
