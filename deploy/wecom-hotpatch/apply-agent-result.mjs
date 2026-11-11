import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {liveEditCompactor} from './agent-result-liveedit.mjs';

assert.ok(process.argv.length===2||process.argv.length===3&&process.argv[2]==='--apply');
assert.equal(process.platform,'win32');assert.equal(process.version,'v24.18.0');
const apply=process.argv[2]==='--apply',root=fileURLToPath(new URL('../../',import.meta.url));
const entry=String.raw`D:\PhoneCloud\agent\src\index.mjs`;
const before=await fs.readFile(entry,'utf8'),after=await fs.readFile(path.join(root,'index.candidate.mjs'),'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
assert.equal(sha(before),'dd15cc1f6ab588d45ba5f2a19c3cebc06b663e6315f08c68025d5df904e27041');
assert.equal(sha(after),'8a94d6a5ce8e3d26eb9513e38a49163b74f80271ddf5952cb98423139911a871');
const backup=path.join(root,'index.before.mjs'),temporary=entry+'.wecom-result-tmp';let wrote=false;
try{
  if(apply){
    await fs.writeFile(backup,before,{flag:'wx'});await fs.writeFile(temporary,after,{flag:'wx'});
    assert.equal(await fs.readFile(entry,'utf8'),before,'disk_source_drift');await fs.rename(temporary,entry);wrote=true;
  }
  const result=await liveEditCompactor({origin:'http://127.0.0.1:9229',before,after,expectedPid:15224,expectedEntry:entry,apply,closeInspector:true});
  if(apply)assert.equal(await fs.readFile(entry,'utf8'),after,'disk_source_drift_after');
  await fs.writeFile(path.join(root,apply?'agent-result-applied.json':'agent-result-dry-run.json'),JSON.stringify({...result,diskUpdated:wrote},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({...result,diskUpdated:wrote}));
}catch(error){
  if(wrote&&await fs.readFile(entry,'utf8')===after){await fs.writeFile(temporary,before,{flag:'wx'});await fs.rename(temporary,entry);}
  throw error;
}
