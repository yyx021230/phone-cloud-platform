// Saved model decisions -> current guards -> injected tap recorder. No HTTP/ADB.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {prepareFrame,validateChoice,executeSelection} from './selector.mjs';
const root=process.argv[2];assert.ok(root,'Private corpus directory required');
const report=JSON.parse(await fs.readFile(path.join(root,'CORPUS_RESULTS.json')));
const inputHashes=JSON.parse(await fs.readFile(path.join(root,'pre-fix-input-hashes.json')));
const inputs=new Map();for(const name of ['first/inputs.json','rest/inputs.json','retry-inputs.json'])for(const row of JSON.parse(await fs.readFile(path.join(root,name))))inputs.set(row.label,row);
let proposed=0,rejectedMappings=0,staleRejected=0;
for(const c of report.cases){
 const row=inputs.get(c.id);assert.ok(row);
 const image=await fs.readFile(row.raw),annotated=await fs.readFile(row.annotated);
 assert.equal(crypto.createHash('sha256').update(image).digest('hex'),inputHashes[c.id].raw);
 if(c.id!=='s046'){assert.equal(crypto.createHash('sha256').update(annotated).digest('hex'),inputHashes[c.id].annotated);assert.deepEqual(row.candidates,inputHashes[c.id].candidates);}
 if(c.result.action!=='close'){assert.equal(c.expectedAction,'no_action');continue;}
 const binding={deviceId:c.id,taskId:'offline-replay',generation:'synthetic-only'};
 const make=()=>prepareFrame({...row,image,annotated,binding});const frame=make();
 const v=c.result.action==='close'?validateChoice({frameId:frame.frameId,action:'close',candidateId:c.result.candidateId,overlayType:c.result.overlayType},frame):{action:'no_action'};
 assert.equal(v.action,c.expectedAction);
 if(v.action!=='close')continue;
 assert.deepEqual(v.box,c.result.box);assert.deepEqual(v.point,c.result.point);
 const [x,y,r,b]=v.box;assert.ok(v.point[0]>x&&v.point[0]<r&&v.point[1]>y&&v.point[1]<b);
 const run=async(geometry,mutate=false)=>{
  const f=make(),taps=[];let reads=0;const current=Buffer.from(image);if(mutate)current[current.length-1]^=1;
  const result=await executeSelection(f,{...v,frameId:f.frameId},{withDeviceLock:async(_,fn)=>fn(),observe:async()=>reads++?{binding,protected:false,foreground:'alipay',expectedPage:true,overlayGone:true}:{binding,protected:false,foreground:'alipay',image:current,inputGeometry:geometry},tap:async point=>taps.push(point)});
  return {result,taps};
 };
 const geometry={width:row.width,height:row.height,rotation:0,coordinateSpace:'native-screen'};
 const ok=await run(geometry);assert.equal(ok.result.resume,true);assert.deepEqual(ok.taps,[v.point]);proposed++;
 for(const g of [null,{...geometry,width:Math.floor(row.width/2),height:Math.floor(row.height/2)},{...geometry,rotation:1},{...geometry,coordinateSpace:'css'}]){const bad=await run(g);assert.equal(bad.taps.length,0);rejectedMappings++;}
 const changed=await run(geometry,true);assert.equal(changed.taps.length,0);staleRejected++;
}
console.log(JSON.stringify({savedDecisions:report.cases.length,recordedSyntheticTaps:proposed,noAction:report.cases.length-proposed,rejectedMappings,staleRejected,realModelCalls:0,realPhoneActions:0,productionChanges:0}));
