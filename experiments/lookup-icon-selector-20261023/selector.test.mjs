import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';
import {prepareFrame,validateChoice,selectClose,executeSelection,MODEL} from './selector.mjs';
const image=()=>{const b=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(720,16);b.writeUInt32BE(1600,20);return b;};
const binding={deviceId:'synthetic-device',taskId:'synthetic-task',generation:'g1'};
const input=()=>({image:image(),annotated:image(),width:720,height:1600,candidates:[{id:'b0',box:[330,1220,390,1280]},{id:'b1',box:[630,1360,680,1410]},{id:'b2',box:[100,450,630,1150]}],binding});
const choice=f=>({frameId:f.frameId,action:'close',candidateId:'b0',overlayType:'advertisement'});
const cfg={enabled:true,apiKey:'synthetic-test-key',baseUrl:'http://127.0.0.1',timeoutMs:200};
const body=value=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const response=value=>new Response(JSON.stringify(body(value)));
for(const [name,change] of [ ['bad PNG',x=>x.image=Buffer.from('bad')],['wrong size',x=>x.width=800],['NaN',x=>x.candidates[0].box[0]=NaN],['outside image',x=>x.candidates[0].box[2]=999],['duplicate ID',x=>x.candidates[1].id='b0'],['missing task',x=>x.binding={deviceId:'d'}]])test('frame rejects '+name,()=>{let x=input();change(x);assert.throws(()=>prepareFrame(x));});
test('choice returns original detection center and does not accept model coordinates',()=>{const f=prepareFrame(input());assert.deepEqual(validateChoice(choice(f),f).point,[360,1250]);assert.equal(validateChoice({...choice(f),point:[999,999]},f).action,'no_action');});
for(const [name,change] of [['unknown ID',v=>v.candidateId='b99'],['other frame',v=>v.frameId='old'],['whole popup',v=>v.candidateId='b2'],['protected',v=>v.overlayType='protected'],['arbitrary action',v=>v.action='login']])test('selection refuses '+name,()=>{const f=prepareFrame(input()),v=choice(f);change(v);assert.equal(validateChoice(v,f).action,'no_action');});
test('uncertain model response is explicit no click',()=>{const f=prepareFrame(input());assert.equal(validateChoice({frameId:f.frameId,action:'no_action',candidateId:null,overlayType:'uncertain'},f).reason,'uncertain');});
test('Responses HTTP contract preserves requested model, sends full plus annotated images, validates result',async t=>{
 const f=prepareFrame(input());let calls=0;const server=http.createServer(async(req,res)=>{calls++;assert.equal(req.url,'/v1/responses');assert.equal(req.headers.authorization,'Bearer synthetic-test-key');let s='';for await(const b of req)s+=b;const v=JSON.parse(s);assert.equal(v.model,MODEL);assert.equal(v.store,false);assert.equal(v.input[1].content.filter(x=>x.type==='input_image').length,2);assert.equal(v.text.format.strict,true);res.end(JSON.stringify(body(choice(f))));});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const r=await selectClose(f,{...cfg,baseUrl:'http://127.0.0.1:'+server.address().port});assert.equal(r.candidateId,'b0');assert.equal(calls,1);
});
for(const [name,fetchImpl] of [['incomplete',async()=>new Response('{"status":"incomplete"}')],['malformed',async()=>new Response('bad')],['too large',async()=>new Response('a'.repeat(32001))],['error',async()=>new Response('',{status:500})],['refusal',async()=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]}))]])test('upstream '+name+' cannot click',async()=>assert.equal((await selectClose(prepareFrame(input()),cfg,{fetchImpl})).action,'no_action'));
test('hard timeout even if fetch ignores abort',async()=>{const t=Date.now();const r=await selectClose(prepareFrame(input()),{...cfg,timeoutMs:20},{fetchImpl:()=>new Promise(()=>{})});assert.equal(r.reason,'timeout');assert.ok(Date.now()-t<500);});
test('disabled or aborted makes no model request',async()=>{let n=0;const f=prepareFrame(input());await selectClose(f,{...cfg,enabled:false},{fetchImpl:()=>n++});const c=new AbortController();c.abort();await selectClose(f,cfg,{signal:c.signal,fetchImpl:()=>n++});assert.equal(n,0);});
function flow(changeBefore,changeAfter){const f=prepareFrame(input());let taps=[],observes=0;const before={image:image(),binding,protected:false,foreground:'alipay',inputGeometry:{width:720,height:1600,rotation:0,coordinateSpace:'native-screen'}};const after={binding,protected:false,foreground:'alipay',expectedPage:true,overlayGone:true};changeBefore?.(before);changeAfter?.(after);return {f,taps,ops:{withDeviceLock:async(b,fn)=>{assert.deepEqual(b,binding);return fn();},observe:async()=>observes++?after:before,tap:async p=>taps.push(p)}};}
test('full modeled chain: original task snapshot -> chosen ID -> one click -> refreshed expected page -> resume',async()=>{const x=flow();const r=await selectClose(x.f,cfg,{fetchImpl:async()=>response(choice(x.f))});const result=await executeSelection(x.f,r,x.ops);assert.deepEqual(x.taps,[[360,1250]]);assert.equal(result.resume,true);});
for(const [name,change] of [['other task',x=>x.binding={...binding,taskId:'new'}],['new generation',x=>x.binding={...binding,generation:'g2'}],['captcha',x=>x.protected=true],['foreign app',x=>x.foreground='other'],['changed pixels',x=>x.image[30]=1]])test('before click stops '+name,async()=>{const x=flow(change);const r=await executeSelection(x.f,validateChoice(choice(x.f),x.f),x.ops);assert.equal(r.action,'no_action');assert.equal(x.taps.length,0);});
for(const [name,change] of [['still covered',x=>x.overlayGone=false],['login after close',x=>x.protected=true],['wrong next page',x=>x.expectedPage=false],['task replaced',x=>x.binding={...binding,taskId:'new'}]])test('after click '+name+' never resumes or reclicks',async()=>{const x=flow(null,change);const r=await executeSelection(x.f,validateChoice(choice(x.f),x.f),x.ops);assert.equal(r.resume,false);assert.equal(x.taps.length,1);});
test('forged callback point cannot redirect tap',async()=>{const x=flow();const c=validateChoice(choice(x.f),x.f);c.point=[650,1385];await executeSelection(x.f,c,x.ops);assert.deepEqual(x.taps,[[360,1250]]);});
test('duplicate selected frame never taps twice',async()=>{const x=flow();const c=validateChoice(choice(x.f),x.f);x.ops.observe=async()=>({image:image(),binding,protected:false,foreground:'alipay',inputGeometry:{width:720,height:1600,rotation:0,coordinateSpace:'native-screen'},expectedPage:true,overlayGone:true});await executeSelection(x.f,c,x.ops);const r=await executeSelection(x.f,c,x.ops);assert.equal(x.taps.length,1);assert.equal(r.reason,'already_attempted');});

