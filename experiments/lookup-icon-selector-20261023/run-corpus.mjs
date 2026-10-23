// Local saved-image evaluation; no phone adapter is imported.
import fs from 'node:fs/promises';
import {prepareFrame,selectClose,MODEL} from './selector.mjs';
const [manifestPath,inventoryPath,out]=process.argv.slice(2);
if(!manifestPath||!inventoryPath||!out||!process.env.LOOKUP_AI_VISION_API_KEY||!process.env.LOOKUP_AI_VISION_BASE_URL)throw Error('Missing private manifests/output or in-memory model configuration');
const inputs=JSON.parse(await fs.readFile(manifestPath,'utf8')),inventory=JSON.parse(await fs.readFile(inventoryPath,'utf8'));
const expected=new Map(inventory.map(x=>[x.id,x]));const results=[];let next=0;let saving=Promise.resolve();
const config={enabled:true,apiKey:process.env.LOOKUP_AI_VISION_API_KEY,baseUrl:process.env.LOOKUP_AI_VISION_BASE_URL,timeoutMs:120000};
async function worker(){while(next<inputs.length){const input=inputs[next++],e=expected.get(input.label);if(!e)throw Error('Unknown case');const started=Date.now();let result;
 try{if(input.candidates.length===0)result={action:'no_action',reason:'no_candidates'};
 else{const frame=prepareFrame({image:await fs.readFile(input.raw),annotated:await fs.readFile(input.annotated),width:input.width,height:input.height,candidates:input.candidates,binding:{deviceId:input.label,taskId:'offline-corpus',generation:'local-only'}});result=await selectClose(frame,config);}}
 catch{result={action:'no_action',reason:'local_error'};}
 let passed=false;
 if(e.expectedAction==='close'&&result.action==='close'){
  const [x,y,r,b]=e.expectedCloseRegion,[cx,cy]=result.point;passed=cx>=x&&cx<=r&&cy>=y&&cy<=b;
 }else if(e.expectedAction==='no_action'&&result.action==='no_action')passed=['none','protected','uncertain','no_candidates'].includes(result.reason);
 results.push({id:input.label,synthetic:e.synthetic,expected:e.expectedAction,passed,elapsedMs:Date.now()-started,candidateCount:input.candidates.length,model:MODEL,...result,phoneActions:0});
 const snapshot=JSON.stringify([...results].sort((a,b)=>a.id.localeCompare(b.id)),null,2);saving=saving.then(()=>fs.writeFile(out,snapshot,{mode:0o600}));await saving;
 console.log(input.label,passed?'PASS':'FAIL',result.action,result.candidateId||result.reason,Date.now()-started);
}}
await Promise.all([worker(),worker()]);await saving;
console.log(JSON.stringify({total:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,phoneActions:0}));
