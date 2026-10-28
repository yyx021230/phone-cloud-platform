import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const ref=JSON.parse(fs.readFileSync(new URL('../public/api-reference.json',import.meta.url)));
const spec=JSON.parse(fs.readFileSync(new URL('../public/openapi.json',import.meta.url)));
test('combined API reference preserves distinct modules and every documented operation',()=>{
 assert.equal(ref.endpoints.length,34);
 assert.deepEqual(ref.groups.map(g=>g[0]),['auth','user','sms','lookup-user','qr-scan','kuaishou-lead','xhs-publish','xhs-data','screen']);
 for(const e of ref.endpoints){
  assert.ok(spec.paths[e.path]?.[e.method.toLowerCase()],`${e.method} ${e.path}`);
  for(const p of e.parameters)assert.ok(['body','path','query','header'].includes(p.location),p.name);
  for(const statuses of Object.values(e.errorStatuses))assert.ok(Array.isArray(statuses));
 }
});
test('XHS creation examples are executable contracts, with separate result retrieval',()=>{
 const rows=ref.endpoints.filter(e=>e.group==='xhs-data');assert.equal(rows.length,4);
 const create=rows.find(e=>e.method==='POST'&&!e.path.endsWith('/cancel'));
 assert.deepEqual(create.parameters.filter(p=>p.required).map(p=>[p.name,p.required,p.location]),[['deviceId',true,'body'],['xhsAppSlot',true,'body']]);
 assert.deepEqual(create.parameters.filter(p=>!p.required).map(p=>p.name),['expectedXhsId','clientRequestId']);
 assert.equal(create.responseExample.task.kind,'xhs_data_collect');assert.equal(create.responseExample.task.status,'queued');
 const detail=rows.find(e=>e.method==='GET'&&e.path.includes('{jobId}'));
 assert.equal(detail.responseExample.task.result.collection.complete,true);
 assert.equal(detail.responseExample.task.result.collection.notes[0].list_comment_count,null);
 assert.equal(detail.responseExample.task.result.collection.notes[0].list_like_count,0);
});

test('prepared docs cover startup and preserve explicit completed/processing/error schemas',()=>{
 const prepare=spec.paths['/api/v1/open/name-lookups/prepare'].post;assert.ok(prepare.parameters.find(p=>p.name==='Idempotency-Key'&&p.required));
 const result=spec.paths['/api/v1/open/name-lookups/tasks/{lookupId}'].get.responses['200'].content['application/json'].schema;
 assert.ok(result.oneOf.some(s=>s.properties.status.enum.includes('completed')&&s.required.includes('name')));
 assert.ok(result.oneOf.some(s=>s.properties.status.enum.includes('processing')&&!s.properties.name));
 assert.ok(result.oneOf.some(s=>s.properties.ok.enum.includes(false)&&!s.properties.name));
 assert.equal(ref.endpoints.filter(e=>e.auth==='api-key').length,4);
 assert.deepEqual(ref.endpoints.filter(e=>e.group==='lookup-user').map(e=>e.path).sort(),['/api/v1/open/name-lookups/stop','/api/v1/open/name-lookups/prepare','/api/v1/open/name-lookups/tasks','/api/v1/open/name-lookups/tasks/{lookupId}'].sort());
 assert.equal(spec.components.securitySchemes.LookupApiKeyAuth?.name||Object.values(spec.components.securitySchemes).find(x=>x.type==='apiKey'&&x.name==='X-API-Key')?.name,'X-API-Key');
});

test('stop contract exposes round fencing and confirmed lifecycle, not a false empty result',()=>{
 const stop=spec.paths['/api/v1/open/name-lookups/stop'].post;
 assert.deepEqual(stop.requestBody.content['application/json'].schema.required,['preparationId']);
 assert.equal(stop.requestBody.content['application/json'].schema.additionalProperties,false);
 for(const [http,status,stopped] of [[200,'stopped',true],[202,'stopping',false]]){
  const p=stop.responses[http].content['application/json'].schema.properties;
  assert.deepEqual(p.status.enum,[status]);assert.deepEqual(p.stopped.enum,[stopped]);assert.equal(p.name,undefined);
 }
 assert.deepEqual(stop.security,[{LookupApiKey:[]}]);
 const statuses=spec.paths['/api/v1/open/name-lookups/prepare'].post.responses[200].content['application/json'].schema.properties.status.enum;
 assert.ok(statuses.includes('stopped')&&statuses.includes('stopping'));
});
