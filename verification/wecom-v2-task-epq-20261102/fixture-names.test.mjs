import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {fixture} from "../wecom-v2-claim-bundle-20261102/fixture.mjs";
const source=fs.readFileSync(new URL("./postgres.integration.mjs",import.meta.url),"utf8");
function names(text){
  const variants=JSON.parse(/for\(const kind of(\[[^\]]+\])\)test/.exec(text)?.[1]||"null");assert.ok(Array.isArray(variants)&&variants.length===3);
  assert.equal((text.match(/made\(`epq-\$\{kind\}`\)/g)||[]).length,1);
  const literals=[...text.matchAll(/made\("([^"\\]+)"\)/g)].map(m=>m[1]);assert.equal(literals.length,2);
  assert.equal((text.match(/\bmade\(/g)||[]).length,3);
  return [...variants.map(v=>`epq-${v}`),...literals];
}
function unique(values){const seen=new Set();for(const suffix of values){const f=fixture({suffix,serial:`fixture-${suffix}`});assert.ok(!seen.has(f.input.device.deviceId),"duplicate fixture device");seen.add(f.input.device.deviceId);}return seen.size;}
test("all five actual EPQ/savepoint seed device names unique",()=>{assert.equal(unique(names(source)),5);});
test("reuse of earlier EPQ namespace is detected before PG",()=>{assert.throws(()=>unique(names(source.replace('made("savepoint-one")','made("epq-guarded-update")'))),/duplicate fixture device/);});
