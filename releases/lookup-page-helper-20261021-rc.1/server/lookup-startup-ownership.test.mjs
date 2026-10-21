import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
async function run(oldOrder=false){
 const state={deviceLocks:[{status:'active',deviceId:'reserved',managedLookupGeneration:'g',expiresAt:'2020-01-01T00:00:00Z'}, {status:'active',deviceId:'unreserved',expiresAt:'2020-01-01T00:00:00Z'}],xhsQrTasks:[]};
 const noop=()=>{};
 const context={state,Date,Set,WeakSet,process:{env:{MANAGED_NAME_LOOKUP_ENABLED:'true'}},NODE_ENV:'test',structuredRepos:null,STORAGE_BACKEND:'json',DATA_DIR:'fixture',POSTGRES_STATE_KEY:'fixture',path:{join:()=> 'fixture'},boolEnv:()=>true,
  ensureBootstrapAdmin:async()=>{},enforceStrictProductionConfig:noop,createManagedLookupStore:async()=>({}),createManagedLookupAdapter:()=>({}),createManagedLookupService:()=>({reserved:id=>id==='reserved'}),OPEN_NAME_LOOKUP_CLIENTS:new Map(),nowIso:()=>new Date().toISOString(),toTime:Date.parse,releaseRuntimeDeviceLock:noop};
 for(const key of ['saveState','isDeviceListed','isAdbOnline','activeDeviceLockForTask','resumableLookupRecoveryResult','createLookupSession','createAutomationJob','acquireAutomationDeviceLock','queueAutomationWindowsTask','upsertLookupResult','cancelAutomationJob','resumeLookupAfterObservedHumanVerification'])context[key]=noop;
 context.WINDOWS_AGENT_ONLINE_MS=120000;
 let startup=section('let managedLookup = null;','const managedLookupTimer=');
 if(oldOrder)startup=startup.replace('await logStartupDiagnostics();','').replace("if (boolEnv", "await logStartupDiagnostics();\nif (boolEnv");
 await vm.runInNewContext('(async()=>{'+section('function expireDeviceLocks()', 'function publicDeviceLock(')+'\nasync function logStartupDiagnostics(){expireDeviceLocks();}\n'+startup+'})()',context);
 return state.deviceLocks.map(l=>l.status);
}
test('actual bootstrap order preserves restored managed locks before diagnostics; unrelated expiry remains',async()=>{
 assert.deepEqual(await run(true),['expired','expired']);
 assert.deepEqual(await run(),['active','expired']);
});
