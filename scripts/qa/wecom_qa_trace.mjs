import {wecomExecution,wecomProgress} from '../../windows-agent/src/wecom-diagnostics.mjs';
const allowed=new Set(['adb.identity','adb.connect','adb.command','adb.shell','adb.host','adb.receive','adb.socket_connect',
  'lease.read','foreground.read','poco.health','rpc.import','rpc.client','rpc.agent','rpc.send','rpc.freeze','rpc.transport',
  'hierarchy.snapshot','hierarchy.snapshot_any','ui.observed_click','ui.startup_action','ui.return_back','ui.action','cleanup.reader',
  'qa.host_identity','qa.inventory','qa.proof_request',
  ...['open_menu','open_add','open_search','enter_phone','search','open_preview','open_remark','fill_remark','fill_description','save_remark','close_remark'].map(v=>'ui.'+v),
  ...['dump','dumpHierarchy','select','getAttr','setAttr','click','longClick','swipe','keyevent','getPortSize','setText','getScreen'].map(v=>'rpc.'+v)]);
const integer=v=>Number.isSafeInteger(v)&&v>=0&&v<=1000000;
const keys=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>names.includes(k));
const token=(v,empty=false)=>typeof v==='string'&&(empty&&v===''||/^[1-9]\d{0,30}$/.test(v));
export function safeResources(v){
  if(!keys(v,['readerStarted','pid','startToken','forwards','cleanupConfirmed'])||typeof v.readerStarted!=='boolean'
    ||!token(v.pid,true)||!token(v.startToken,true)||![true,false,null].includes(v.cleanupConfirmed)
    ||!Array.isArray(v.forwards)||v.forwards.length>2||v.forwards.some(p=>!Array.isArray(p)||p.length!==2||!Number.isInteger(p[0])||p[0]<1||p[0]>65535||![10080,10081].includes(p[1])))return null;
  return {readerStarted:v.readerStarted,pid:v.pid,startToken:v.startToken,forwards:v.forwards,cleanupConfirmed:v.cleanupConfirmed};
}
export function safeCallRecord(v){
  if(!keys(v,['version','elapsedMs','kind','id','call','state','errorClass','durationMs','event','activeCalls','threads','resources','record'])||v.version!==1||!integer(v.elapsedMs))return null;
  const base={version:1,elapsedMs:v.elapsedMs,kind:v.kind};
  if(v.kind==='tail'&&['call','lifecycle','resources','stack'].includes(v.record?.kind)){const record=safeCallRecord(v.record);return record?{...base,record}:null;}
  if(v.kind==='call'&&integer(v.id)&&allowed.has(v.call)&&['begin','end','error'].includes(v.state))return {...base,id:v.id,call:v.call,state:v.state,
    ...(integer(v.durationMs)?{durationMs:v.durationMs}:{}),...(v.state==='error'?{errorClass:['SafeStop','StopPreview','TimeoutError','OSError','ReadTimeout','ConnectTimeout','ConnectionError','RpcTimeoutException','TransportDisconnected','RpcDeliveryUnknown','RuntimeError','ValueError','Exception','PermissionError','FileNotFoundError','JSONDecodeError','HTTPError','URLError','AccessDenied','NoSuchProcess','ConnectionResetError','ConnectionAbortedError'].includes(v.errorClass)?v.errorClass:'other'}:{})};
  if(v.kind==='lifecycle'&&['before_final_json','final_json_flushed'].includes(v.event))return {...base,event:v.event};
  if(v.kind==='resources'){const resources=safeResources(v.resources);return resources?{...base,resources}:null;}
  if(v.kind==='stack'&&Array.isArray(v.activeCalls)&&v.activeCalls.length<=12&&Array.isArray(v.threads)&&v.threads.length<=8){
    if(v.activeCalls.some(c=>!keys(c,['id','call'])||!integer(c.id)||!allowed.has(c.call)))return null;
    const threads=[];
    for(const t of v.threads){
      if(!keys(t,['role','daemon','alive','stack'])||!['main','control','diagnostic','other'].includes(t.role)||typeof t.daemon!=='boolean'||typeof t.alive!=='boolean'||!Array.isArray(t.stack)||t.stack.length>12)return null;
      const stack=[];
      for(const f of t.stack){if(!keys(f,['module','function','line'])||typeof f.module!=='string'||f.module.length>100||! /^(?:wecom_|poco\.|hrpc\.|requests\.|urllib3\.|urllib\.|importlib\.|_frozen_importlib|__main__$|threading$|socket$|ssl$|subprocess$)/.test(f.module)||! /^[A-Za-z0-9_.<>]{1,100}$/.test(f.function)||!integer(f.line))return null;stack.push({module:f.module,function:f.function,line:f.line});}
      threads.push({role:t.role,daemon:t.daemon,alive:t.alive,stack});
    }
    return {...base,activeCalls:v.activeCalls.map(c=>({id:c.id,call:c.call})),threads};
  }
  return null;
}
export function safeNativeResult(v){
  if(!v||!['blocked','ready_before_send'].includes(v.previewStatus)||v.invitationSent!==false||! /^[a-z0-9_]{1,100}$/.test(v.previewCode||''))return null;
  const execution=wecomExecution(v.diagnostic?.wecomExecution),resources=safeResources(v.isolation?.resources);
  return {previewStatus:v.previewStatus,previewCode:v.previewCode,invitationSent:false,sendStatus:'not_attempted',
    remarkSaveStatus:['not_attempted','unknown','confirmed','not_needed'].includes(v.remarkSaveStatus)?v.remarkSaveStatus:'unknown',
    diagnostic:{wecomExecution:execution},isolation:{mode:'real_screen_reservation',productionWindowsTask:false,resources,primaryFailure:/^[a-z][a-z0-9_]{0,99}$/.test(v.isolation?.primaryFailure||'')?v.isolation.primaryFailure:null,authorityFailure:/^qa_(?:lease_denied|proof_nonce_changed|lease_identity_changed|proof_stale|lease_not_exclusive|inventory_stale|inventory_ambiguous|inventory_identity_changed|inventory_not_owned_reservation|send_forbidden|config_changed|operation_changed|authority_purpose_changed|proof_too_large|agent_identity_changed|adb_listener_changed|adb_identity_changed|authority_proof_unavailable|authority_json_invalid|authority_file_missing|authority_file_denied|authority_host_inspection|authority_http_denied|authority_connection|authority_timeout|authority_os_error|authority_unknown)$/.test(v.isolation?.authorityFailure||'')?v.isolation.authorityFailure:null,authorityFailureStage:['configuration','host_identity','inventory_read','proof_request','proof_parse','proof_validate'].includes(v.isolation?.authorityFailureStage)?v.isolation.authorityFailureStage:null}};
}
export {wecomProgress};
