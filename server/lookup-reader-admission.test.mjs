import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLookupReaderCapacity, canAdmitLookupReader, LOOKUP_READER_REPORT_MAX_AGE_MS} from './lookup-reader-admission.mjs';
import {issueScreenGalleryDelivery, acknowledgeScreenGalleryDelivery, MANAGED_LOOKUP_PROTOCOL} from './managed-lookup-delivery.mjs';

const runtimeId = '3f2ba500-8c87-451b-a0ba-9c5e245b6ad3';
const clock = 1_800_000_000_000;
const report = (limit = 8, pinnedSerials = []) => normalizeLookupReaderCapacity({
  version: 1, runtimeId, limit, pinnedSerials
}, {runtimeId, receivedAt: clock});
const task = (n, extra = {}) => ({taskId: 'task-' + n, agentId: 'agent-a',
  adbSerial: 'SERIAL-' + n, type: 'alipay_name_query', status: 'queued',
  payload: {automationSessionId: 'session-' + n,
    managedLookup: {protocol: MANAGED_LOOKUP_PROTOCOL, generation: 'generation-' + n}}, ...extra});
const decide = (candidate = task(100), extra = {}) => canAdmitLookupReader({task: candidate,
  agentId: 'agent-a', report: report(), now: clock, tasks: [], activeTaskIds: [], ...extra});

test('report binds exact runtime, retains only bounded fields and copies serials', () => {
  const input = {version: 1, runtimeId, limit: 8, pinnedSerials: ['ABC:5555'],
    receivedAt: clock + 999999, privateData: 'must-not-copy'};
  const out = normalizeLookupReaderCapacity(input, {runtimeId, receivedAt: clock});
  assert.deepEqual(out, {version: 1, runtimeId, limit: 8, pinnedSerials: ['ABC:5555'], receivedAt: clock});
  input.pinnedSerials.push('SECOND');
  assert.deepEqual(out.pinnedSerials, ['ABC:5555']);
});

for (const change of [{version: 2}, {runtimeId: 'wrong'}, {limit: 0}, {limit: 17},
  {limit: '8'}, {limit: NaN}, {limit: 1.5}, {pinnedSerials: null},
  {pinnedSerials: ['']}, {pinnedSerials: ['with space']}, {pinnedSerials: ['line\nbreak']},
  {pinnedSerials: ['x'.repeat(161)]}, {limit: 1, pinnedSerials: ['A', 'B']},
  {pinnedSerials: ['abc', 'ABC']}]) {
  test('invalid report fails closed: ' + JSON.stringify(change), () => {
    assert.equal(normalizeLookupReaderCapacity({version: 1, runtimeId, limit: 8,
      pinnedSerials: [], ...change}, {runtimeId, receivedAt: clock}), null);
  });
}

test('missing receipt, malformed runtime and client timestamp cannot stand in for server receipt', () => {
  const input = {version: 1, runtimeId, limit: 8, pinnedSerials: [], receivedAt: clock};
  assert.equal(normalizeLookupReaderCapacity(input, {runtimeId}), null);
  assert.equal(normalizeLookupReaderCapacity(input, {runtimeId, receivedAt: 'now'}), null);
  assert.equal(normalizeLookupReaderCapacity(input, {runtimeId: 'not-a-runtime', receivedAt: clock}), null);
  assert.equal(normalizeLookupReaderCapacity({...input, runtimeId: [runtimeId]}, {
    runtimeId: [runtimeId], receivedAt: clock
  }), null);
  assert.equal(normalizeLookupReaderCapacity(null, {runtimeId, receivedAt: clock}), null);
});

test('stop cleanup and unrelated workflows bypass reader budget even without a report or state', () => {
  for (const candidate of [task(1, {type: 'alipay_name_stop'}), task(1, {type: 'sms_sync_now'}),
    task(1, {payload: {}})]) {
    assert.equal(canAdmitLookupReader({task: candidate}).allowed, true);
  }
});

test('new managed query requires valid fresh report, exact Agent and a physical serial', () => {
  assert.equal(decide(task(1), {report: null}).allowed, false);
  assert.equal(decide(task(1), {now: clock - 1}).reason, 'lookup_reader_report_stale');
  assert.equal(decide(task(1), {now: clock + LOOKUP_READER_REPORT_MAX_AGE_MS - 1}).allowed, true);
  assert.equal(decide(task(1), {now: clock + LOOKUP_READER_REPORT_MAX_AGE_MS}).allowed, false);
  assert.equal(decide(task(1, {agentId: 'other'})).reason, 'lookup_reader_agent_mismatch');
  assert.equal(decide(task(1, {adbSerial: ''})).reason, 'lookup_reader_serial_invalid');
  assert.equal(decide(task(1), {now: NaN}).allowed, false);
});

