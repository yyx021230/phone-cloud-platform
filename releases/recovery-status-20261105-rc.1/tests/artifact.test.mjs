import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {prepare} from '../prepare.mjs';
const root=new URL('../',import.meta.url);
const source=process.env.RECOVERY_STATUS_SOURCE_SNAPSHOT;
if(!source)throw Error('RECOVERY_STATUS_SOURCE_SNAPSHOT must name the local read-only source snapshot');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const manifest=JSON.parse(await fs.readFile(new URL('baseline.json',root),'utf8'));
test('full production source preparation changes only three reviewed regions and the business cache reference',async t=>{
  const receipt=await prepare({cloudSource:path.join(source,'cloud'),agentSource:path.join(source,'agent')});
  t.after(()=>fs.rm(receipt.output,{recursive:true,force:true}));
  for(const [target,fragment] of [
    ['agent/src/recovery-isolation.mjs','windows-agent/src/recovery-isolation.mjs'],
    ['agent/src/index.mjs','windows-agent/src/publish-device-snapshot.mjs'],
    ['cloud/public/app.js','public/recovery-console.js']
  ]){
    const before=await fs.readFile(new URL('baseline/'+fragment,root),'utf8');
    const after=await fs.readFile(new URL('candidate/'+fragment,root),'utf8');
    const original=await fs.readFile(path.join(source,target),'utf8');
    const patched=await fs.readFile(path.join(receipt.output,target),'utf8');
    assert.equal(patched.replace(after,()=>before),original,`${target}: all other code must remain byte-identical`);
    assert.equal(hash(original),manifest.readOnlyProductionSources[target]);
  }
  const html=await fs.readFile(path.join(receipt.output,'cloud/public/index.html'),'utf8');
  assert.equal(html.replace(manifest.cacheReference.after,manifest.cacheReference.before),
    await fs.readFile(path.join(source,'cloud/public/index.html'),'utf8'));
  assert.equal(receipt.runtimeFiles.length,4);
  for(const [name,digest] of Object.entries(manifest.readOnlyProductionSources)) {
    assert.equal(hash(await fs.readFile(path.join(source,name))),digest,'input source is unchanged');
  }
});
test('source drift is refused before preparing a candidate; no best-effort merge',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'recovery-drift-fixture-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  for(const name of Object.keys(manifest.readOnlyProductionSources)) {
    const dest=path.join(dir,name);await fs.mkdir(path.dirname(dest),{recursive:true});
    await fs.copyFile(path.join(source,name),dest);
  }
  await fs.appendFile(path.join(dir,'agent/src/index.mjs'),'\n// concurrent change\n');
  await assert.rejects(prepare({cloudSource:path.join(dir,'cloud'),agentSource:path.join(dir,'agent')}),
    /production_baseline_drift:agent\/src\/index.mjs/);
});
