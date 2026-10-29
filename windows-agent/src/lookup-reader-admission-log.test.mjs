import test from 'node:test';import assert from 'node:assert/strict';
import {createLookupReaderAdmissionLog} from './lookup-reader-admission-log.mjs';
test('logs bounded state transitions without per-poll noise or payload identifiers',()=>{
 let clock=0;const rows=[];const observe=createLookupReaderAdmissionLog({log:(...x)=>rows.push(x),now:()=>clock});
 const full={mode:'reported',reason:'lookup_reader_capacity_full',used:8,limit:8,pinnedSerials:['private'],phoneNumber:'private'};
 observe(full);for(let n=0;n<100;n++){clock+=500;observe(full);}assert.equal(rows.length,1);
 observe({mode:'reported',reason:'lookup_reader_capability_storage_unavailable'});assert.equal(rows.length,1);
 clock=60000;observe({mode:'reported',reason:'lookup_reader_capability_storage_unavailable'});assert.equal(rows.length,2);
 clock=120000;observe({mode:'reported',reason:'lookup_reader_capacity_available',used:1,limit:8});assert.equal(rows.length,3);
 clock=180000;observe({mode:'reported',reason:'lookup_reader_capacity_available'});assert.equal(rows.length,3);
 assert.doesNotMatch(JSON.stringify(rows),/private|pinnedSerials|phoneNumber/);assert.match(rows[2][0],/recovered/);
});
