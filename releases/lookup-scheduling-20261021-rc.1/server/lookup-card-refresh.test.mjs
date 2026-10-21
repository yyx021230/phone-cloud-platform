import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {renderLookupCardStatus} from '../public/lookup-card-status.js';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const fragment=source.slice(source.indexOf('let lookupCardsInFlight=false;'),source.indexOf('function renderDeviceOccupancy'));
test('lightweight card refresh changes only status markup and clears stale human labels',async()=>{
 const slot={dataset:{lookupCardDevice:'d1'},innerHTML:'old human'};let payload={statuses:[{deviceId:'d1',lookup:{state:'verified_waiting',label:'验证完成',hint:'等待',needsHuman:false}}]},calls=0;
 const ctx=vm.createContext({state:{user:{userId:'u'}},userDataSessionVersion:1,document:{hidden:false,querySelector:()=>slot,querySelectorAll:()=>[slot]},api:async path=>{assert.equal(path,'/api/v1/lookup-card-statuses');calls++;return payload;},renderLookupCardStatus});
 vm.runInContext(fragment,ctx);await ctx.refreshLookupCardsOnly();assert.match(slot.innerHTML,/验证完成/);assert.doesNotMatch(slot.innerHTML,/需人工/);
 payload={statuses:[{deviceId:'d1',lookup:null}]};await ctx.refreshLookupCardsOnly();assert.equal(slot.innerHTML,'');ctx.document.hidden=true;await ctx.refreshLookupCardsOnly();assert.equal(calls,2);
});
test('a response from before logout cannot rewrite current user cards',async()=>{
 const slot={dataset:{lookupCardDevice:'d1'},innerHTML:'current'};let resolve;
 const ctx=vm.createContext({state:{user:{userId:'u'}},userDataSessionVersion:1,document:{hidden:false,querySelector:()=>slot,querySelectorAll:()=>[slot]},api:()=>new Promise(r=>resolve=r),renderLookupCardStatus});
 vm.runInContext(fragment,ctx);const pending=ctx.refreshLookupCardsOnly();ctx.state.user={userId:'different'};resolve({statuses:[]});await pending;assert.equal(slot.innerHTML,'current');
});
