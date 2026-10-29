import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupXmlFailure} from './lookup-xml-failure.mjs';
test('terminated runner retains last step without classifying progress JSON as the error',()=>{
 const result=lookupXmlFailure({killed:true,signal:'SIGTERM',stdout:'{"event":{"step":"open_my_tab","elapsedMs":11000,"account":"PRIVATE"}}\n{"event":{"step":"account_picker_sample","elapsedMs":119000}}'},()=>{throw Error('not a final result');});
 assert.equal(result.error,'lookup_xml_runner_terminated');
 assert.equal(result.executionExit.lastStep,'account_picker_sample');
 assert.equal(result.executionExit.progress[1].elapsedMs,119000);
 assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.deepEqual(result.log,[]);
});
test('actual final failure and account metadata retain existing parsing',()=>{
 const result={ok:false,error:'device offline',currentAccount:'SYNTHETIC'};
 assert.equal(lookupXmlFailure({stdout:JSON.stringify(result)},()=>result),result);
});
test('nonzero exit and truncated output are distinct from a timeout assertion',()=>{
 const result=lookupXmlFailure({code:1,stdout:'{"event":'},()=>{});
 assert.equal(result.error,'lookup_xml_runner_nonzero_exit');assert.equal(result.executionExit.lastStep,null);
 assert.equal(lookupXmlFailure({stdout:''},()=>{}).executionExit.kind,'no_final_result');
});
test('only bounded, structured stage information enters exit diagnostics',()=>{
 const stdout=Array.from({length:50},(_,i)=>JSON.stringify({event:{step:'sample',elapsedMs:i,detail:'PRIVATE'}})).join('\n')+'\n'+JSON.stringify({event:{step:'phone_13800000000'}});
 const r=lookupXmlFailure({stdout},()=>{});assert.equal(r.executionExit.progress.length,16);assert.ok(!JSON.stringify(r).includes('13800000000'));assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('real subprocess termination retains the last emitted checkpoint',async()=>{
 const {execFile}=await import('node:child_process');
 const error=await new Promise(resolve=>execFile(process.execPath,['-e',
   'console.log(JSON.stringify({event:{step:"account_picker_sample",elapsedMs:5}}));setInterval(()=>{},1000)'],
   {timeout:500},(error,stdout,stderr)=>resolve(Object.assign(error||{},{stdout,stderr}))));
 const r=lookupXmlFailure(error,()=>{throw Error('no final output expected');});
 assert.equal(r.executionExit.kind,'terminated');assert.equal(r.executionExit.lastStep,'account_picker_sample');
 assert.deepEqual(r.log,[]);
});
