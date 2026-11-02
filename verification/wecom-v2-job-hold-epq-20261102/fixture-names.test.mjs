import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {fixture} from "../wecom-v2-claim-bundle-20261102/fixture.mjs";
const source=fs.readFileSync(new URL("./postgres.integration.mjs",import.meta.url),"utf8");
function names(text){
  const variants=JSON.parse(/for\(const kind of(\[[^\]]+\])\)test/.exec(text)?.[1]||"null");assert.ok(Array.isArray(variants)&&variants.length===4);
  assert.equal((text.match(/\bmade\(/g)||[]).length,1);assert.ok(text.includes('made(`projection-${kind}`)'));
  return variants.map(v=>`projection-${v}`);
}
function unique(values){const seen=new Set();for(const suffix of values){const f=fixture({suffix,serial:`fixture-${suffix}`});assert.ok(!seen.has(f.input.device.deviceId),"duplicate fixture device");seen.add(f.input.device.deviceId);}return seen.size;}
test("all four actual job/hold seed namespaces unique",()=>{assert.equal(unique(names(source)),4);});
test("reused role name caught before PG",()=>{assert.throws(()=>unique(names(source.replace('"job-negative"','"job-guarded"'))),/duplicate fixture device/);});
