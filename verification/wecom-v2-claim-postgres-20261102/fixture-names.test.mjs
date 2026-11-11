import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {collectSyntheticSeeds,assertUniqueSeedNames} from "./fixture-names.mjs";
const source=fs.readFileSync(new URL("./postgres.integration.mjs",import.meta.url),"utf8");
test("all fixed constructor calls and expanded seed identities are unique",()=>{
  const {constructorCalls,records}=collectSyntheticSeeds(source),counts=assertUniqueSeedNames(records);
  assert.ok(constructorCalls>20);assert.ok(records.length>40);assert.equal(counts.device,records.length-1);assert.equal(counts.task,records.length);
  assert.equal(records.filter(f=>f.extra).length,1);console.log(JSON.stringify({constructorCalls,expandedSeeds:records.length,uniqueCounts:counts}));
});
test("exact old missing-* loop reproduces duplicate actual device identity",()=>{
  const old=source.replace('made(`reconcile-missing-${kind}`)','made(`missing-${kind}`)');assert.notEqual(old,source);
  const {records}=collectSyntheticSeeds(old);assert.throws(()=>assertUniqueSeedNames(records),/duplicate_device:adb:fixture-missing-anchor/);
});
test("new unregistered constructor expression fails inventory closed",()=>{
  assert.throws(()=>collectSyntheticSeeds(source+'\nmade(unreviewedDynamicName);'),/constructor_not_in_fixed_inventory/);
});
test("changed numeric loop cannot silently omit new seeds",()=>{
  assert.throws(()=>collectSyntheticSeeds(source.replace('for(let i=1;i<=5;i++)','for(let i=1;i<=6;i++)')),/numeric_domain_changed/);
});
test("different slot may share one physical device only as explicit extra",()=>{
  const {records}=collectSyntheticSeeds(source);const extra=records.find(f=>f.extra);assert.equal(extra.context.binding.appSlot,"clone");
  extra.extra=false;assert.throws(()=>assertUniqueSeedNames(records),/duplicate_device/);
});
