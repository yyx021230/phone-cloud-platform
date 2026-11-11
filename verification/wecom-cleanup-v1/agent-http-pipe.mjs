import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

// Local-only integration fixture. Never boots an Agent, accesses ADB, or uses real tool facts.
const pythonCommand=process.env.WECOM_TEST_PYTHON||'python3';
try{await promisify(execFile)(pythonCommand,['-c','import psutil'],{timeout:1000});}
catch{throw Error('fixture_python_psutil_dependency_unavailable');}
const [serverRoot,agentRoot,folder,faultMode='proof-ack-once']=process.argv.slice(2);
if(!['proof-ack-once','host-network-and-close-ack','proof-ack-always'].includes(faultMode))throw Error('fixture_fault_mode_invalid');
if(![serverRoot,agentRoot,folder].every(v=>v&&path.isAbsolute(v)))throw Error('fixture_absolute_roots_required');
if(await fs.stat(path.join(serverRoot,'.env')).then(()=>true,()=>false))throw Error('fixture_env_forbidden');
await fs.mkdir(folder,{recursive:true,mode:0o700});await fs.chmod(folder,0o700);
const listener=http.createServer().listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
const base=`http://127.0.0.1:${port}`,password=crypto.randomBytes(24).toString('hex');
const log=await fs.open(path.join(folder,'server.log'),'a',0o600);let server,stage='start';
const start=async()=>{
  server=spawn(process.execPath,[path.join(serverRoot,'server/index.mjs')],{cwd:serverRoot,stdio:['ignore',log.fd,log.fd],env:{PATH:process.env.PATH,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:path.join(folder,'data'),DATABASE_URL:'',REDIS_URL:'',STORAGE_BACKEND:'json',STRUCTURED_WRITES:'true',ADMIN_USERNAME:'fixture_admin',ADMIN_PASSWORD:password,SCREEN_MEDIA_AUTH_SECRET:crypto.randomBytes(32).toString('hex'),PUBLIC_BASE_URL:base,WINDOWS_AGENT_ONLINE_SECONDS:'300',LOOKUP_AI_VISION_ENABLED:'false'}});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/readyz',{signal:AbortSignal.timeout(500)})).ok)return;}catch{}if(server.exitCode!==null)throw Error('fixture_start_failed');await new Promise(r=>setTimeout(r,30));}throw Error('fixture_start_timeout');
};
const stop=async()=>{if(server&&server.exitCode===null&&server.signalCode===null){
  try{const done=once(server,'exit',{signal:AbortSignal.timeout(3000)});server.kill();await done;}
  catch{if(server.exitCode===null&&server.signalCode===null){const done=once(server,'exit',{signal:AbortSignal.timeout(1000)});server.kill('SIGKILL');await done;}}
}};
async function request(route,token,{method='GET',body,expected=200}={}){
  const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},redirect:'error',signal:AbortSignal.timeout(5000),...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(response.status!==expected)throw Error('fixture_http_'+response.status+'_'+(typeof value.error==='string'&&/^[a-z0-9_]+$/.test(value.error)?value.error:'unexpected'));
  return value;
}
try{
  await start();stage='register_fixture';
  const admin=(await request('/api/v1/auth/login','',{method:'POST',body:{username:'fixture_admin',password}})).session.token;
  const agentId='fixture-'+crypto.randomUUID();
  const token=(await request('/api/v1/windows-agents',admin,{method:'POST',expected:201,body:{agentId,agentName:'Local pipe fixture'}})).token;
  const mapping=JSON.parse(await fs.readFile(path.join(agentRoot,'windows-agent/scripts/wecom_preview_devices.json'),'utf8'))['43'];
  await request(`/api/v1/windows-agents/${agentId}/devices/sync`,token,{method:'POST',body:{agent:{agentId},devices:[{adbSerial:mapping.serial,state:'device',model:'Local fixture only'}]}});
  const deviceId='adb:'+mapping.serial;
  await request('/api/v1/devices/'+encodeURIComponent(deviceId),admin,{method:'PUT',body:{deviceName:'43',listingStatus:'listed'}});
  const external='/api/v1/wecom/customer-invitations';
  stage='submit_original';
  const submitted=await request(external,admin,{method:'POST',expected:202,body:{deviceNumber:43,appSlot:'main',phoneNumber:'13900000000',remarkName:'QA'}});
  const next=`/api/v1/windows-agents/${agentId}/tasks/next?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1`;
  const task=(await request(next,token)).task;assert.equal(task.type,'wecom_customer_preview');assert.ok(task.payload.physicalCleanup);
  assert.equal((await request(`/api/v1/windows-agents/${agentId}/wecom-preview-tasks/${task.taskId}/lease`,token)).valid,false);
  const fixtureDir=path.join(folder,'fixture-agent');await fs.mkdir(path.join(fixtureDir,'scripts'),{recursive:true});
  const business=`import sys,os,json,time,datetime,psutil
created=psutil.Process().create_time()
host={'role':'reader','pid':os.getpid(),'createdAt':datetime.datetime.fromtimestamp(created,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),'creationToken':created.hex(),'machineId':'a'*64}
print('WECOM_PHYSICAL_READY '+json.dumps({'version':1,'hosts':[host]}),file=sys.stderr,flush=True)
value=json.loads(sys.stdin.readline())
print(json.dumps({'previewStatus':'blocked','previewCode':'preview_cleanup_unconfirmed','invitationSent':False,'sendStatus':'not_attempted','remarkSaveStatus':'not_attempted','diagnostic':{'wecomExecution':{'version':1,'phase':'cleanup','failurePhase':'home_navigation','elapsedMs':1000,'cleanupConfirmed':False,'events':[{'version':1,'step':1,'phase':'cleanup','state':'end','elapsedMs':1000,'cleanupConfirmed':False}]}}}),flush=True)
time.sleep(.2)
`;
  const verify=`import sys,json,time,datetime
value=json.loads(sys.stdin.readline())
assert value['pickedAt']
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
frames=[]
for _ in range(2):
 frames.append({'observedAt':stamp(),'packagesAbsent':True,'packageNames':['com.netease.open.pocoservice','com.netease.open.pocoservice.test'],'serialForwardCount':0})
 time.sleep(.25)
proof={'binding':value['physicalCleanup'],'verificationId':value['verificationId'],'verificationNonce':value['verificationNonce'],'verificationTaskId':value['verificationTaskId'],'snapshots':frames}
print(json.dumps({'ok':True,'proof':proof}),flush=True)
time.sleep(.1)
`;
  await fs.writeFile(path.join(fixtureDir,'scripts/wecom_platform_preview.py'),business);
  await fs.writeFile(path.join(fixtureDir,'scripts/wecom_cleanup_verify.py'),verify);
  const {runWecomPreviewTask}=await import(pathToFileURL(path.join(agentRoot,'windows-agent/src/wecom-preview-task.mjs')));
  const {physicalBinding,createCleanupRequest}=await import(pathToFileURL(path.join(agentRoot,'windows-agent/src/wecom-cleanup-protocol.mjs')));
  const {handleWecomCleanupVerification}=await import(pathToFileURL(path.join(agentRoot,'windows-agent/src/wecom-cleanup-verify.mjs')));
  const config={agentId,agentToken:token,serverBaseUrl:base,pythonCommand};
  let proofPosts=0,verifyStatusPosts=0,captureCalls=0,scanCalls=0,hostPosts=0,closePosts=0;
  const hostHashes=[],closeHashes=[];
  const sameHash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const cleanupRequest=createCleanupRequest(config);
  const context=vm.createContext({Buffer,config,agentDir:fixtureDir,physicalBinding,
    runWecomPreviewTask:(t,options)=>runWecomPreviewTask(t,{...options,cleanupRequest:async(route,opt)=>{
      if(route.endsWith('/host')){hostPosts++;hostHashes.push(sameHash(opt.body));if(faultMode==='host-network-and-close-ack'&&hostPosts===1)throw Object.assign(Error('fixture_not_delivered'),{deliveryUnknown:true});}
      if(route.endsWith('/host-closed')){closePosts++;closeHashes.push(sameHash(opt.body));}
      const result=await cleanupRequest(route,opt);
      if(faultMode==='host-network-and-close-ack'&&route.endsWith('/host-closed')&&closePosts===1)throw Object.assign(Error('fixture_close_ack_lost'),{deliveryUnknown:true});
      return result;
    }}),
    log:()=>{},api:async(route,options={})=>{if(route.includes('/windows-agent-tasks/')&&route.endsWith('/status')&&context.currentVerification===route.split('/').at(-2))verifyStatusPosts++;return request(route,token,options);},
    handleWecomCleanupVerification:(t,options)=>handleWecomCleanupVerification(t,{...options,cleanupRequest:async(route,opt)=>{
      const result=await cleanupRequest(route,opt);
      if(route.endsWith('/proof')){proofPosts++;if(proofPosts===1||faultMode==='proof-ack-always')throw Object.assign(Error('fixture_lost_ack'),{deliveryUnknown:true});}
      return result;
    }}),
    isAutomationTaskCancellation:()=>false,isScreenPriorityCancellation:()=>false,
    captureFailureEvidence:()=>{captureCalls++;throw Error('forbidden_evidence');},shouldRunPostTaskDeviceScan:()=>{scanCalls++;throw Error('forbidden_scan');},scanAndSync:()=>{scanCalls++;throw Error('forbidden_scan');},compactScreenshotForTransport:v=>v});
  const source=await fs.readFile(path.join(agentRoot,'windows-agent/src/index.mjs'),'utf8');
  for(const name of ['normalizeEvidenceForTransport','compactEventDetail','compactTaskResultForEvent','compactTaskResultForStatus','taskFailureResult','taskEvent','taskStatus','taskWecomPreview','runTask']){
    const m=source.match(new RegExp('^(?:async )?function '+name+'\\([\\s\\S]*?^\\}','m'));assert.ok(m);vm.runInContext(m[0],context);
  }
  stage='actual_product_original_pipe';await context.runTask(task);
  const before=await request(external+'/'+submitted.taskId,admin);assert.equal(before.status,'failed');
  stage='pending_blocks_same_device';
  await request(external,admin,{method:'POST',expected:409,body:{deviceNumber:43,appSlot:'main',phoneNumber:'13900000001',remarkName:'QA'}});
  let inventory=await request('/api/v1/wecom/devices',admin);assert.equal(inventory.devices.find(d=>String(d.deviceNumber)==='43').available,false);
  stage='real_json_restart';await stop();await start();
  const unchanged=await request(external+'/'+submitted.taskId,admin);assert.equal(unchanged.status,before.status);assert.equal(unchanged.code,before.code);
  stage='persistent_auto_verify_dispatch';const verification=(await request(next,token)).task;assert.equal(verification.type,'wecom_cleanup_verify');assert.ok(verification.pickedAt);assert.equal(verification.payload.pickedAt,'');context.currentVerification=verification.taskId;
  stage='actual_product_verification_pipe_and_lost_proof_ack';
  const result=await context.runTask(verification);assert.equal(result.verified,faultMode!=='proof-ack-always');assert.equal(proofPosts,2);
  if(faultMode==='proof-ack-always'){assert.equal(result.pending,true);assert.equal(result.code,'wecom_cleanup_proof_ack_unknown');}
  if(faultMode==='host-network-and-close-ack'){assert.equal(hostPosts,2);assert.equal(closePosts,2);assert.equal(new Set(hostHashes).size,1);assert.equal(new Set(closeHashes).size,1);}
  const cloudVerification=await request('/api/v1/windows-agent-tasks/'+verification.taskId,admin);assert.equal(cloudVerification.task.status,'succeeded');assert.equal(verifyStatusPosts,0);assert.equal(captureCalls,0);assert.equal(scanCalls,0);
  stage='original_result_preserved_and_device_reopens';
  const after=await request(external+'/'+submitted.taskId,admin);assert.equal(after.status,before.status);assert.equal(after.code,before.code);
  inventory=await request('/api/v1/wecom/devices',admin);assert.equal(inventory.devices.find(d=>String(d.deviceNumber)==='43').available,true);
  await request(external,admin,{method:'POST',expected:202,body:{deviceNumber:43,appSlot:'main',phoneNumber:'13900000001',remarkName:'QA'}});
  const receipt={passed:true,faultMode,localVerifyAcknowledged:result.verified,cloudVerificationStatus:cloudVerification.task.status,hostPosts,closePosts,hostBodiesUnchanged:new Set(hostHashes).size===1,closeBodiesUnchanged:new Set(closeHashes).size===1,actualPlatformHttp:true,actualProductAgentFunctions:true,realOsPipes:true,syntheticMachineAndToolFacts:true,windowsSystemAcceptance:false,phoneActions:0,proofPosts,verifyStatusPosts,captureCalls,scanCalls,jsonRestart:true,unknownBlocked:true,originalBusinessUnchanged:true,newTaskAcceptedOnlyAfterProof:true};
  await fs.writeFile(path.join(folder,'sanitized-receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});console.log(JSON.stringify({...receipt,evidence:folder}));
}catch(error){await fs.writeFile(path.join(folder,'sanitized-failure.json'),JSON.stringify({passed:false,stage,code:/^[a-z0-9_]+$/.test(error.message||'')?error.message:'fixture_assertion_failed'}),{mode:0o600});console.log(JSON.stringify({passed:false,stage,evidence:folder}));process.exitCode=1;}
finally{await stop();await log.close();}
