import fs from 'node:fs/promises';import {OpenNameLookupClient} from SDK_URL;
const dir='/app/data/test-receipts/lookup-partner-rc14-20261015',clientId='name-lookup-v1',action=process.argv[2];
const c=JSON.parse(process.env.OPEN_NAME_LOOKUP_CLIENTS_JSON||'[]').find(c=>c.clientId===clientId);if(!c?.secret)throw Error('client_missing');
let state=JSON.parse(await fs.readFile(dir+'/STATE.json','utf8'));
const emit=x=>console.log(JSON.stringify({at:new Date().toISOString(),...x}));
const originalFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==='string'?input:input.url);if(u.origin!=='http://47.98.127.132'||!/^\/api\/v1\/open\/name-lookups\/(prepare|tasks(?:\/[A-Za-z0-9-]+)?)$/.test(u.pathname))throw Error('non_public_business_endpoint');const r=await originalFetch(input,init);let d={};try{d=await r.clone().json()}catch{};emit({event:'public-http',method:init?.method||'GET',path:u.pathname.replace(/tasks\/[A-Za-z0-9-]+$/,'tasks/{lookupId}'),http:r.status,status:d.status||'',code:d.code||'',keys:Object.keys(d).sort()});return r;};
const client=new OpenNameLookupClient({baseUrl:'http://47.98.127.132',clientId,secret:c.secret,requestTimeoutMs:15000});
const save=async()=>fs.writeFile(dir+'/STATE.json',JSON.stringify(state),{mode:0o600});
const phones=JSON.parse(await fs.readFile('/app/data/test-receipts/lookup-natural-handoff-20261015/phones.json','utf8'));
if(action==='prepare'){
 const r=await client.prepareLookup({idempotencyKey:state.prepareKey});state.preparationId=r.preparationId;await save();emit({event:'preparation',...r});
}else if(action==='batch'){
 const count=Number(process.argv[3]||5);if(count!==5||state.rows.length+count>10)throw Error('budget');
 const ready=await client.prepareLookup({idempotencyKey:state.prepareKey});if(!ready.ready)throw Error('not_ready');
 const offset=90+state.rows.length;const rows=Array.from({length:5},(_,i)=>({index:offset+i,key:state.run+'-business-'+(offset+i),submittedAt:Date.now()}));
 // Persist keys before any request. Ambiguous network outcome is retried with original keys.
 state.rows.push(...rows);await save();
 await Promise.all(rows.map(async row=>{try{const r=await client.submitLookup(phones[row.index],{idempotencyKey:row.key});row.lookupId=r.lookupId;row.reused=r.reused;row.initialStatus=r.status;emit({event:'submitted',index:row.index,lookupId:r.lookupId,reused:r.reused,status:r.status});}catch(e){row.httpError=e.status;row.error=e.code;emit({event:'submit-error',index:row.index,http:e.status,code:e.code});}}));await save();
}else if(action==='retry-after-timeout'){
 const rows=state.rows.filter(r=>r.lookupId&&!r.newKeyChecked);if(!rows.length)throw Error('no_retry_rows');
 const elapsed=Date.now()-Math.max(...rows.map(r=>r.submittedAt));if(elapsed<121000)throw Error('need_wait_121_seconds');
 for(const row of rows){const r=await client.submitLookup(phones[row.index],{idempotencyKey:row.key+'-after-timeout'});if(r.lookupId!==row.lookupId)throw Error('duplicate_lookup_id');row.newKeyChecked=true;row.retryElapsedMs=Date.now()-row.submittedAt;row.statusAtRetry=r.status;emit({event:'timeout-retry',index:row.index,lookupId:r.lookupId,sameId:true,elapsedMs:row.retryElapsedMs,status:r.status});}await save();
}else if(action==='poll'){
 for(const row of state.rows.filter(r=>r.lookupId)){const r=await client.getLookupResult(row.lookupId);row.status=r.status;row.lastReadAt=Date.now();if(r.status==='completed'){if(typeof r.name!=='string')throw Error('invalid_name');row.hasName=Boolean(r.name);}row.code=r.code||'';emit({event:'result',index:row.index,lookupId:row.lookupId,status:r.status,hasName:row.hasName,code:r.code||''});}await save();
}else if(action==='old-result'){
 const r=await client.getLookupResult('0761ca1b-b5f6-404d-bb9c-6b793d6c5807');emit({event:'old156-result-separate',lookupId:r.lookupId,status:r.status,hasName:typeof r.name==='string'?Boolean(r.name):undefined,code:r.code||''});
}else throw Error('unknown_action');