test('stop during model wait returns promptly even when transport ignores abort',async()=>{
 const ctl=new AbortController();const pending=selectClose(prepareFrame(input()),{...cfg,timeoutMs:1000},{signal:ctl.signal,fetchImpl:()=>new Promise(()=>{})});
 ctl.abort();const r=await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve({reason:'still_waiting'}),100))]);assert.equal(r.reason,'cancelled');
});
test('frame expiring while page reread is pending must not tap',async()=>{
 const x=flow();x.f.createdAt=Date.now()-119999;const observe=x.ops.observe;x.ops.observe=async()=>{await new Promise(r=>setTimeout(r,10));return observe();};
 const r=await executeSelection(x.f,validateChoice(choice(x.f),x.f),x.ops);assert.equal(x.taps.length,0);assert.equal(r.action,'no_action');
});
test('stop during tap acknowledgement must not resume original task',async()=>{
 const x=flow(),ctl=new AbortController();x.ops.signal=ctl.signal;x.ops.tap=async p=>{x.taps.push(p);ctl.abort();};
 const r=await executeSelection(x.f,validateChoice(choice(x.f),x.f),x.ops);assert.equal(x.taps.length,1);assert.equal(r.resume,false);
});
for(const [name,geometry] of [['missing',null],['scaled',{width:360,height:800,rotation:0,coordinateSpace:'native-screen'}],['rotated',{width:720,height:1600,rotation:1,coordinateSpace:'native-screen'}],['browser coordinates',{width:720,height:1600,rotation:0,coordinateSpace:'css'}]])test('tap refuses unverified display mapping: '+name,async()=>{
 const x=flow(b=>b.inputGeometry=geometry);await executeSelection(x.f,validateChoice(choice(x.f),x.f),x.ops);assert.equal(x.taps.length,0);
});
