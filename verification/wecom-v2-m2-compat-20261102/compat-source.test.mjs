import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {auditBodies,addedSetup} from "./audit-source.mjs";
const old=fs.readFileSync(new URL("../wecom-v2-cas-m2-20261102/postgres.integration.mjs",import.meta.url),"utf8"),current=fs.readFileSync(new URL("./postgres.integration.mjs",import.meta.url),"utf8");
test("all original14 expanded M2 test bodies byte equal; only new DDL setup",()=>{const a=auditBodies(old,current);assert.equal(a.originalSha256,"9684a8fd48b7df31e32c7e4072d4c4ea4e5c774146cfa7d220d9d84ef8f13ac3");assert.equal(a.bodies.length,14);assert.equal(new Set(a.bodies.map(x=>x.name)).size,14);});
test("body assertion weakening rejected",()=>{assert.throws(()=>auditBodies(old,current.replace("assert.equal(s.revision, 1)","assert.equal(s.revision, 0)")),/changed_beyond_setup/);});
test("missing new DDL setup rejected",()=>{assert.throws(()=>auditBodies(old,current.replace(addedSetup,"")),/changed_beyond_setup/);});
test("duplicate new DDL setup rejected",()=>{assert.throws(()=>auditBodies(old,current+addedSetup),/changed_beyond_setup/);});
