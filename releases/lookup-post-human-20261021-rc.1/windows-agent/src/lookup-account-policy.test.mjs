import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { runLookupWithAccountPolicy } from "./lookup-account-policy.mjs";
import { restartLookupQueryOnce } from "./lookup-page-recovery.mjs";
import { shouldFallbackAlipayPocoFailure } from "./alipay-poco-fallback-policy.mjs";
const now = Date.parse("2026-10-09T00:00:00Z");
const account = (name, extra = {}) => ({ currentAccount: name, accountIdentityVerified: true,
  savedAccounts: ["A", "B"].map((value) => ({ account: value, current: value === name })), ...extra });
const task = { taskId: "synthetic-task", type: "alipay_name_query", adbSerial: "synthetic-device",
  payload: { accountCooldownProtocol: 1, knownAccount: "A", accountIdentityVerified: true,
    savedAccounts: account("A").savedAccounts, phoneNumber: "13800000000", resultId: "original-result" } };
test("verified queries reuse account proof even when a failed query resets the first-query hint", async () => {
  for (const first of [true, false]) {
    const calls = [];
    await runLookupWithAccountPolicy({ task: { ...task, payload: { ...task.payload, verifyAccountBeforeQuery: first } },
      now: () => now, recordLimit: assert.fail, execute: async (item) => { calls.push(item); return account("A"); } });
    assert.deepEqual(calls.map((item) => item.type), ["alipay_name_query"]);
    assert.equal(calls.at(-1).payload.phoneNumber, task.payload.phoneNumber);
  }
});
test("first session start and queries without known identity still prepare before input", async () => {
  for (const type of ["alipay_name_start", "alipay_name_query"]) {
    const calls = [];
    await runLookupWithAccountPolicy({ task: { ...task, type, payload: { ...task.payload,
      knownAccount: "", accountIdentityVerified: false, savedAccounts: [] } }, now: () => now,
      recordLimit: assert.fail, execute: async (item) => { calls.push(item.type); return account("A"); } });
    assert.deepEqual(calls, type === "alipay_name_start" ? ["alipay_name_start"] : ["alipay_name_start", "alipay_name_query"]);
  }
});
test("a limit is durably acknowledged before preparing another account and retrying the same item", async () => {
  const order = [];
  let queries = 0;
  const result = await runLookupWithAccountPolicy({ task, now: () => now,
    recordLimit: async (record) => { order.push("persist"); assert.equal(record.account, "A");
      return { accountCooldown: { account: "A", limitedAt: new Date(now).toISOString(), cooldownUntil: new Date(now + 28_800_000).toISOString() } }; },
    execute: async (item) => {
      assert.equal(item.taskId, task.taskId);
      assert.equal(item.payload.phoneNumber, task.payload.phoneNumber);
      assert.equal(item.payload.resultId, task.payload.resultId);
      if (item.type === "alipay_name_start") { order.push("prepare"); assert.equal(item.payload.accountCooldowns[0].account, "A"); return account("B", { accountSwitched: true }); }
      order.push("query");
      if (!queries++) throw Object.assign(new Error("limit"), { diagnostic: { limitReached: true, phoneQueryStarted: true, limitReason: "frequent_or_abnormal_access" } });
      return account("B", { notFound: true });
    } });
  assert.deepEqual(order, ["query", "persist", "prepare", "query"]);
  assert.equal(result.accountSwitched, true);
  assert.equal(result.currentAccount, "B");
});
test("save failure or missing ACK never permits account switching", async () => {
  for (const recordLimit of [async () => { throw new Error("storage offline"); }, async () => ({})]) {
    let count = 0;
    await assert.rejects(runLookupWithAccountPolicy({ task, now: () => now, recordLimit,
      execute: async () => { count++; throw { diagnostic: { limitReached: true, phoneQueryStarted: true, limitReason: "access_denied" } }; } }));
    assert.equal(count, 1);
  }
});
test("jigsaw, unconfirmed restrictions and transport failures never write cooldown or rotate", async () => {
  for (const diagnostic of [{ limitReached: true, limitReason: "jigsaw_verification" },
    { limitReached: false, limitReason: "device_risk" }, { code: "network_error" }]) {
    let count = 0;
    await assert.rejects(runLookupWithAccountPolicy({ task, now: () => now, recordLimit: assert.fail,
      execute: async () => { count++; throw { diagnostic }; } }));
    assert.equal(count, 1);
  }
});
test("an evidenced pre-input restriction persists its actual phase and retries the original item", async () => {
  const order = [];
  let queries = 0;
  await runLookupWithAccountPolicy({ task, now: () => now,
    recordLimit: async (record) => {
      order.push("persist");
      assert.equal(record.phoneQueryStarted, false);
      return { accountCooldown: { account: "A", limitedAt: new Date(now).toISOString(), cooldownUntil: new Date(now + 28_800_000).toISOString() } };
    }, execute: async (item) => {
      assert.equal(item.taskId, task.taskId);
      assert.equal(item.payload.phoneNumber, task.payload.phoneNumber);
      if (item.type === "alipay_name_start") { order.push("prepare"); return account("B", { accountSwitched: true }); }
      order.push("query");
      if (!queries++) throw { diagnostic: { accountRestrictionDetected: true, phoneQueryStarted: false, limitReason: "frequent_or_abnormal_access" } };
      return account("B", { notFound: true });
    } });
  assert.deepEqual(order, ["query", "persist", "prepare", "query"]);
});
test("unverified cached identity cannot acquire a cooldown from an error", async () => {
  await assert.rejects(runLookupWithAccountPolicy({ task: { ...task, payload: { ...task.payload, savedAccounts: [] } },
    now: () => now, recordLimit: assert.fail,
    execute: async () => { throw { diagnostic: { accountRestrictionDetected: true, phoneQueryStarted: false, limitReason: "access_denied" } }; }
  }), { code: "alipay_account_identity_unverified" });
});
test("preparation restrictions require actual identity proof and persist before another preparation", async () => {
  const order = [];
  let prepares = 0;
  const start = { ...task, type: "alipay_name_start" };
  const result = await runLookupWithAccountPolicy({ task: start, now: () => now,
    recordLimit: async (record) => {
      order.push("persist"); assert.equal(record.account, "A"); assert.equal(record.phoneQueryStarted, false);
      return { accountCooldown: { account: "A", limitedAt: new Date(now).toISOString(), cooldownUntil: new Date(now + 28_800_000).toISOString() } };
    }, execute: async () => {
      order.push("prepare");
      if (!prepares++) throw { diagnostic: { ...account("A"), accountRestrictionDetected: true,
        phoneQueryStarted: false, limitReason: "frequent_or_abnormal_access" } };
      return account("B", { accountSwitched: true });
    } });
  assert.equal(result.currentAccount, "B");
  assert.deepEqual(order, ["prepare", "persist", "prepare"]);
  await assert.rejects(runLookupWithAccountPolicy({ task: start, now: () => now, recordLimit: assert.fail,
    execute: async () => { throw { diagnostic: { accountRestrictionDetected: true, phoneQueryStarted: false, limitReason: "access_denied" } }; }
  }), { code: "alipay_account_identity_unverified" });
});
test("switching after a human resume re-queries the original number instead of reading the old account result", async () => {
  let queries = 0;
  await runLookupWithAccountPolicy({ task: { ...task, payload: { ...task.payload, resumeAfterHumanVerification: true } }, now: () => now,
    recordLimit: async () => ({ accountCooldown: { account: "A", limitedAt: new Date(now).toISOString(), cooldownUntil: new Date(now + 28_800_000).toISOString() } }),
    execute: async (item) => {
      if (item.type === "alipay_name_start") return account("B", { accountSwitched: true });
      if (!queries++) throw { diagnostic: { limitReached: true, phoneQueryStarted: true, limitReason: "access_denied" } };
      assert.equal(item.payload.resumeAfterHumanVerification, false);
      assert.equal(item.payload.phoneNumber, task.payload.phoneNumber);
      assert.equal(item.payload.resultId, task.payload.resultId);
      return account("B", { notFound: true });
    } });
});
test("ambiguous account proof fails closed before any query", async () => {
  for (const result of [account("A", { accountIdentityVerified: false }), account("A", { savedAccounts: [] }),
    account("A", { savedAccounts: [{ account: "A", current: true }, { account: "A", current: false }] })]) {
    let count = 0;
    await assert.rejects(runLookupWithAccountPolicy({ task: { ...task, payload: { ...task.payload,
      knownAccount: "", accountIdentityVerified: false, savedAccounts: [], verifyAccountBeforeQuery: true } },
      now: () => now, recordLimit: assert.fail, execute: async () => { count++; return result; } }), { code: "alipay_account_identity_unverified" });
    assert.equal(count, 1);
  }
});
test("malformed cached account proof stops before any query or account navigation", async () => {
  for (const savedAccounts of [[], [{ account: "A", current: false }],
    [{ account: "A", current: true }, { account: "A", current: true }]]) {
    await assert.rejects(runLookupWithAccountPolicy({ task: { ...task, payload: { ...task.payload, savedAccounts } },
      now: () => now, recordLimit: assert.fail, execute: assert.fail }), { code: "alipay_account_identity_unverified" });
  }
});
test("ordinary app recovery reuses the verified account without opening the account picker", async () => {
  const order = [];
  await runLookupWithAccountPolicy({ task, now: () => now, recordLimit: assert.fail,
    execute: async (item, hooks) => { order.push(item.type); if (hooks) {
      const cached = await hooks.beforeLookupRecovery();
      assert.equal(cached.knownAccount, "A");
      assert.equal(cached.accountIdentityVerified, true);
      assert.deepEqual(cached.savedAccounts, task.payload.savedAccounts);
    } return account("A"); } });
  assert.deepEqual(order, ["alipay_name_query"]);
});

