// Isolated test adapter: production Agent lifecycle functions; no shared Agent startup.
import fs from 'node:fs/promises';import path from 'node:path';import readline from 'node:readline';import {spawn,execFile} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {pocoForwardLocals,stopWorkerWithFallback,waitForWorkerExit} from './src/worker-shutdown.mjs';
import {isLookupReaderRecovery,readerExitDiagnostic,verifyLookupReaderCleanup,lookupReaderStopReason} from './src/lookup-reader-lifecycle.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));const config={pythonCommand:'D:\\PhoneCloud\\tools\\python39\\python.exe',airtestRunnerPath:path.join(root,'fault-worker.py'),adbPath:'D:\\PhoneCloud\\tools\\android-sdk\\platform-tools\\adb.exe'};
const airtestWorkersBySerial=new Map(),lookupReaderStopBarriers=new Map();const log=(message,detail)=>fs.appendFile(path.join(root,'host-private.log'),JSON.stringify({at:new Date().toISOString(),message,detail})+'\n');
const airtestEnv=()=>({...process.env,PYTHONIOENCODING:'utf-8',ADB:config.adbPath,PHONE_CLOUD_LOOKUP_OCR_PYTHON:'D:\\PhoneCloud\\agent\\runtime\\lookup-ocr\\Scripts\\python.exe'});
let lostAckSerial=null;const rawRun=(file,args,options={})=>new Promise((resolve,reject)=>execFile(file,args,{timeout:options.timeoutMs||30000,maxBuffer:20*1024*1024,windowsHide:true,cwd:root,env:airtestEnv()},(e,o,s)=>{if(e){e.stdout=o;e.stderr=s;reject(e)}else resolve(o.trim())}));
const run=async(file,args,options={})=>{const result=await rawRun(file,args,options);if(lostAckSerial&&args[0]==='-s'&&args[1]===lostAckSerial&&args[3]==='am'&&args[4]==='force-stop'){lostAckSerial=null;log('test lost cleanup ACK injected',{});throw Error('controlled cleanup ACK timeout');}return result;};
const delay=ms=>new Promise(r=>setTimeout(r,ms));const runLimited=(items,_limit,fn)=>Promise.all(items.map(fn));
const source=await fs.readFile(path.join(root,'src/index.mjs'),'utf8');
const workerSource=source.slice(source.indexOf('function createAirtestWorker('),source.indexOf('async function pauseAutomationForScreenControl('));
const callSource=source.slice(source.indexOf('async function runXhsAirtestPocoWorker('),source.indexOf('function hasActiveAirtestLookupWarmLease('));
let impl;
const getAirtestWorker=async serial=>{if(lookupReaderStopBarriers.has(serial)&&await lookupReaderStopBarriers.get(serial)!==true)throw Error('cleanup unconfirmed');let w=airtestWorkersBySerial.get(serial);if(!w||w.exited){w=impl.createAirtestWorker(serial);airtestWorkersBySerial.set(serial,w);}await w.readyPromise;return w;};
const deps={spawn,config,agentDir:root,airtestEnv,airtestWorkersBySerial,lookupReaderStopBarriers,log,cleanLogText:s=>String(s),getAirtestWorker,delay,pocoForwardLocals,stopWorkerWithFallback,waitForWorkerExit,isLookupReaderRecovery,readerExitDiagnostic,verifyLookupReaderCleanup,lookupReaderStopReason,run,runLimited};
impl=new Function(...Object.keys(deps),workerSource+callSource+';return {createAirtestWorker,runXhsAirtestPocoWorker,stopAirtestWorker};')(...Object.values(deps));
let cleanup=false;async function shutdown(){if(cleanup)return;cleanup=true;for(const serial of airtestWorkersBySerial.keys())await impl.stopAirtestWorker(serial,'lookup_session_stopped');}
const input=readline.createInterface({input:process.stdin});
for await(const line of input){let q;try{q=JSON.parse(line);}catch{continue;}void (async()=>{let result;const t=Date.now();try{
 const serial=q.payload?.serial||q.serial;
 if(q.kind==='stop')result={stopped:await impl.stopAirtestWorker(serial,q.reason||'lookup_query_app_recovery')};
 else if(q.kind==='shutdown'){await shutdown();result={stopped:true};}
 else if(['start','switch','list_accounts'].includes(q.payload.operation)){
  if(!await impl.stopAirtestWorker(serial,'lookup_query_app_recovery'))throw Error('cleanup unconfirmed');
  const p=path.join(root,'task-'+q.id+'.json');await fs.writeFile(p,JSON.stringify(q.payload));const out=await run(config.pythonCommand,['-u',path.join(root,'scripts/alipay_name_lookup.py'),'--payload',p],{timeoutMs:120000});const objects=out.split(/\r?\n/).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);result=objects.findLast(x=>x.result||typeof x.ok==='boolean');result=result?.result||result;
 }else{if(q.payload._faultProbeOnce){const w=await getAirtestWorker(serial),original=w.enqueue.bind(w),write=w.child.stdin.write.bind(w.child.stdin);let injected=false;w.enqueue=(p,...args)=>{if(!injected&&p.operation==='poco_probe'){injected=true;log('test lookup probe failure injected',{});return Promise.resolve({ok:false,operation:'poco_probe',selectorResponded:false});}return original(p,...args);};w.child.stdin.write=(line,...args)=>{if(line==='__exit_lookup__\n'){w.child.stdin.write=write;log('test graceful exit held for forced-cleanup branch',{});return true;}return write(line,...args);};lostAckSerial=serial;}const events=[];result=await impl.runXhsAirtestPocoWorker(q.payload,{readyTimeoutMs:25000,timeoutMs:65000,maxIdleMs:900000,onEvent:async e=>{events.push(e);}});result={...result,log:events.length?events:result.log};}
 if(q.kind==='run'&&!['start','switch','list_accounts'].includes(q.payload.operation)){try{const image=await new Promise((resolve,reject)=>execFile(config.adbPath,['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',timeout:4000,maxBuffer:8*1024*1024,windowsHide:true},(e,b)=>e?reject(e):resolve(b)));result.image=image.toString('base64');}catch{}}
 process.stdout.write(JSON.stringify({id:q.id,result,seconds:(Date.now()-t)/1000})+'\n');
 }catch(e){process.stdout.write(JSON.stringify({id:q.id,error:String(e.message),seconds:(Date.now()-t)/1000})+'\n');}
 if(q.kind==='shutdown')process.exit(0);
 })();}
await shutdown();
