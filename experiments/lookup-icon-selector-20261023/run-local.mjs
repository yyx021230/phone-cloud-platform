// Explicit offline-image model evaluation. Does not import executeSelection.
import fs from 'node:fs/promises';
import {prepareFrame,selectClose,MODEL} from './selector.mjs';
const [manifestPath,out]=process.argv.slice(2);
if(!manifestPath||!out||!process.env.LOOKUP_AI_VISION_API_KEY||!process.env.LOOKUP_AI_VISION_BASE_URL)throw Error('Need input manifest, private output path and existing model config in environment');
const inputs=JSON.parse(await fs.readFile(manifestPath,'utf8')),results=[];
for(const input of inputs){
 const frame=prepareFrame({image:await fs.readFile(input.raw),annotated:await fs.readFile(input.annotated),width:input.width,height:input.height,candidates:input.candidates,binding:{deviceId:input.label,taskId:'offline-evaluation',generation:'local-only'}});
 const started=Date.now();const result=await selectClose(frame,{enabled:true,apiKey:process.env.LOOKUP_AI_VISION_API_KEY,baseUrl:process.env.LOOKUP_AI_VISION_BASE_URL,timeoutMs:120000});
 results.push({label:input.label,model:MODEL,elapsedMs:Date.now()-started,...result,phoneActions:0});await fs.writeFile(out,JSON.stringify(results,null,2),{mode:0o600});console.log(input.label,result.action,result.candidateId||result.reason,Date.now()-started);
}