test("human verification restart also reuses the known eligible account", async () => {
  const order = [];
  await runLookupWithAccountPolicy({ task: { ...task, payload: { ...task.payload,
    resumeAfterHumanVerification: true, restartAfterHumanVerification: true, verifyAccountBeforeQuery: true } }, now: () => now,
    recordLimit: assert.fail, execute: async (item) => { order.push(item.type); return account("A"); } });
  assert.deepEqual(order, ["alipay_name_query"]);
});

test("actual Agent transports pre-input restriction evidence from Poco without XML or app recovery", async () => {
  const source = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
  const classifiers = source.slice(source.indexOf("function alipayAccountSwitchReasonFromError("),
    source.indexOf("async function observeLookupHumanVerification("));
  const body = source.slice(source.indexOf("async function taskAlipayNameLookup("),
    source.indexOf("async function assertAdbDeviceOnline("));
  assert.ok(classifiers && body);
  for (const resumeAfterHumanVerification of [false, true]) {
    let workers = 0;
    const deps = {
      config: { alipayNameLookupRunnerPath: "synthetic", adbPath: "fake-adb" },
      fileExists: async () => true, assertAdbDeviceOnlineFast: async () => {},
      isPackageInstalled: async () => true, taskEvent: async () => {},
      screenControlledSerials: new Set(), isAutomationTaskCancellation: () => false,
      restartLookupQueryOnce, shouldFallbackAlipayPocoFailure,
      runXhsAirtestPocoWorker: async () => { workers++; return { ok: false,
        error: "alipay_account_restriction_before_search:frequent_or_abnormal_access", log: [] }; },
      replayAirtestEvents: async () => {}, stopAirtestWorker: assert.fail,
      ensureXmlUiAutomatorReady: assert.fail
    };
    const run = new Function(...Object.keys(deps), classifiers + body + ";return taskAlipayNameLookup;")(...Object.values(deps));
    await assert.rejects(run({ ...task, payload: { ...task.payload, resumeAfterHumanVerification } }), (error) => {
      assert.equal(error.diagnostic.accountRestrictionDetected, true);
      assert.equal(error.diagnostic.phoneQueryStarted, false);
      assert.equal(error.diagnostic.limitReason, "frequent_or_abnormal_access");
      return true;
    });
    assert.equal(workers, 1);
  }
});

