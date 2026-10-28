// Separate QA process. Imports only the collection consumer, never shared Agent startup.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {runXhsDataCollection} from './xhs-data-collection.mjs';
const c=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const task=JSON.parse(await fs.readFile(process.argv[3],'utf8'));
const env={...process.env,PYTHONIOENCODING:'utf-8',XHS_QA_CONFIG:process.argv[2]};
const run=(file,args,o={})=>new Promise((resolve,reject)=>execFile(file,args,{env,windowsHide:true,timeout:o.timeoutMs||30000,maxBuffer:o.maxBuffer||1024*1024,signal:o.signal},(error,stdout,stderr)=>{
  if(error){error.stdout=stdout;error.stderr=stderr;reject(error);}else resolve(stdout);
}));
const config={pythonCommand:c.pythonPath,xhsDataCollectionRunnerPath:path.join(c.stage,'xhs_isolated_runner.py'),adbPath:c.adbPath};
const adb=(serial,args,o)=>{
  if(serial!==c.serial)throw Error('qa_consumer_target_mismatch');
  return run(c.pythonPath,[config.xhsDataCollectionRunnerPath,'--qa-adb',...args],{...o,timeoutMs:12000});
};
const controller=new AbortController();
process.once('SIGTERM',()=>controller.abort(new Error('qa_stopped')));
const start=Date.now();
try{
  const result=await runXhsDataCollection(task,{config,run,adb,signal:controller.signal,cacheDir:path.join(c.stage,'cache'),deviceCachePath:c.inventoryPath});
  console.log(JSON.stringify({ok:true,result,elapsedMs:Date.now()-start}));
}catch(error){
  console.log(JSON.stringify({ok:false,error:error.message,stderr:String(error.stderr||'').slice(-2500),restorationErrors:error.restorationErrors||[],elapsedMs:Date.now()-start}));
}
