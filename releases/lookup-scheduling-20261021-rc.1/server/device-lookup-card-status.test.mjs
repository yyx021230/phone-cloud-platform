import assert from 'node:assert/strict';
import test from 'node:test';
import {buildDeviceOccupancy,buildLookupCardStatus as classify} from './device-occupancy.mjs';
import {renderLookupCardStatus as render} from '../public/lookup-card-status.js';

const session = extra => ({sessionId:'s1',status:'ready',results:[],...extra});
const channel = extra => ({sessionId:'s1',phase:'idle',...extra});
const human = {resultId:'q1',status:'needs_human_verification',limitReason:'jigsaw_verification'};
const loginJob = extra => ({jobId:'j1',sessionId:'s1',kind:'alipay_name_switch',status:'failed',
  createdAt:'2026-10-20T01:00:00Z',result:{errorCode:'alipay_login_required',currentAccount:'synthetic-private-account'},...extra});

test('card shows current puzzle and startup verification as human actions',()=>{
  const puzzle=classify(session({results:[human]}),channel({phase:'human',queryId:'q1'}));
  assert.equal(puzzle.state,'human_required');assert.equal(puzzle.label,'等待人工拼图');assert.equal(puzzle.needsHuman,true);
  const startup=classify(session({status:'needs_human_verification',startupHumanVerification:{status:'needs_human_verification'}}));
  assert.equal(startup.label,'等待人工验证');assert.equal(startup.needsHuman,true);
});
test('card identifies precise login failure without leaking account or diagnostics',()=>{
  const result=classify(session({status:'failed'}),channel(),[loginJob()]);
  assert.equal(result.state,'login_required');assert.equal(result.needsHuman,true);
  assert.deepEqual(Object.keys(result).sort(),['hint','label','needsHuman','state']);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private-account|alipay_login_required/);
});
test('account restriction and account picker are not mislabelled login or human verification',()=>{
  const restricted=classify(session({requiresAccountSwitch:true}),channel(),[loginJob({result:{errorCode:'lookup_limit_reached'}})]);
  assert.equal(restricted.state,'switching');assert.equal(restricted.needsHuman,false);
  const picker=classify(session({status:'switching',pendingJobId:'j1'}),channel({phase:'switching'}),
    [loginJob({status:'running',result:{currentActivity:'com.ali.user.mobile.accountmanager.ui.AccountManagerActivity'}})]);
  assert.equal(picker.state,'switching');assert.equal(picker.needsHuman,false);
});
test('pending verified resume replaces historical puzzle label',()=>{
  const result=classify(session({status:'querying',results:[human],pendingJobId:'j2'}),channel({phase:'human',queryId:'q1'}),
    [{jobId:'j2',sessionId:'s1',kind:'alipay_name_query',status:'running',resumeAfterHumanVerification:true}]);
  assert.equal(result.state,'resuming');assert.equal(result.needsHuman,false);
});
test('pending current work wins over prior failed job in the same session',()=>{
  const result=classify(session({status:'querying',pendingJobId:'j2'}),channel(),
    [loginJob(),loginJob({jobId:'j2',kind:'alipay_name_query',status:'running',createdAt:'2026-10-20T02:00:00Z'})]);
  assert.equal(result.state,'running');assert.equal(result.needsHuman,false);
});
test('stopping takes precedence over old puzzle and login actions',()=>{
  for(const extra of [{status:'stopping'},{}]){
    const result=classify(session({...extra,results:[human]}),channel({roundStopPreparationId:'p1'}),[loginJob()]);
    assert.equal(result.state,'stopping');assert.equal(result.needsHuman,false);
  }
});
test('terminal or uncertain sessions do not display stale puzzle as an actionable request',()=>{
  for(const status of ['ended','failed','expired']){
    assert.equal(classify(session({status,results:[human]}),channel({phase:'human'})).state,'checking');
  }
  assert.equal(classify(session({results:[human]}),channel({phase:'unknown'})).state,'checking');
});
test('old query or another session cannot change the current idle state',()=>{
  assert.equal(classify(session({results:[{resultId:'q2',status:'success'},human]}),channel({queryId:'q2'})).state,'idle');
  assert.equal(classify(session(),channel({sessionId:'other',phase:'stopping'}),[loginJob({sessionId:'other'})]).state,'idle');
});
test('starting, running, idle and recovery have distinct nonhuman descriptions',()=>{
  assert.equal(classify(session({status:'starting',pendingJobId:'start'})).state,'preparing');
  assert.equal(classify(session({status:'querying',pendingJobId:'query'})).state,'running');
  assert.equal(classify(session(),channel()).state,'idle');
  const recovering=classify(session({results:[{status:'needs_recovery'}]}),channel({phase:'recovery'}));
  assert.equal(recovering.state,'recovering');assert.equal(recovering.needsHuman,false);
});
test('screen-control ownership and lookup human indicator coexist without changing the control lock',()=>{
  const lock={lockType:'screen_control',ownerUserId:'system',taskId:'control1'};
  const original=buildDeviceOccupancy({lock});
  const extended=buildDeviceOccupancy({lock,lookupSession:session({results:[human]}),lookupChannel:channel({queryId:'q1'})});
  const {lookup,...rest}=extended;assert.deepEqual(rest,original);assert.equal(lookup.needsHuman,true);
  assert.equal(buildDeviceOccupancy({lookupSession:session()}),null);
});
test('renderer escapes all dynamic strings and rejects unknown states',()=>{
  const html=render({lookup:{state:'human_required',needsHuman:true,label:'<img src=x onerror=alert(1)>',hint:'" onclick="alert(1)'}});
  assert.doesNotMatch(html,/<img|title="" onclick=/);assert.match(html,/&lt;img/);assert.match(html,/&quot;/);
  assert.equal(render({lookup:{state:'" onclick="x'}}),'');assert.equal(render(null),'');
});
test('renderer uses explicit words for human actions and no action badge for automatic states',()=>{
  assert.match(render({lookup:classify(session({results:[human]}),channel({queryId:'q1'}))}),/需人工/);
  const idle=render({lookup:classify(session(),channel())});
  assert.match(idle,/查名待命/);assert.doesNotMatch(idle,/lookup-card-status-action/);
});

test('confirmed waiting card is not human; unknown or stale observation explicitly shows checking',()=>{
 const s=session({results:[human]});const c=channel({phase:'human',queryId:'q1',humanObservation:{state:'search_ready',confirmed:true,at:Date.now()}});
 const result=classify(s,c);assert.equal(result.state,'verified_waiting');assert.equal(result.needsHuman,false);assert.doesNotMatch(render({lookup:result}),/需人工/);
 c.humanObservation.at-=31000;assert.equal(classify(s,c).state,'checking');
 c.humanObservation={state:'unknown',confirmed:false,at:Date.now()};assert.equal(classify(s,c).state,'checking');
});
