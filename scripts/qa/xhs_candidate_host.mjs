// Separate QA process. Imports only the collection consumer, never shared Agent startup.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {runXhsDataCollection} from './xhs-data-collection.mjs';
const c=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const task=JSON.parse(await fs.readFile(process.argv[3],'utf8'));
const env={...process.env,PYTHONIOENCODING:'utf-8',XHS_QA_CONFIG:process.argv[2]};
const run=(file,args,o={})=>new Promise((resolve,reject)=>execFile(file,args,{env,windowsHide:true,timeout:o.timeoutMs||30000,maxBuffer:o.maxBuffer||1024*1024,signal:o.signal},async(error,stdout,stderr)=>{
  // Preserve this isolated collector's raw output before the unchanged consumer
  // deletes its transient file. Never copy shared files or arbitrary output paths.
  const at=args.indexOf('--output');
  if(file===c.pythonPath&&args[0]===path.join(c.stage,'xhs_isolated_runner.py')&&at>=0){
    const source=path.resolve(args[at+1]),owned=path.resolve(c.stage,'cache','xhs-data-collection')+path.sep;
    if(!source.startsWith(owned)){reject(new Error('qa_evidence_path_outside_stage'));return;}
    try{
      if((await fs.stat(source)).size>16*1024*1024)throw Error('output_too_large');
      const bytes=await fs.readFile(source);if(bytes.length>16*1024*1024)throw Error('output_too_large');
      const output=JSON.parse(bytes.toString('utf8'));
      await fs.writeFile(path.join(c.stage,'collector-output-private.json'),bytes,{mode:0o600});
      await fs.writeFile(path.join(c.stage,'collector-output-meta.json'),JSON.stringify({
        exitCode:error?.code??0,signal:error?.signal??null,sha256:createHash('sha256').update(bytes).digest('hex'),
        bytes:bytes.length,complete:output.complete,stopReason:output.stop_reason,notes:output.notes?.length}),{mode:0o600});
    }catch(e){if(e.code!=='ENOENT'){reject(new Error('qa_evidence_copy_failed'));return;}}
  }
  if(error){error.stdout=stdout;error.stderr=stderr;reject(error);}else resolve(stdout);
}));
const config={pythonCommand:c.pythonPath,xhsDataCollectionRunnerPath:path.join(c.stage,'xhs_isolated_runner.py'),adbPath:c.adbPath};
const settingReads=[];
const adb=async(serial,args,o)=>{
  if(serial!==c.serial)throw Error('qa_consumer_target_mismatch');
  const output=await run(c.pythonPath,[config.xhsDataCollectionRunnerPath,'--qa-adb',...args],{...o,timeoutMs:16000});
  if(args[0]==='shell'&&args[1]==='settings'&&args[2]==='get'){
    settingReads.push({scope:args[3],key:args[4],value:output.trim()});
    await fs.writeFile(path.join(c.stage,'settings-evidence.json'),JSON.stringify(settingReads)).catch(()=>{});
  }
  return output;
};
const verifySettings=async()=>{
  for(const [scope,key] of [['system','screen_off_timeout'],['global','enable_screen_on_proximity_sensor']]){
    const original=settingReads.find(r=>r.scope===scope&&r.key===key);
    if(!original)throw Error('qa_settings_baseline_missing');
    const final=(await adb(c.serial,['shell','settings','get',scope,key],{})).trim();
    if(final!==original.value)throw Error('qa_settings_restore_mismatch');
  }
  return true;
};
const controller=new AbortController();
process.once('SIGTERM',()=>controller.abort(new Error('qa_stopped')));
const start=Date.now();
try{
  const result=await runXhsDataCollection(task,{config,run,adb,signal:controller.signal,cacheDir:path.join(c.stage,'cache'),deviceCachePath:c.inventoryPath});
  await verifySettings();
  console.log(JSON.stringify({ok:true,result,settingsRestored:true,settingsEvidence:settingReads,elapsedMs:Date.now()-start}));
}catch(error){
  let settingsRestored=false;
  try{settingsRestored=await verifySettings();}catch{}
  console.log(JSON.stringify({ok:false,error:error.message,stderr:String(error.stderr||'').slice(-2500),restorationErrors:error.restorationErrors||[],settingsRestored,settingsEvidence:settingReads,elapsedMs:Date.now()-start}));
}