test('15 delivery attempts issue at most 8 actual unacknowledged leases before any ACK', () => {
  const tasks = Array.from({length: 15}, (_, n) => task(n));
  const leased = [];
  for (const candidate of tasks) {
    if (decide(candidate, {tasks}).allowed) {
      leased.push(issueScreenGalleryDelivery(candidate, {token: 'lease-' + candidate.taskId, nowMs: clock}));
    }
  }
  assert.equal(leased.length, 8);
  assert.equal(new Set(leased.map(t => t.taskId)).size, 8);
  assert.equal(tasks.filter(t => t.status === 'running').length, 0);
  assert.equal(decide(tasks[8], {tasks}).used, 8);
  assert.equal(decide(tasks[8], {tasks}).reason, 'lookup_reader_capacity_full');
});

test('ACKs and duplicate ACKs retain one slot; persistence rollback restores the old claim count', () => {
  const tasks = Array.from({length: 8}, (_, n) => task(n));
  for (const t of tasks) issueScreenGalleryDelivery(t, {token: 'lease-' + t.taskId, nowMs: clock});
  const t = tasks[0], token = t.delivery.token;
  assert.equal(acknowledgeScreenGalleryDelivery(t, token, clock + 1).ok, true);
  assert.equal(acknowledgeScreenGalleryDelivery(t, token, clock + 2).idempotent, true);
  assert.equal(decide(task(9), {tasks}).used, 8);
  const last = tasks[7];
  last.delivery = undefined; // Existing claim rollback restores queued/no lease.
  assert.equal(decide(task(9), {tasks}).used, 7);
  assert.equal(decide(task(9), {tasks}).allowed, true);
});

test('expired lease still declared active, cancellation and terminal outbox each retain the slot', () => {
  for (const status of ['queued', 'cancelled', 'failed', 'succeeded', 'expired']) {
    const t = task(1, {status, delivery: {token: 'old', expiresAt: new Date(clock - 1).toISOString()}});
    const r = decide(task(9), {report: report(1), tasks: [t], activeTaskIds: new Set([t.taskId])});
    assert.equal(r.allowed, false, status);
    assert.equal(r.used, 1, status);
  }
});

test('lease expiry without active execution releases only the budget, not task/generation fences', () => {
  const t = task(1, {delivery: {token: 'old', expiresAt: new Date(clock).toISOString()}});
  const before = structuredClone(t);
  assert.equal(decide(task(9), {report: report(1), tasks: [t]}).allowed, true);
  assert.deepEqual(t, before);
});

test('stalled task is uncertain and cannot silently free a reader slot', () => {
  assert.equal(decide(task(9), {report: report(1), tasks: [task(1, {status: 'stalled'})]}).allowed, false);
});

test('pinned, leased and running claims use the union of case-insensitive serial identities', () => {
  const tasks = [task(1, {status: 'running', adbSerial: 'abc'}),
    task(2, {status: 'queued', adbSerial: 'ABC', delivery: {token: 'l', expiresAt: new Date(clock + 1).toISOString()}})];
  const r = decide(task(9), {report: report(2, ['Abc']), tasks});
  assert.equal(r.used, 1);
  assert.equal(r.allowed, true);
  assert.equal(decide(task(9), {report: report(1, ['Abc']), tasks}).allowed, false);
});

test('two non-lookup pinned workers leave exactly six new claims in an eight-reader pool', () => {
  const tasks = Array.from({length: 15}, (_, n) => task(n));
  let admitted = 0;
  for (const candidate of tasks) if (decide(candidate, {tasks, report: report(8, ['XHS-A', 'XHS-B'])}).allowed) {
    issueScreenGalleryDelivery(candidate, {token: 'lease-' + candidate.taskId, nowMs: clock});
    admitted++;
  }
  assert.equal(admitted, 6);
});

test('same-Agent unrelated running tasks conservatively count; another Agent never consumes this budget', () => {
  const tasks = [task(1, {type: 'xhs_qr_appium', status: 'running'}),
    task(2, {status: 'running', agentId: 'agent-b'})];
  assert.equal(decide(task(9), {tasks, report: report(1)}).used, 1);
  assert.equal(decide(task(9), {tasks: tasks.slice(1), report: report(1)}).allowed, true);
});

test('already-pinned candidate serial needs no new slot; the caller retains per-serial exclusion', () => {
  assert.equal(decide(task(1), {report: report(1, ['serial-1'])}).allowed, true);
});

test('unknown active ID, missing managed serial and malformed input cannot become free capacity', () => {
  assert.equal(decide(task(1), {activeTaskIds: ['not-retained']}).reason, 'lookup_reader_active_task_unknown');
  assert.equal(decide(task(1), {tasks: [task(2, {status: 'running', adbSerial: ''})]}).allowed, false);
  for (const activeTaskIds of ['a,b', [null], [''], Array(33).fill('id')]) {
    assert.equal(decide(task(1), {activeTaskIds}).allowed, false);
  }
  assert.equal(decide(task(1), {tasks: null}).allowed, false);
});

test('decision never mutates task state, report, generation or cancellation records', () => {
  const candidate = task(1), tasks = [task(2, {status: 'running'})], r = report();
  const before = structuredClone({candidate, tasks, r});
  decide(candidate, {tasks, report: r});
  assert.deepEqual({candidate, tasks, r}, before);
});
