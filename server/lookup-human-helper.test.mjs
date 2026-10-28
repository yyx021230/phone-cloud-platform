import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {canShareLookupSessionWithScreenControl as allowed,findScreenControlLockConflict} from './device-lock-compatibility.mjs';

const lock={lockId:'l',status:'active',lockType:'alipay_name_lookup',deviceId:'d',taskId:'s',ownerUserId:'api'};
const session=()=>({sessionId:'s',deviceId:'d',userId:'api',status:'ready',results:[{resultId:'q',status:'needs_human_verification'}]});
const helper={allowLookupHumanHelper:true};
test('explicit helper can handle only the active bound human challenge',()=>{
 assert.equal(allowed(lock,'helper',session(),helper),true);
 assert.equal(allowed(lock,'other',session()),false);
 assert.equal(allowed(lock,'helper',{...session(),results:[],startupHumanVerification:{status:'needs_human_verification'}},helper),true);
 for(const patch of [{pendingJobId:'busy'}, {status:'querying'}, {status:'ended'}, {deviceId:'other'}, {sessionId:'other'}, {userId:'other'}, {results:[]}, {results:[{status:'succeeded',limitReason:'jigsaw_verification'}]}])assert.equal(allowed(lock,'helper',{...session(),...patch},helper),false,JSON.stringify(patch));
 for(const patch of [{status:'expired'},{lockType:'xhs_publish'}])assert.equal(allowed({...lock,...patch},'helper',session(),helper),false);
 assert.ok(findScreenControlLockConflict([lock,{...lock,lockType:'screen_control',lockId:'screen'}],'d','helper',helper));
});
test('helper never gets idle API session while owner and admin retain existing access',()=>{
 const idle={...session(),results:[]};
 assert.equal(allowed(lock,'helper',idle,helper),false);
 assert.equal(allowed(lock,'api',idle),true);
 assert.equal(allowed(lock,'admin',idle,{allowAdminOverride:true}),true);
});
test('admin update stores boolean capability without role/password changes and rejects strings',()=>{
 const source=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
 const extract=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
 const ctx=vm.createContext({badRequest:x=>new Error(x),nowIso:()=> 'fixture',revokeUserSessions:()=>assert.fail('unexpected revoke'),validatePasswordStrength:()=>assert.fail('unexpected password'),hashPassword:()=>assert.fail('unexpected password')});
 vm.runInContext(extract('function updateUser(', 'function createSession(')+extract('function publicUser(', 'function staticTokenUser('),ctx);
 const user={userId:'helper',username:'fixture',role:'user',enabled:true,passwordHash:'untouched'};
 ctx.updateUser(user,{lookupHumanControl:true}); assert.equal(user.role,'user');assert.equal(user.passwordHash,'untouched');assert.equal(ctx.publicUser(user).lookupHumanControl,true);
 ctx.updateUser(user,{lookupHumanControl:false});assert.equal(ctx.publicUser(user).lookupHumanControl,false);
 assert.throws(()=>ctx.updateUser(user,{lookupHumanControl:'true'}),/invalid_lookup_human_control/);
 assert.match(source,/allowLookupHumanHelper: ctx\.user\?\.lookupHumanControl === true/);
 assert.match(source,/allowLookupHumanHelper: ctx\?\.user\?\.lookupHumanControl === true/);
});

import {buildLookupCardStatus} from './device-occupancy.mjs';
test('unsupported page is not shown as automatic recovery or manual CAPTCHA',()=>{const card=buildLookupCardStatus({...session(),results:[{status:'needs_recovery'}]},{sessionId:'s',phase:'recovery',pageCompatibilityRequired:true});assert.equal(card.label,'页面待兼容');assert.equal(card.needsHuman,false);});
