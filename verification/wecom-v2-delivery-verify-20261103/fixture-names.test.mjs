import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {made} from "./fixture.mjs";
import {createWecomV2ClaimPreparer} from "../../server/wecom-cleanup-v2-claim.mjs";
const source=fs.readFileSync(new URL("./postgres.integration.mjs",import.meta.url),"utf8");
function unique(text){const names=[...text.matchAll(/made\("([^"\\]+)"\)/g)].map(m=>m[1]);assert.equal(names.length,2);assert.equal((text.match(/\bmade\(/g)||[]).length,2);const seen=new Set();for(const suffix of names){const f=made(suffix);assert.ok(!seen.has(f.input.device.deviceId),"duplicate fixture device");seen.add(f.input.device.deviceId);const bundle=createWecomV2ClaimPreparer({readClaimContext:()=>f.context})(f.input);assert.deepEqual(bundle.candidate.windowsTask.fixtureOpaque,f.input.task.fixtureOpaque);}return seen.size;}
test("both actual delivery seeds unique and unknown JSON accepted by real preparer",()=>{assert.equal(unique(source),2);});
test("old namespace reuse rejected before PG",()=>{assert.throws(()=>unique(source.replace('made("delivery-stale-proposal")','made("delivery-fields")')),/duplicate fixture device/);});