for (const code of ["alipay_human_verification_required", "alipay_page_element_changed"]) test("post-rotation " + code + " retains verified identity without another rotation", async () => {
  const calls = []; let writes = 0;
  const error = Object.assign(new Error(code), { diagnostic: { code, limitReason: code.includes("human") ? "jigsaw_verification" : "", uiSnapshot: "synthetic evidence" } });
  await assert.rejects(runLookupWithAccountPolicy({ task, now: () => now,
    recordLimit: async () => { writes++; return { accountCooldown: { account: "A", limitedAt: new Date(now).toISOString(), cooldownUntil: new Date(now + 28_800_000).toISOString() } }; },
    execute: async (item) => {
      calls.push(item.type);
      if (item.type === "alipay_name_start") return account("B", { accountSwitched: true });
      if (calls.length === 1) throw { diagnostic: { limitReached: true, phoneQueryStarted: true, limitReason: "access_denied" } };
      throw error;
    } }), (reported) => {
      assert.equal(reported, error); assert.equal(reported.diagnostic.code, code);
      assert.equal(reported.diagnostic.currentAccount, "B"); assert.equal(reported.diagnostic.accountIdentityVerified, true);
      assert.deepEqual(reported.diagnostic.savedAccounts, account("B").savedAccounts);
      assert.equal(reported.diagnostic.accountSwitched, true); assert.equal(reported.diagnostic.accountSwitchCount, 1);
      assert.equal(reported.diagnostic.accountSwitchHistory.length, 1); assert.equal(reported.diagnostic.uiSnapshot, "synthetic evidence");
      return true;
    });
  assert.deepEqual(calls, ["alipay_name_query", "alipay_name_start", "alipay_name_query"]); assert.equal(writes, 1);
});
test("failure context never promotes unknown or contradictory account evidence", async () => {
  for (const diagnostic of [{ code: "alipay_account_identity_unverified" }, { accountIdentityVerified: false },
    { currentAccount: "B" }, { savedAccounts: account("B").savedAccounts }]) {
    const error = Object.assign(new Error("synthetic"), { diagnostic: { ...diagnostic } });
    await assert.rejects(runLookupWithAccountPolicy({ task, recordLimit: assert.fail, execute: async () => { throw error; } }), (reported) => {
      assert.notEqual(reported.diagnostic.accountIdentityVerified, true); return true;
    });
  }
});
test("resuming the verified post-rotation account takes the direct query path", async () => {
  const calls = [];
  const resumed = { ...task, payload: { ...task.payload, knownAccount: "B", savedAccounts: account("B").savedAccounts,
    resumeAfterHumanVerification: true, restartAfterHumanVerification: false,
    accountCooldowns: [{ account: "A", cooldownUntil: new Date(now + 28_800_000).toISOString() }] } };
  await runLookupWithAccountPolicy({ task: resumed, now: () => now, recordLimit: assert.fail, execute: async (item) => {
    calls.push(item.type); assert.equal(item.payload.resumeAfterHumanVerification, true);
    assert.equal(item.payload.restartAfterHumanVerification, false); return account("B", { notFound: true });
  } });
  assert.deepEqual(calls, ["alipay_name_query"]);
});

