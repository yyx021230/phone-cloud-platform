import test from 'node:test';
import assert from 'node:assert/strict';
import { runContinuousLoad } from './continuous-load.mjs';
const turn = () => new Promise(resolve => setImmediate(resolve));
test('one pending call does not prevent another lane from feeding subsequent calls', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  let active = 0, maxActive = 0;
  const run = runContinuousLoad([1, 2, 3, 4, 5], { concurrency: 2, execute: async item => {
    started.push(item); active++; maxActive = Math.max(maxActive, active);
    if (item === 1) await gate;
    active--; return item;
  } });
  await turn();
  assert.deepEqual(started, [1, 2, 3, 4, 5]);
  assert.equal(active, 1);
  assert.equal(maxActive, 2);
  release();
  const results = await run;
  assert.deepEqual(results.map(r => r.value), [1, 2, 3, 4, 5]);
});
test('a rejected call is recorded without cancelling the other calls', async () => {
  const results = await runContinuousLoad([1, 2, 3], { concurrency: 2, execute: async item => {
    if (item === 1) throw new Error('synthetic failure');
    return item;
  } });
  assert.equal(results[0].status, 'rejected');
  assert.deepEqual(results.slice(1).map(r => r.value), [2, 3]);
});
test('stop prevents new calls while retaining already running outcomes', async () => {
  let stop = false;
  const started = [];
  const results = await runContinuousLoad([1, 2, 3, 4], { concurrency: 2, shouldStop: () => stop, execute: async item => {
    started.push(item); await turn(); stop = true; return item;
  } });
  assert.deepEqual(started, [1, 2]);
  assert.equal(results.filter(Boolean).length, 2);
});
