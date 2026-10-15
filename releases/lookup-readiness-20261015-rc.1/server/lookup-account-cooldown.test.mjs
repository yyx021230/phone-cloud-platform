import assert from "node:assert/strict";
import test from "node:test";
import { LOOKUP_ACCOUNT_COOLDOWN_MS, recordLookupAccountCooldown, publicLookupAccountCooldowns,
  lookupAccountPolicy, verifiedSavedAccounts, allSavedAccountsCooling } from "./lookup-account-cooldown.mjs";

const now = Date.parse("2026-10-09T02:00:00Z");
const input = { account: "synthetic-A", reason: "frequent_or_abnormal_access", restrictionId: "job-1:A",
  jobId: "job-1", accountIdentityVerified: true, phoneQueryStarted: true, detectedAt: new Date(now).toISOString() };
test("confirmed account limit persists an exact eight-hour clock across JSON reload and sessions", () => {
  const device = {};
  recordLookupAccountCooldown(device, input, now);
  const restored = JSON.parse(JSON.stringify(device));
  assert.equal(Date.parse(restored.lookupAccountCooldowns[0].cooldownUntil) - now, LOOKUP_ACCOUNT_COOLDOWN_MS);
  assert.equal(lookupAccountPolicy(restored).accountCooldowns[0].account, input.account);
  assert.equal(publicLookupAccountCooldowns(restored, now + LOOKUP_ACCOUNT_COOLDOWN_MS - 1)[0].cooling, true);
  assert.equal(publicLookupAccountCooldowns(restored, now + LOOKUP_ACCOUNT_COOLDOWN_MS)[0].cooling, false);
  assert.equal(restored.lookupAccountCooldowns.length, 1, "expiry retains history");
});
test("replay, checking and a late older event cannot extend or shorten cooldown", () => {
  const device = {};
  const first = recordLookupAccountCooldown(device, input, now);
  assert.equal(recordLookupAccountCooldown(device, { ...input, detectedAt: new Date(now + 10).toISOString() }, now + 10), first);
  assert.equal(recordLookupAccountCooldown(device, { ...input, restrictionId: "older", detectedAt: new Date(now - 1).toISOString() }, now), first);
  publicLookupAccountCooldowns(device, now + 100);
  assert.equal(Date.parse(first.cooldownUntil), now + LOOKUP_ACCOUNT_COOLDOWN_MS);
});
test("verified restrictions before input cool without attributing them to the number", () => {
  const device = {};
  const record = recordLookupAccountCooldown(device, { ...input, phoneQueryStarted: false }, now);
  assert.equal(record.account, input.account);
  assert.equal(record.phoneQueryStarted, false);
  assert.equal(Date.parse(record.cooldownUntil), now + LOOKUP_ACCOUNT_COOLDOWN_MS);
});
test("only explicit restrictions with a verified attributable account can cool", () => {
  for (const override of [{ reason: "jigsaw_verification" }, { reason: "network_error" }, { account: "" },
    { accountIdentityVerified: false }, { phoneQueryStarted: undefined }, { detectedAt: "bad" }, { detectedAt: new Date(now + 1).toISOString() }]) {
    const device = {};
    assert.equal(recordLookupAccountCooldown(device, { ...input, ...override }, now), null);
    assert.equal(device.lookupAccountCooldowns, undefined);
  }
});
test("same masked labels on different phones never share cooldown", () => {
  const device = {};
  recordLookupAccountCooldown(device, input, now);
  assert.equal(publicLookupAccountCooldowns({}, now).length, 0);
});
test("all unavailable requires a complete unambiguous picker, including one-account phones", () => {
  const device = {};
  recordLookupAccountCooldown(device, input, now);
  const saved = [{ account: input.account, current: true }];
  assert.equal(allSavedAccountsCooling(device, saved, now), true);
  assert.equal(allSavedAccountsCooling(device, [...saved, { account: "synthetic-B", current: false }], now), false);
  assert.equal(allSavedAccountsCooling(device, saved, now + LOOKUP_ACCOUNT_COOLDOWN_MS), false);
  for (const rows of [[], [...saved, ...saved], [{ account: "A" }], [{ account: "", current: true }]]) {
    assert.equal(verifiedSavedAccounts(rows), null);
    assert.equal(allSavedAccountsCooling(device, rows, now), false);
  }
});

test('prepared transfer requires exact persisted restriction proof, not just an error code', async()=>{
 const {isPreparedLookupLimitConfirmed}=await import('./lookup-account-cooldown.mjs');const time=Date.now();
 const job={jobId:'prepared-job',preparedLookup:{verifiedAccount:'A'},result:{errorCode:'alipay_prepared_account_limited',diagnostic:{currentAccount:'A',accountIdentityVerified:true,limitReached:true,phoneQueryStarted:true,limitReason:'access_denied'}}};
 const d={};recordLookupAccountCooldown(d,{account:'A',reason:'access_denied',restrictionId:'prepared-job:A',jobId:'prepared-job',accountIdentityVerified:true,phoneQueryStarted:true,detectedAt:new Date(time).toISOString()},time);
 assert.equal(isPreparedLookupLimitConfirmed(d,job,time),true);
 for(const change of [x=>delete x.preparedLookup,x=>x.jobId='wrong',x=>x.result.diagnostic.currentAccount='B',x=>x.result.diagnostic.accountIdentityVerified=false]){const copy=structuredClone(job);change(copy);assert.equal(isPreparedLookupLimitConfirmed(d,copy,time),false);}
 assert.equal(isPreparedLookupLimitConfirmed({},job,time),false);assert.equal(isPreparedLookupLimitConfirmed(d,job,time+28800001),false);
});
