import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const ref=JSON.parse(fs.readFileSync(new URL('../public/api-reference.json',import.meta.url)));
const spec=JSON.parse(fs.readFileSync(new URL('../public/openapi.json',import.meta.url)));
test('combined API reference preserves distinct modules and every documented operation',()=>{
 assert.equal(ref.endpoints.length,46);
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
 assert.deepEqual(create.parameters.map(p=>[p.name,p.required,p.location]),[['deviceId',true,'body'],['xhsAppSlot',true,'body']]);
 assert.equal(create.responseExample.task.kind,'xhs_data_collect');assert.equal(create.responseExample.task.status,'queued');
 const detail=rows.find(e=>e.method==='GET'&&e.path.includes('{jobId}'));
 assert.equal(detail.responseExample.task.result.collection.complete,true);
 assert.equal(detail.responseExample.task.result.collection.notes[0].list_comment_count,null);
 assert.equal(detail.responseExample.task.result.collection.notes[0].list_like_count,0);
});