test('prepared business stops after durable cooldown without switching or replaying the original number',async()=>{
 const order=[];const prepared={...task,payload:{...task.payload,preparedLookup:{probePhone:'13900000000',verifiedAccount:'A'}}};
 await assert.rejects(runLookupWithAccountPolicy({task:prepared,now:()=>now,recordLimit:async r=>{order.push('cooldown');return {accountCooldown:{account:r.account,limitedAt:new Date(now).toISOString(),cooldownUntil:new Date(now+28800000).toISOString()}};},execute:async t=>{
  assert.equal(t.type,'alipay_name_query');assert.equal(t.payload.phoneNumber,task.payload.phoneNumber);order.push('business-A');throw {diagnostic:{code:'alipay_access_denied',limitReached:true,phoneQueryStarted:true,limitReason:'access_denied'}};
 }}),e=>e.code==='alipay_prepared_account_limited'&&e.diagnostic.code===e.code&&e.diagnostic.currentAccount==='A'&&e.diagnostic.accountIdentityVerified===true);
 assert.deepEqual(order,['business-A','cooldown']);
});
test('prepared query never switches an already cooling account with the customer number',async()=>{
 await assert.rejects(runLookupWithAccountPolicy({task:{...task,payload:{...task.payload,preparedLookup:{probePhone:'13900000000',verifiedAccount:'A'},accountCooldowns:[{account:'A',cooldownUntil:new Date(now+28800000).toISOString()}]}},now:()=>now,execute:assert.fail,recordLimit:assert.fail}),{code:'lookup_readiness_expired'});
});
test('empty or wrong-phone readiness probe never runs original business number',async()=>{
 for(const response of [{matchedPhone:'13900000000',notFound:true},{matchedPhone:'13700000000',realNameTailCharacter:'测'}]){
  let count=0;await assert.rejects(runLookupWithAccountPolicy({task:{...task,payload:{...task.payload,preparedLookup:{probePhone:'13900000000',verifiedAccount:''}}},recordLimit:assert.fail,execute:async t=>{count++;assert.equal(t.payload.phoneNumber,'13900000000');return account('A',response);}}),{code:'lookup_readiness_probe_failed'});assert.equal(count,1);
 }
});

