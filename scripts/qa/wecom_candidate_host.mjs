// Explicit one-job staging host. No shared Agent entry or polling loop is started.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {once} from 'node:events';
import {safeCallRecord,safeNativeResult,wecomProgress} from './wecom_qa_trace.mjs';
import {runWecomPreviewTask} from '../../windows-agent/src/wecom-preview-task.mjs';

let pending='';
for await(const bytes of process.stdin){pending+=bytes.toString('utf8');if(pending.includes('\n'))break;if(pending.length>131072)throw Error('qa_host_input_too_large');}
const input=JSON.parse(pending.split('\n')[0]);
const {task,config,reservation}=input,stage=path.resolve(import.meta.dirname,'../..');
if(task.type!=='wecom_customer_preview'||task.payload.mode!=='preview'||task.payload.previewOnly!==true
    ||reservation.taskId!==task.taskId||!String(stage).replaceAll('\\','/').includes('/staging/wecom-qa-'))throw Error('qa_host_scope_invalid');
const journal=fs.openSync(path.join(stage,'qa-events.jsonl'),'a',0o600),start=performance.now();
const record=value=>fs.writeSync(journal,JSON.stringify({atMs:Math.round(performance.now()-start),...value})+'\n');
let native,closedPromise,nativeFinal,firstJsonAt=null,closedAt=null,lastResources=null;
async function broker(route,body){
  const r=await fetch(reservation.brokerUrl+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+reservation.brokerToken},
    body:JSON.stringify({taskId:task.taskId,...body}),redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw Error('qa_broker_request_denied');return r.json();
}
function spawnNative(command,args,options){
  native=spawn(command,[path.join(stage,'windows-agent/scripts/wecom_standalone_preview.py')],options);
  closedPromise=new Promise(resolve=>native.once('close',(code,signal)=>resolve([code,signal]))).then(([code,signal])=>{closedAt=performance.now()-start;record({kind:'child_close',pid:native.pid,code,signal});return {code,signal};});
  record({kind:'child_spawn',pid:native.pid});
  native.on('error',()=>record({kind:'child_error'}));
  let output='',stderr='';
  native.stdout.on('data',bytes=>{
    if(output.length<65536)output+=bytes.toString('utf8');
    if(firstJsonAt===null&&output.includes('\n')){
      try{const j=safeNativeResult(JSON.parse(output.trim()));if(j){
        nativeFinal=j;lastResources=j.isolation?.resources||lastResources;firstJsonAt=performance.now()-start;
        record({kind:'final_json_observed',code:j.previewCode,cleanupConfirmed:j.diagnostic?.wecomExecution?.cleanupConfirmed});
      }}catch{}
    }
  });
  native.stderr.on('data',bytes=>{
    stderr+=bytes.toString('utf8');
    const lines=stderr.split('\n');stderr=lines.pop();if(stderr.length>16384)stderr='';
    for(const line of lines){
      const prefix=line.startsWith('WECOM_CALL ')?'WECOM_CALL ':line.startsWith('WECOM_DIAGNOSTIC ')?'WECOM_DIAGNOSTIC ':null;
      if(!prefix||line.length>16384)continue;
      try{const parsed=JSON.parse(line.slice(prefix.length));const j=prefix==='WECOM_CALL '?safeCallRecord(parsed):wecomProgress(parsed);if(j){record({kind:'native_diagnostic',channel:prefix.trim(),detail:j});if(j.kind==='resources')lastResources=j.resources;}}catch{}
    }
  });
  const realInput=native.stdin,shim=new PassThrough();let first=true,buffer='';
  shim.on('data',bytes=>{
    if(!first){realInput.write(bytes);return;}
    buffer+=bytes.toString('utf8');const newline=buffer.indexOf('\n');if(newline<0)return;
    const payload=JSON.parse(buffer.slice(0,newline));
    realInput.write(JSON.stringify({task:payload,reservation})+'\n');first=false;
    if(buffer.length>newline+1)realInput.write(buffer.slice(newline+1));buffer='';
  });
  shim.on('end',()=>realInput.end());realInput.on('error',()=>shim.emit('error',Error('qa_native_input_failed')));
  native.stdin=shim;return native;
}
const source=JSON.parse(fs.readFileSync(path.join(stage,'agent-functions.json'),'utf8'));
const context=vm.createContext({Buffer,log:()=>{},
  api:async(route,options)=>{
    const matched=route.match(/^\/api\/v1\/windows-agent-tasks\/([^/]+)\/(status|events)$/);
    if(!matched||matched[1]!==task.taskId)throw Error('qa_status_scope_invalid');
    // The original wrapper may reject after a failed kill. Keep the REAL
    // reservation and local status open until the OS has observed child close.
    if(matched[2]==='status'&&closedPromise)await closedPromise;
    return broker('/report',{kind:matched[2],body:options.body});
  },
  taskWecomPreview:t=>runWecomPreviewTask(t,{config,agentDir:path.join(stage,'windows-agent'),spawnChild:spawnNative}),
  isAutomationTaskCancellation:()=>false,isScreenPriorityCancellation:()=>false,
  captureFailureEvidence:()=>{throw Error('qa_second_reader_forbidden');},
  shouldRunPostTaskDeviceScan:()=>{throw Error('qa_global_scan_forbidden');},
  compactScreenshotForTransport:v=>v
});
for(const name of ['normalizeEvidenceForTransport','compactEventDetail','compactTaskResultForEvent','compactTaskResultForStatus','taskFailureResult','taskEvent','taskStatus','runTask']){
  if(typeof source[name]!=='string')throw Error('qa_agent_source_missing');vm.runInContext(source[name],context);
}
try {
  await context.runTask(task);
  if(closedPromise)await closedPromise;
  record({kind:'host_result_ready',childExited:closedAt!==null,cleanupConfirmed:nativeFinal?.diagnostic?.wecomExecution?.cleanupConfirmed??false});
  console.log(JSON.stringify({childExited:closedAt!==null,firstJsonAtMs:firstJsonAt,childCloseAtMs:closedAt,nativePid:native?.pid??null,
    nativeResult:nativeFinal||null,resources:lastResources,productionAgent:false}));
} finally {fs.closeSync(journal);}
