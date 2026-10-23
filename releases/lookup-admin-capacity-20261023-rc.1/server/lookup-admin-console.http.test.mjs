import test from 'node:test';import assert from 'node:assert/strict';
import {startAdminPreview} from '../verification/admin-console-preview.mjs';
test('admin console real HTTP: authorization, readonly views, original attempts, private evidence and pagination',{timeout:20000},async t=>{
 const f=await startAdminPreview();t.after(f.stop);
 const req=(p,token=f.admin,options={})=>fetch(f.base+'/api/v1/'+p,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers}});
 const routes=['admin/lookup-pool/console','admin/lookup-pool/console/requests','admin/lookup-pool/console/requests/demo-query-00','admin/lookup-pool/console/jobs/demo-job','admin/lookup-pool/console/jobs/demo-job/evidence/demo-evidence'];
 for(const p of routes){assert.equal((await req(p,'wrong')).status,401);assert.equal((await req(p,'',{headers:{'X-API-Key':'not-an-admin-credential'}})).status,401);}
 const u=await req('users',f.admin,{method:'POST',body:JSON.stringify({username:'synthetic_reader',password:'Synthetic-only-test-42',role:'user'})});assert.equal(u.status,201);
 const login=await req('auth/login','',{method:'POST',body:JSON.stringify({username:'synthetic_reader',password:'Synthetic-only-test-42'})});const userToken=(await login.json()).session.token;
 for(const p of routes)assert.equal((await req(p,userToken)).status,401);
 const before=(await (await req('admin/lookup-pool')).json()).pool;
 const overview=await req(routes[0]);assert.equal(overview.status,200);assert.equal(overview.headers.get('cache-control'),'no-store');const model=await overview.json();assert.equal(model.devices.length,48);assert.equal(model.counts.ready,0);assert.ok(model.devices.some(d=>!d.accountsKnown));
 let cursor=null,ids=[];do{const p=await (await req(routes[1]+(cursor?'?cursor='+cursor:''))).json();ids.push(...p.requests.map(r=>r.lookupId));cursor=p.nextCursor;}while(cursor);assert.equal(ids.length,65);assert.equal(new Set(ids).size,65);
 const detail=await (await req(routes[2])).json();assert.equal(detail.attempts[0].jobs[0].jobId,'demo-job');assert.equal(detail.name,null);assert.doesNotMatch(JSON.stringify(detail),/filePath|idempotencyKey|fingerprint/);
 const image=await req(routes[4]);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.ok((await image.arrayBuffer()).byteLength>0);
 assert.equal((await req('admin/lookup-pool/console/jobs/demo-job/evidence/another')).status,404);
 assert.equal((await req('admin/lookup-pool/console/requests?cursor=bad')).status,400);
 const after=(await (await req('admin/lookup-pool')).json()).pool;assert.deepEqual(after.requests,before.requests);assert.deepEqual(after.preparations,before.preparations);assert.deepEqual(after.channels,before.channels);
});

test('admin HTTP settings add inventory whitelist without old list limits, persist capacity and reject stale or ambiguous mapping',{timeout:20000},async t=>{
 const f=await startAdminPreview();t.after(f.stop);const req=(p,method='GET',body,token=f.admin)=>fetch(f.base+'/api/v1/admin/lookup-pool'+p,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const before=(await (await req('')).json()).pool;const inventory=(await (await req('/preview')).json()).devices;assert.ok(inventory.some(d=>d.deviceNumber===201&&d.matches===1));assert.ok(inventory.some(d=>d.deviceNumber===202&&d.matches===2&&!d.deviceId));assert.equal(before.devices.some(d=>d.deviceNumber===201),false);
 assert.equal((await req('','PUT',{concurrency:8},'bad')).status,401);
 const added={deviceId:'demo-201',deviceNumber:201,enabled:true};let response=await req('','PUT',{devices:[...before.devices,added],concurrency:8,expectedConfigRevision:before.configRevision||0});assert.equal(response.status,200);
 let after=(await (await req('')).json()).pool;assert.equal(after.config.concurrency,8);assert.equal(after.devices.length,49);assert.equal(after.devices.at(-1).health.ready,false);assert.equal(after.channels.length,0);
 assert.equal((await req('','PUT',{concurrency:2,expectedConfigRevision:before.configRevision||0})).status,409);
 assert.equal((await req('','PUT',{devices:[...after.devices,{deviceId:'duplicate-1',deviceNumber:202,enabled:true}]})).status,400);
 assert.equal((await req('','PUT',{devices:[...after.devices,{deviceId:'made-up',deviceNumber:203,enabled:true}]})).status,400);
 const overview=await (await req('/console')).json();assert.equal(overview.statistics.all.submitted,65);assert.equal(overview.counts.registered,49);assert.equal(overview.statistics.all.failed,1);assert.equal(overview.statistics.all.named+overview.statistics.all.empty+overview.statistics.all.failed,65);
 response=await req('','PUT',{devices:before.devices,concurrency:3,expectedConfigRevision:after.configRevision});assert.equal(response.status,200);after=(await (await req('')).json()).pool;assert.equal(after.devices.length,48);assert.equal(after.config.concurrency,3);
});
