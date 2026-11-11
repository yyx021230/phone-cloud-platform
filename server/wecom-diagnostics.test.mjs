import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { wecomExecution,wecomTransportFailure } from './wecom-diagnostics.mjs';

test('RPC failure details retain fixed categories and drop arbitrary exception text',()=>{
  const detail={reason:'read_timeout',errorType:'ReadTimeout',elapsedMs:80,errno:10054};
  assert.deepEqual(wecomTransportFailure(detail),detail);
  for(const wrong of [{...detail,message:'private UI'},{...detail,errorType:'private'},{...detail,reason:[]},{...detail,elapsedMs:true},{...detail,errno:Infinity}])assert.equal(wecomTransportFailure(wrong),null);
  const base={version:1,phase:'cleanup',failurePhase:'recipient_search',elapsedMs:100,cleanupConfirmed:false,events:[]};
  assert.deepEqual(wecomExecution({...base,transportFailure:detail}).transportFailure,detail);
  assert.deepEqual(wecomExecution({...base,transportFailure:{message:'private'}}),base);
});

test('cloud diagnostic contract is identical to Agent but imports without Agent files in Docker layout', async t=>{
  const cloud=new URL('./wecom-diagnostics.mjs',import.meta.url);
  assert.equal(await fs.readFile(cloud,'utf8'),await fs.readFile(new URL('../windows-agent/src/wecom-diagnostics.mjs',import.meta.url),'utf8'));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wecom-cloud-shape-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  for(const name of ['wecom-preview.mjs','wecom-diagnostics.mjs','wecom-errors.mjs','wecom-preview-devices.json'])await fs.copyFile(new URL('./'+name,import.meta.url),path.join(dir,name));
  const api=await import(pathToFileURL(path.join(dir,'wecom-preview.mjs')).href);
  const execution={version:1,phase:'cleanup',failurePhase:'poco_health',elapsedMs:12,cleanupConfirmed:false,events:[]};
  const job={result:{diagnostic:{wecomExecution:execution}}};
  assert.deepEqual(api.publicPreview(job).result.execution,execution);
  assert.deepEqual(api.publicInvitation(api.publicPreview(job)).execution,execution);
  assert.equal(api.publicPreview({result:{diagnostic:{wecomExecution:{...execution,phase:'private raw UI'}}}}).result.execution,undefined);
});
