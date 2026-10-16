import fs from 'node:fs/promises';
import {OpenNameLookupClient} from './node_client.mjs';
const dir='/tmp/pc-external-50-20261016';
let input='';for await(const chunk of process.stdin)input+=chunk;
const credential=JSON.parse(input);input='';
if(credential.phones.length!==50||new Set(credential.phones).size!==50)throw Error('invalid_authorized_input');
const stateFile=dir+'/STATE.json';let s;
try{s=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;s={run:'external-50-20261016',startedAt:new Date().toISOString(),budget:50,sourceOffset:100,round:1,prepareKey:'external-50-20261016-prepare-1',rows:Array.from({length:50},(_,i)=>({index:i+100,key:'external-50-20261016-business-'+(i+100)}))};}
const save=async()=>{await fs.writeFile(stateFile+'.tmp',JSON.stringify(s,null,2)+'\n',{mode:0o600});await fs.rename(stateFile+'.tmp',stateFile);};await save();
const emit=async x=>{const v={at:new Date().toISOString(),...x};await fs.appendFile(dir+'/EVENTS.jsonl',JSON.stringify(v)+'\n',{mode:0o600});if(['summary','ready-change','submitted','retry','paused','done','error'].includes(x.event))console.log(JSON.stringify(v));};
const rawFetch=globalThis.fetch;globalThis.fetch=async(url,init)=>{const u=new URL(typeof url==='string'?url:url.url);if(u.origin!=='http://47.98.127.132'||!/^\/api\/v1\/open\/name-lookups\/(prepare|tasks(?:\/[A-Za-z0-9-]+)?)$/.test(u.pathname))throw Error('non_public_endpoint');const r=await rawFetch(url,init);let d={};try{d=await r.clone().json();}catch{}await emit({event:'http',method:init?.method||'GET',path:u.pathname.replace(/tasks\/.+$/,'tasks/{lookupId}'),http:r.status,status:d.status,code:d.code,keys:Object.keys(d).sort()});return r;};
const client=new OpenNameLookupClient({baseUrl:'http://47.98.127.132',clientId:credential.clientId,secret:credential.secret,requestTimeoutMs:15000});
const phone=r=>credential.phones[r.index-100];
const terminal=r=>['completed','failed','expired','cancelled'].includes(r.status);
const conciseError=e=>({http:e.status||null,code:String(e.code||e.name||'request_failed').slice(0,100)});
const submit=async r=>{r.firstSubmittedAt??=Date.now();r.lastAttemptAt=Date.now();await save();try{const x=await client.submitLookup(phone(r),{idempotencyKey:r.key});if(!x.lookupId)throw Error('missing_lookup_id');if(r.lookupId&&r.lookupId!==x.lookupId)throw Error('duplicate_lookup_id');r.lookupId=x.lookupId;r.status=x.status;r.acceptedAt??=Date.now();r.error=null;await emit({event:'submitted',index:r.index,lookupId:x.lookupId,status:x.status,reused:x.reused});}catch(e){r.error=conciseError(e);await emit({event:'submit-error',index:r.index,...r.error});}await save();};
let lastSummary=0,lastReady=null;const deadline=Date.now()+60*60_000;
while(Date.now()<deadline){
 let prep;try{prep=await client.prepareLookup({idempotencyKey:s.prepareKey});s.preparationId=prep.preparationId;s.preparationStatus=prep.status;s.expiresAt=prep.expiresAt;if(lastReady!==prep.ready){await emit({event:'ready-change',ready:prep.ready,status:prep.status});lastReady=prep.ready;}
 if(prep.status==='expired'){if(s.round>=2){await emit({event:'paused',reason:'preparation_round_budget',submitted:s.rows.filter(r=>r.lookupId).length});break;}s.round++;s.prepareKey=s.run+'-prepare-'+s.round;await save();continue;}}catch(e){await emit({event:'error',phase:'prepare',...conciseError(e)});}
 const existing=s.rows.filter(r=>r.lookupId&&!terminal(r));
 for(let i=0;i<existing.length;i+=5){await Promise.all(existing.slice(i,i+5).map(async r=>{try{const x=await client.getLookupResult(r.lookupId);if(x.lookupId!==r.lookupId)throw Error('result_id_mismatch');if(x.status==='completed'){if(typeof x.name!=='string')throw Error('invalid_name');r.hasName=Boolean(x.name);r.completedAt??=Date.now();}else if(Object.hasOwn(x,'name'))throw Error('name_on_unfinished');if(x.status!==r.status)await emit({event:'result',index:r.index,lookupId:r.lookupId,status:x.status,hasName:r.hasName,code:x.code});r.status=x.status;r.code=x.code||'';r.lastReadAt=Date.now();}catch(e){await emit({event:'error',phase:'get',index:r.index,...conciseError(e)});}}));}await save();
 // Simulate two-minute caller timeout only for still-inflight canonical requests.
 for(const r of s.rows.filter(r=>r.lookupId&&!terminal(r)&&!r.retryVerified&&Date.now()-r.firstSubmittedAt>=121000)){
  r.retryKey??=r.key+'-after-two-minutes';await save();try{const x=await client.submitLookup(phone(r),{idempotencyKey:r.retryKey});if(x.lookupId!==r.lookupId){await emit({event:'paused',reason:'duplicate_lookup_id',index:r.index});process.exitCode=2;await save();process.exit();}r.retryVerified=true;r.retryElapsedMs=Date.now()-r.firstSubmittedAt;r.statusAtRetry=x.status;await emit({event:'retry',index:r.index,sameId:true,elapsedMs:r.retryElapsedMs,status:x.status});}catch(e){await emit({event:'error',phase:'retry',index:r.index,...conciseError(e)});}await save();
 }
 // Keep at most 20 unfinished submissions, replenish independently as results arrive.
 if(prep?.ready){const used=s.rows.filter(r=>r.lookupId&&!terminal(r)).length;const capacity=20-used;const waiting=s.rows.filter(r=>!r.lookupId&&(!r.lastAttemptAt||Date.now()-r.lastAttemptAt>=10000)).slice(0,capacity);if(waiting.length){
  // Reserve all keys durably before the burst; ambiguous responses only retry these keys.
  for(const r of waiting){r.firstSubmittedAt??=Date.now();r.lastAttemptAt=Date.now();}await save();
  await Promise.all(waiting.map(async r=>{try{const x=await client.submitLookup(phone(r),{idempotencyKey:r.key});if(!x.lookupId)throw Error('missing_lookup_id');r.lookupId=x.lookupId;r.status=x.status;r.acceptedAt??=Date.now();r.error=null;await emit({event:'submitted',index:r.index,lookupId:x.lookupId,status:x.status,reused:x.reused});}catch(e){r.error=conciseError(e);await emit({event:'submit-error',index:r.index,...r.error});}}));await save();}}
 const accepted=s.rows.filter(r=>r.lookupId).length,completed=s.rows.filter(r=>r.status==='completed').length,failed=s.rows.filter(r=>terminal(r)&&r.status!=='completed').length;
 if(Date.now()-lastSummary>=30000||accepted===50&&completed+failed===50){await emit({event:'summary',accepted,completed,failed,unfinished:accepted-completed-failed,remainingToSubmit:50-accepted,hasName:s.rows.filter(r=>r.hasName===true).length,emptyName:s.rows.filter(r=>r.hasName===false).length,inflightRetries:s.rows.filter(r=>r.retryVerified).length,preparationStatus:s.preparationStatus});lastSummary=Date.now();}
 if(accepted===50&&completed+failed===50){await emit({event:'done',accepted,completed,failed});await save();break;}
 try{await fs.access(dir+'/PAUSE');await emit({event:'paused',reason:'operator_pause_preserve_requests'});break;}catch{}
 await new Promise(r=>setTimeout(r,5000));
}
await save();
