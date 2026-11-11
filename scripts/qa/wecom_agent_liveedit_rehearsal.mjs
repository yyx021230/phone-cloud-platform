import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {liveEditCompactor,validateDelta} from '../../deploy/wecom-hotpatch/agent-result-liveedit.mjs';

const before=await fs.readFile(process.argv[2],'utf8'),after=await fs.readFile(process.argv[3],'utf8');
validateDelta(before,after);
assert.throws(()=>validateDelta(before,after+'\n// unrelated change'));
const take=s=>s.slice(s.indexOf('function compactTaskResultForStatus('),s.indexOf('\nfunction normalizeEvidenceForTransport('));
assert.ok(take(before).startsWith('function compactTaskResultForStatus('));
const prefix="await Promise.resolve();function compactEventDetail(x){return x;}function compactScreenshotForTransport(x){return x;}\n";
const suffix="\nprocess.on('SIGTERM',()=>{void compactTaskResultForStatus;process.exit();});setInterval(()=>{},10);\n";
const oldSource=prefix+take(before)+suffix,newSource=prefix+take(after)+suffix;
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wecom-agent-liveedit-')),temporaryFile=path.join(directory,'fixture.mjs');
await fs.writeFile(temporaryFile,oldSource);const file=await fs.realpath(temporaryFile);
const child=spawn(process.execPath,['--inspect=127.0.0.1:0',file],{stdio:['ignore','ignore','pipe']});
try{
  const origin=await new Promise((resolve,reject)=>{child.stderr.on('data',b=>{const m=String(b).match(/ws:\/\/127\.0\.0\.1:(\d+)\//);if(m)resolve('http://127.0.0.1:'+m[1]);});setTimeout(()=>reject(Error('fixture_startup_timeout')),3000).unref();});
  await new Promise(resolve=>setTimeout(resolve,100));
  const input={origin,before:oldSource,after:newSource,expectedPid:child.pid,expectedEntry:file};
  const dry=await liveEditCompactor(input);assert.equal(dry.applied,false);
  const applied=await liveEditCompactor({...input,apply:true});assert.equal(applied.applied,true);assert.equal(applied.paused,0);
  await assert.rejects(liveEditCompactor(input),/live_source_drift/);
  console.log(JSON.stringify({node:process.version,dry,applied,secondApplyRejected:true,unrelatedDeltaRejected:true}));
}finally{child.kill('SIGTERM');await once(child,'exit');await fs.rm(directory,{recursive:true});}
