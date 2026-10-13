import test from 'node:test';import assert from 'node:assert/strict';import {runAsyncHttp} from '../verification/async-http.mjs';
test('asynchronous actual HTTP/SDK retains one query across fresh keys, response loss, restart and reads',{timeout:30000},async()=>{const proof=await runAsyncHttp();assert.equal(proof.actualCloudQueryTasks,1);assert.ok(proof.drained);});
