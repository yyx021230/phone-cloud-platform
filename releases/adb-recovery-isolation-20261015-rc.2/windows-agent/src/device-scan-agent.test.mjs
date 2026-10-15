import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {once} from 'node:events';import {spawn} from 'node:child_process';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('real Agent entrypoint publishes two fresh inventories while fake-device metadata is stalled; heartbeat and pause ACK continue',{timeout:20000,skip:process.platform==='win32'},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-discovery-'));const syncs=[],beats=[];let child,stderr='';
 const control={protocol:'device_recovery_control_v1',revision:1,paused:[{serial:'FIXTURE-A',reason:'fixture'}]};
 const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};let response={};
  if(req.url.endsWith('/devices/sync')){syncs.push({at:Date.now(),body});response={devices:[]};}
  else if(req.url.endsWith('/heartbeat')){beats.push(body);response={agent:{recoveryControl:control}};}
  else response={tasks:[],task:null,probes:[]};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(response));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{if(child?.exitCode===null){const exit=once(child,'exit');try{process.kill(-child.pid,'SIGKILL');}catch{}await exit;}server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const executable=path.join(dir,'fixture-adb');const trace=path.join(dir,'trace.jsonl'),state=path.join(dir,'state');await fs.writeFile(state,'device');
 await fs.writeFile(executable,`#!${process.execPath}\nimport fs from 'node:fs';\nconst a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(a)+'\\n');if(a.includes('version'))console.log('Android Debug Bridge version fixture');else if(a.includes('devices'))console.log('List of devices attached\\nFIXTURE-A\\t'+fs.readFileSync(${JSON.stringify(state)},'utf8')+'\\nFIXTURE-B\\tdevice\\n');else setTimeout(()=>console.log(''),15000);\n`,{mode:0o700});
 const runner=path.join(dir,'fixture-runner.mjs');await fs.writeFile(runner,"console.log('xhs_data_collect_v1');");
 const config=path.join(dir,'config.json');await fs.writeFile(config,JSON.stringify({agentId:'fixture',serverBaseUrl:`http://127.0.0.1:${server.address().port}`,agentToken:'fixture-only',adbPath:executable,pythonCommand:process.execPath,xhsDataCollectionRunnerPath:runner,airtestEnabled:false,autoInstallAirtest:false,automationPreflightEnabled:false,screenStreamEnabled:false,smsLibrarySyncEnabled:false,smsLibraryBackgroundSyncEnabled:false,smsNotificationFallbackEnabled:false,scanIntervalSeconds:3,heartbeatIntervalSeconds:5,logDir:path.join(dir,'logs'),cacheDir:path.join(dir,'cache'),dataDir:path.join(dir,'data')}));
 const start=Date.now();child=spawn(process.execPath,['src/index.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),detached:true,env:{PATH:process.env.PATH,PHONE_CLOUD_AGENT_CONFIG:config,NODE_ENV:'test'},stdio:['pipe','ignore','pipe']});child.stderr.on('data',c=>stderr=(stderr+c).slice(-3000));
 for(let i=0;i<130 && syncs.length<2;i++){if(child.exitCode!==null)assert.fail(stderr);if(syncs.length===1)await fs.writeFile(state,'offline');await sleep(60);}
 assert(syncs.length>=2,`expected two inventories; ${stderr}`);assert(syncs[0].at-start<3000,'first inventory must not wait for shell metadata timeout');assert.equal(syncs[0].body.devices.find(x=>x.adbSerial==='FIXTURE-A').state,'device');assert.equal(syncs[1].body.devices.find(x=>x.adbSerial==='FIXTURE-A').state,'offline');assert.equal(syncs[1].body.devices.find(x=>x.adbSerial==='FIXTURE-B').state,'device');
 for(let i=0;i<60&&!beats.some(x=>x.health?.recoveryControl?.revision===1);i++)await sleep(60);
 assert(beats.some(x=>x.health?.recoveryControl?.revision===1&&x.health.recoveryControl.synced),'pause ACK proceeds while metadata hangs');const commands=(await fs.readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);assert(commands.some(a=>a.includes('shell')),'maintenance really started');assert(!commands.some(a=>a.includes('kill-server')||a.includes('start-server')||a.includes('reconnect')));
});
