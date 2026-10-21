// Local-only reproduction against the verified production assembly; no network or phone actions.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
import path from 'node:path';import {pathToFileURL} from 'node:url';
if(!process.argv[2])throw Error('Pass verified production assembly directory');
const app=path.resolve(process.argv[2]);
const {lookupHumanChallenge,createLookupHumanHandover}=await import(pathToFileURL(path.join(app,'server/lookup-human-handover.mjs')));
const source=fs.readFileSync(path.join(app,'server/index.mjs'),'utf8'),begin=source.indexOf('function lookupHumanProbeTargets(agentId)'),end=source.indexOf('async function resumeLookupAfterObservedHumanVerification',begin);
let executing=5,time=100000;
const session={sessionId:'session',deviceId:'d',userId:'u',managedLookupGeneration:'g',status:'ready',results:[{resultId:'query',status:'needs_human_verification',updatedAt:'2026-10-21T00:00:00Z'}]};
const context=vm.createContext({state:{automationSessions:[session],deviceLocks:[{status:'active',lockType:'alipay_name_lookup',taskId:'session',deviceId:'d',ownerUserId:'u'}]},repos:{devices:{findById:()=>({deviceId:'d',adb:{agentId:'agent',serial:'synthetic'}})}},lookupHumanChallenge,isAdbOnline:()=>true,screenSessions:{activeForDevice:()=>null},managedLookup:{admin:()=>({counts:{executing}}),store:{snapshot:()=>({config:{concurrency:5}})}}});
vm.runInContext(source.slice(begin,end),context);
assert.equal(context.lookupHumanProbeTargets('agent').length,0);
executing=4;assert.equal(context.lookupHumanProbeTargets('agent').length,1);
let resumes=0;const h=createLookupHumanHandover({targets:a=>context.lookupHumanProbeTargets(a),resume:async()=>{resumes++;return true;},now:()=>time});
const first=h.list('agent')[0];await h.report('agent',{probeId:first.probeId,state:'search_ready'});time+=3000;
const second=h.list('agent')[0];executing=5;
const rejected=await h.report('agent',{probeId:second.probeId,state:'search_ready'});assert.equal(rejected.reason,'probe_stale');assert.equal(resumes,0);assert.equal(h.list('agent').length,0);
executing=4;time+=3000;const third=h.list('agent')[0];const again=await h.report('agent',{probeId:third.probeId,state:'search_ready'});assert.equal(again.resumed,false);
console.log(JSON.stringify({case:'live_cloud_human_gate',fullFiveSlotsProbeTargets:0,fourSlotsProbeTargets:1,secondClearReportAtFullCapacity:rejected,clearStreakLostOnCapacityFlap:true,resumes}));
