import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const source=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
const fn=name=>source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`,'m'))[0];
function fixture({readsFail=false}={}){
 const calls=[],statuses=[],events=[];
 const error=Object.assign(Error('original reader cleanup failed'),{code:'lookup_reader_cleanup_unconfirmed',diagnostic:{runnerReason:'original',lookupExecution:{version:1,scope:'agent_command',durationMs:231,readerRebuildAttempts:1,appRestartAttempts:0,resultResumeAttempts:0}}});
 const deps={log:()=>{},config:{adbPath:'synthetic'},
  adb:async(_s,args)=>{calls.push(args);if(readsFail)throw Error('read timeout');return args.includes('uiautomator')?'<hierarchy/>':'mCurrentFocus=Window{fixture com.eg.android.AlipayGphone/.Search}';},
  runBuffer:async(_cmd,args)=>{calls.push(args.slice(2));if(readsFail)throw Error('screenshot timeout');return Buffer.from('synthetic-image');},
  packageNameFromFocusLines:()=> 'com.eg.android.AlipayGphone',normalizeUiHierarchyDump:x=>x,
  buildScreenshotEvidence:async(_s,png)=>({dataUrl:'data:image/png;base64,'+png.toString('base64'),mimeType:'image/png'}),
  lookupStatusOutbox:{isAvailable:()=>true},taskEvent:async(_t,phase,_level,_message,result)=>{if(phase==='finish')events.push(result);},
  taskStatus:async(_t,status,result)=>statuses.push({status,result}),taskAlipayNameLookupWithAccounts:async()=>{throw error;},
  taskXhsPublish:async()=>{throw error;},isAutomationTaskCancellation:()=>false,isScreenPriorityCancellation:()=>false,
  compactTaskResultForEvent:x=>x,shouldRunPostTaskDeviceScan:()=>false};
 const execute=new Function(...Object.keys(deps),fn('captureFailureEvidence')+'\n'+fn('taskFailureResult')+'\n'+fn('runTask')+';return {runTask,captureFailureEvidence};')(...Object.values(deps));
 return {...execute,calls,statuses,events,error};
}
for(const type of ['alipay_name_start','alipay_name_query','alipay_name_switch'])test('actual failed '+type+' keeps screenshot and original error without starting XML reader',async()=>{
 const h=fixture();await h.runTask({taskId:'original',type,adbSerial:'synthetic'});
 assert.equal(h.calls.length,2);assert.ok(!h.calls.some(x=>x.includes('uiautomator')));
 assert.equal(h.statuses[0].status,'failed');assert.ok(h.statuses[0].result.screenshot);assert.equal(h.statuses[0].result.uiHierarchy,undefined);
 assert.deepEqual(h.statuses[0].result.diagnostic,h.error.diagnostic);assert.equal(h.statuses[0].result.durationMs,231);assert.equal(h.statuses[0].result.errorCode,h.error.code);
 assert.deepEqual(h.events[0],h.statuses[0].result);
});
test('actual runTask stop failure performs no extra phone commands and retains failed cleanup proof',async()=>{
 const h=fixture();await h.runTask({taskId:'stop',type:'alipay_name_stop',adbSerial:'synthetic'});assert.deepEqual(h.calls,[]);
 assert.equal(h.statuses[0].status,'failed');assert.equal(h.statuses[0].result.errorCode,'lookup_reader_cleanup_unconfirmed');assert.deepEqual(h.statuses[0].result.diagnostic,h.error.diagnostic);
});
test('screenshot or focus timeout cannot replace the original lookup failure or trigger XML fallback',async()=>{
 const h=fixture({readsFail:true});await h.runTask({taskId:'query',type:'alipay_name_query',adbSerial:'synthetic'});
 assert.equal(h.calls.length,2);assert.equal(h.statuses[0].result.errorCode,h.error.code);assert.equal(h.statuses[0].result.screenshot,undefined);assert.deepEqual(h.statuses[0].result.diagnostic,h.error.diagnostic);
});
test('non-lookup failure retains its existing focus, XML and screenshot evidence',async()=>{
 const h=fixture();await h.runTask({taskId:'publish',type:'xhs_publish',adbSerial:'synthetic'});
 assert.equal(h.calls.length,3);assert.ok(h.calls.some(x=>x.includes('uiautomator')));assert.equal(h.statuses[0].result.uiHierarchy,'<hierarchy/>');
});
