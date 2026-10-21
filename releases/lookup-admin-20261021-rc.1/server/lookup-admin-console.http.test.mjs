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