test('post-human login is rechecked before any probe or input and never writes cooldown',async()=>{
 const calls=[];await assert.rejects(runLookupWithAccountPolicy({task:{...task,payload:{...task.payload,postHumanCheck:true,preparedLookup:{probePhone:'13900000000'}}},now:()=>now,recordLimit:assert.fail,
 execute:async x=>{calls.push(x);throw Object.assign(new Error('login'),{code:'alipay_login_required'});}}),/login/);
 assert.equal(calls.length,1);assert.equal(calls[0].payload.postHumanCheckOnly,true);
});
test('post-human limitation persists once before handing the original business back',async()=>{
 const calls=[];let saves=0;await assert.rejects(runLookupWithAccountPolicy({task:{...task,payload:{...task.payload,postHumanCheck:true,preparedLookup:{probePhone:'13900000000'}}},now:()=>now,
 execute:async x=>{calls.push(x);throw {diagnostic:{limitReached:true,limitReason:'frequent_or_abnormal_access',phoneQueryStarted:true}};},
 recordLimit:async x=>{saves++;return {accountCooldown:{account:x.account,limitedAt:new Date(now).toISOString(),cooldownUntil:new Date(now+28800000).toISOString()}};}}),e=>e.code==='alipay_prepared_account_limited');
 assert.equal(saves,1);assert.equal(calls.length,1);assert.equal(calls[0].payload.resultId,'original-result');
});
test('visible positive original result returns without a probe or reinput',async()=>{
 const calls=[];const result=await runLookupWithAccountPolicy({task:{...task,payload:{...task.payload,postHumanCheck:true,preparedLookup:{probePhone:'13900000000'}}},recordLimit:assert.fail,
 execute:async x=>{calls.push(x);return account('A',{postHumanCheckPassed:true,postHumanResult:true,matchedPhone:task.payload.phoneNumber,realNameTailCharacter:'名'});}});
 assert.equal(calls.length,1);assert.equal(result.realNameTailCharacter,'名');
});
test('post-human missing guard protocol or contradictory result fails closed',async()=>{
 for(const out of [account('A'),account('B',{postHumanCheckPassed:true,postHumanResult:true,matchedPhone:task.payload.phoneNumber,realNameTailCharacter:'名'})]){
 let n=0;await assert.rejects(runLookupWithAccountPolicy({task:{...task,payload:{...task.payload,postHumanCheck:true}},recordLimit:assert.fail,execute:async()=>{n++;return out;}}));assert.equal(n,1);}
});
test('normal page after guard re-probes before original business, original ID remains',async()=>{
 const calls=[];await runLookupWithAccountPolicy({task:{...task,payload:{...task.payload,postHumanCheck:true,preparedLookup:{probePhone:'13900000000'}}},recordLimit:assert.fail,
 execute:async x=>{calls.push(x);return account('A',{postHumanCheckPassed:x.payload.postHumanCheckOnly===true,matchedPhone:x.payload.phoneNumber,realNameTailCharacter:'名'});}});
 assert.deepEqual(calls.map(x=>x.payload.postHumanCheckOnly===true),[true,false,false]);assert.equal(calls[1].payload.phoneNumber,'13900000000');assert.equal(calls[2].payload.phoneNumber,task.payload.phoneNumber);assert.ok(calls.every(x=>x.taskId===task.taskId));
});
