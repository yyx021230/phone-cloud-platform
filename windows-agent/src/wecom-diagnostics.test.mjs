import test from 'node:test';
import assert from 'node:assert/strict';
import { wecomProgress, wecomExecution, progressSummary } from './wecom-diagnostics.mjs';
const frame = { version: 1, step: 1, phase: 'foreground_wait', state: 'begin', elapsedMs: 12 };
test('diagnostics accept only bounded fixed phase records, never request or UI fields', () => {
  assert.deepEqual(wecomProgress(frame), frame);
  for (const change of [{ phoneNumber: 'private' }, { text: 'private' }, { phase: 'private' }, { elapsedMs: Infinity }, { step: -1 }, { state: 'sent' }, { cleanupConfirmed: true }]) assert.equal(wecomProgress({ ...frame, ...change }), null);
  assert.equal(wecomProgress(null), null);
});
test('summary keeps explicit failure and cleanup identity without promoting delivery', () => {
  const events = [frame, { ...frame, step: 2, state: 'error', elapsedMs: 18 },
    { ...frame, step: 3, phase: 'cleanup', state: 'end', elapsedMs: 20, cleanupConfirmed: false }];
  const value = progressSummary(events);
  assert.deepEqual(wecomExecution(value), value);
  assert.equal(value.failurePhase, 'foreground_wait'); assert.equal(value.cleanupConfirmed, false);
  assert.equal(value.invitationSent, undefined); assert.equal(progressSummary([]), null);
  for (const change of [{ phase: 'private' }, { failurePhase: 'private' }, { events: [...events, frame] }, { events: Array(25).fill(frame) }, { cleanupConfirmed: 'true' }]) assert.equal(wecomExecution({ ...value, ...change }), null);
  assert.equal(JSON.stringify(wecomExecution({ ...value, phoneNumber: 'private', error: 'raw library text' })).includes('private'), false);
});
