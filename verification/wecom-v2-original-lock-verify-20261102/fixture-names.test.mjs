import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {fixture} from "../wecom-v2-claim-bundle-20261102/fixture.mjs";
const source=fs.readFileSync(new URL("./postgres.integration.mjs",import.meta.url),"utf8");
function unique(text){const names=[...text.matchAll(/made\("([^"\\]+)"\)/g)].map(m=>m[1]);assert.equal(names.length,6);assert.equal((text.match(/\bmade\(/g)||[]).length,6);const seen=new Set();for(const suffix of names){const f=fixture({suffix,serial:`fixture-${suffix}`});assert.ok(!seen.has(f.input.device.deviceId),"duplicate fixture device");seen.add(f.input.device.deviceId);}return seen.size;}
test("all six actual business fixture seed names unique",()=>{assert.equal(unique(source),6);});
test("cross-group old namespace reuse detected before PG",()=>{assert.throws(()=>unique(source.replace('made("business-cas-one")','made("business-nowait-one")')),/duplicate fixture device/);});
