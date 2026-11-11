import test from 'node:test';import assert from 'node:assert/strict';
import {buildLookupReaderCapacityReport} from './lookup-reader-capacity-report.mjs';
test('report includes actual non-evictable readers once and omits idle warm or exited readers',()=>{
 const workers=new Map([['busy',{pending:{}}],['stopping',{stopping:true}],['task',{}],['screen',{}],['preflight',{}],['idle',{}],['dead',{exited:true}]]);
 const x={runtimeId:'runtime',limit:8,workers,activeSerials:new Set(['task','busy','xml-with-no-reader']),screenControlledSerials:new Set(['screen']),preflightSerials:new Set(['preflight'])};
 const before=structuredClone(workers);assert.deepEqual(buildLookupReaderCapacityReport(x),{version:1,runtimeId:'runtime',limit:8,pinnedSerials:['busy','stopping','task','screen','preflight']});assert.deepEqual(workers,before);
});
test('invalid capacity cannot silently become unlimited or a misleading empty snapshot',()=>{
 for(const limit of [0,-1,1.5,NaN,Infinity,'8',17])assert.equal(buildLookupReaderCapacityReport({limit,workers:new Map()}),null);
 assert.equal(buildLookupReaderCapacityReport({limit:8}),null);
 const workers=new Map(Array.from({length:201},(_,n)=>[String(n),{stopping:true}]));assert.equal(buildLookupReaderCapacityReport({limit:8,workers}),null);
});
