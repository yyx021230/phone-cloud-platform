import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const root = process.env.RECOVERY_SOURCE_ROOT;
if (!root) throw new Error('RECOVERY_SOURCE_ROOT must point to an isolated source directory');
const source = fs.readFileSync(path.join(root, 'index.mjs'), 'utf8');
const { createGuardedTaskRunner } = await import(pathToFileURL(path.join(root, 'guarded-task-runner.mjs')));
const { createPnpRecoverySafety } = await import(pathToFileURL(path.join(root, 'pnp-recovery-safety.mjs')));
function declaration(name) {
  const re = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const start = source.search(re);
  if (start < 0) return '';
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2);
}
function barrier() { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; }
const tick = () => new Promise(r => setImmediate(r));

function scans() {
  const held = barrier(); let started = 0; let active = 0; let maximum = 0;
  const runner = createGuardedTaskRunner();
  const context = vm.createContext({
    config: { scanIntervalSeconds: 30 }, health: {}, lastDevices: [], lastDevicesScannedAt: 0,
    Date, setInterval: fn => { context.periodic = fn; },
    guardedTasks: runner,
    hasActiveAutomationTask: () => false,
    scanAdbDevices: async () => [], cleanupOfflineAutomationWorkers: async () => {},
    requestSafePnpRescanForMissingDevices: async () => {
      started++; active++; maximum = Math.max(maximum, active);
      await held.promise; active--;
    },
    currentPnpRecoveryHealth: () => ({ actionableCount: 1 }),
    markAutomationPreflightPending() {}, annotateDeviceAutomationStatus() {},
    syncDevicesToPlatform: async () => ({ devices: [] }), rememberServerDevices() {},
    saveDeviceScanCache: async () => {}, log() {}, shouldScheduleSmsBackground: () => false
  });
  vm.runInContext([declaration('runGuardedInterval'), declaration('scanAndSync'), declaration('performDeviceScanAndSync')].join('\n'), context);
  const periodic = source.split('\n').find(l => l.startsWith('setInterval(') && l.includes('config.scanIntervalSeconds'));
  vm.runInContext(periodic, context);
  const post = source.split('\n').find(l => l.includes('await scanAndSync(') && l.includes('post_task'));
  assert.ok(post, 'test exercises actual post-task call site');
  vm.runInContext(`async function postTask() { ${post.trim()} }`, context);
  return { context, held, runner, stats: () => ({ started, active, maximum }) };
}

test('periodic and actual post-task scan share one owner through recovery verification', async () => {
  const h = scans(); const first = h.context.periodic(); await tick();
  const second = h.context.postTask(); await tick(); const stats = h.stats();
  h.held.release(); await Promise.all([first, second]);
  assert.equal(stats.maximum, 1, 'post-task must not stack another recovery batch');
  assert.equal(stats.started, 1);
  await h.context.postTask(); assert.equal(h.stats().started, 2, 'next scan works after settlement');
});

test('a failed installation probe is blocked but is not reported as confirmed installation activity', () => {
  const safety = createPnpRecoverySafety({ continuousRecovery: true });
  const health = safety.observe([{ serial: 'test', state: 'adb_interface_pnp_error', physicalPresent: true }],
    { inventoryReady: true, installerBusy: true, installerUnknown: true });
  assert.equal(health.canMutate, false);
  assert.equal(health.blockedReason, 'device_install_probe_failed');
});

const policy = await import(pathToFileURL(path.join(root, 'pnp-recovery-policy.mjs')));
const { createPnpScreenCoordinator } = await import(pathToFileURL(path.join(root, 'pnp-screen-coordinator.mjs')));
const admissionPath = path.join(root, 'pnp-recovery-admission.mjs');
const admission = fs.existsSync(admissionPath) ? await import(pathToFileURL(admissionPath)) : {};
function targets({ mode = 'restart_adb_interface' } = {}) {
  const gate = barrier(); const actions = []; const events = []; const held = new Set();
  const state = new Map();
  const obs = new Map(['A', 'B'].map(key => [key, { key, serial: key, physicalPresent: true, state: 'adb_interface_pnp_error' }]));
  const coordinator = createPnpScreenCoordinator({ maxConcurrent: 8 });
  let blocked = true; let afterLock = () => {};
  const context = vm.createContext({
    ...policy, ...admission, Date,
    pnpTargetRecoveryAttempts: state, observationsBySerial: obs,
    lastDeviceRecoveryObservations: [...obs.values()],
    isSerialBusy: serial => held.has(serial), isPhysicalPnpInventoryReady: () => true,
    config: { pnpMaxAutomaticAttemptsPerDevice: 5, pnpTargetResetCooldownSeconds: 30,
      pnpTargetRetryMaxSeconds: 120, pnpContinuousRecoveryEnabled: true, pnpPostActionProbeSeconds: 5 },
    planPnpRecoveryAction: ({ previous }) => ({ mode, attempt: (previous.attempts || 0) + 1,
      instanceId: 'USB\\TEST_ONLY', targetType: 'adb_interface', automatic: true }),
    isDeferredPnpRecoveryPlan: () => false, isAutomaticRecoveryAction: () => true,
    safety: { canMutate: true }, rescueKeys: new Set(),
    skipRecoveryIfAdbAlreadyOnline: async serial => { if (blocked && serial === 'A') await gate.promise; return false; },
    pnpRecoveryJournal: { record: e => events.push(e) }, schedulePnpRecoveryStateSave() {}, scheduleNextPnpRecoveryDueWake() {},
    log() {}, persistPnpRecoveryStateNow: async () => {},
    pnpMissingDeviceRecovery: { markReset() {} }, pnpRecoveryWakeScheduler: { schedule() {} },
    pnpRecoverySafety: { recordAction() {}, health: () => ({}), recordFailure() {} },
    publicPnpRecoveryHealth: x => x, lastPnpRecoveryHealth: {},
    pnpScreenCoordinator: { tryBegin: (...args) => { const release = coordinator.tryBegin(...args); if (release) afterLock(); return release; } },
    executePnpRecoveryAction: async plan => { actions.push(plan.mode); return { result: 'test-only' }; },
    run: async () => { actions.push('adb_reconnect'); return 'test-only'; },
    cleanLogText: String
  });
  const begin = source.indexOf('  async function recoverSelectedTarget(serial) {');
  const end = source.indexOf('\n\n  if (batchScope.rescue', begin);
  assert.ok(begin > 0 && end > begin);
  vm.runInContext(source.slice(begin, end), context);
  return { context, gate, actions, events, state, coordinator, held, obs,
    unblock() { blocked = false; gate.release(); }, afterLock(fn) { afterLock = fn; } };
}

for (const mode of ['restart_adb_interface', 'adb_reconnect']) {
  test(`${mode}: a cooldown written during the final ADB probe prevents mutation and preserves attempts`, async () => {
    const h = targets({ mode }); const first = h.context.recoverSelectedTarget('A'); await tick();
    const newer = { policyVersion: 5, attempts: 2, nextRetryAt: Date.now() + 30_000 };
    h.state.set('A', newer); h.unblock(); const result = await first;
    assert.equal(result.actionAttempted, false); assert.equal(result.reason, 'target_recovery_cooldown');
    assert.equal(h.actions.length, 0); assert.equal(h.state.get('A'), newer);
  });
}

test('current cooldown after installer wait is checked before building a new action', async () => {
  const h = targets(); const newer = { policyVersion: 5, attempts: 1, nextRetryAt: Date.now() + 30_000 };
  h.state.set('A', newer); h.unblock(); const result = await h.context.recoverSelectedTarget('A');
  assert.equal(result.actionAttempted, false); assert.equal(h.actions.length, 0); assert.equal(h.state.get('A'), newer);
});

test('target state is rechecked inside the existing PnP lock and lock is released on deferral', async () => {
  const h = targets(); h.unblock();
  h.afterLock(() => h.state.set('A', { policyVersion: 5, inProgress: true }));
  const result = await h.context.recoverSelectedTarget('A');
  assert.equal(result.reason, 'target_recovery_in_progress'); assert.equal(h.actions.length, 0);
  assert.equal(h.coordinator.active, false);
});

test('an old topology snapshot cannot mutate a newly observed interface', async () => {
  const h = targets(); const pending = h.context.recoverSelectedTarget('A'); await tick();
  h.context.lastDeviceRecoveryObservations = [{ ...h.obs.get('A') }, h.obs.get('B')]; h.unblock();
  const result = await pending; assert.equal(result.reason, 'target_recovery_observation_changed'); assert.equal(h.actions.length, 0);
});

test('a replacement state with an elapsed deadline still invalidates the selected plan', async () => {
  const h = targets(); const pending = h.context.recoverSelectedTarget('A'); await tick();
  h.state.set('A', { policyVersion: 5, attempts: 3, nextRetryAt: 1 }); h.unblock();
  const result = await pending; assert.equal(result.reason, 'target_recovery_state_changed'); assert.equal(h.actions.length, 0);
});

test('screen/foreground ownership acquired during the ADB probe prevents PnP', async () => {
  const h = targets(); const pending = h.context.recoverSelectedTarget('A'); await tick();
  h.held.add('A'); h.unblock(); const result = await pending;
  assert.equal(result.actionAttempted, false); assert.equal(h.actions.length, 0); assert.equal(h.coordinator.active, false);
});

test('a stalled phone does not occupy another phone lane; due targets act once', async () => {
  const h = targets(); const first = h.context.recoverSelectedTarget('A'); await tick();
  const other = await h.context.recoverSelectedTarget('B'); assert.equal(other.actionAttempted, true);
  assert.equal(h.actions.length, 1); h.unblock(); assert.equal((await first).actionAttempted, true);
  assert.equal(h.actions.length, 2); assert.equal(h.coordinator.active, false);
  assert.equal((await h.context.recoverSelectedTarget('A')).actionAttempted, false);
  assert.equal(h.actions.length, 2);
});

test('a timed-out scan retains ownership until actual work settles', async () => {
  const h = scans();
  // Shorten only the test clock budget, retaining the production guard.
  vm.runInContext('runGuardedInterval = (name, fn) => guardedTasks.run(name, fn, 5)', h.context);
  const first = await h.context.periodic(); assert.equal(first.timedOut, true);
  const second = h.context.postTask(); await tick(); const stats = h.stats();
  h.held.release(); await second; await tick();
  assert.equal(stats.maximum, 1); assert.equal(h.runner.active('scan'), false);
});

test('scan failures release ownership for later scans', async () => {
  const h = scans(); let calls = 0;
  h.context.scanAdbDevices = async () => { if (!calls++) throw Error('test scan failure'); return []; };
  h.context.heartbeat = async () => {};
  assert.ok((await h.context.periodic()).error);
  h.held.release(); await h.context.postTask(); assert.equal(h.stats().started, 1);
});

const probePath = path.join(root, 'windows-device-install-probe.mjs');
if (fs.existsSync(probePath)) {
  const { createWindowsDeviceInstallProbe } = await import(pathToFileURL(probePath));
  const marker = 'PC_DEVICE_INSTALL_PROBE_V1';
  test('installer probe uses local process enumeration and shares pending reads, not completed idle results', async () => {
    const held = barrier(); let calls = 0;
    const probe = createWindowsDeviceInstallProbe({ run: async (file, args, options) => {
      calls++; assert.equal(file, 'powershell.exe'); assert.equal(options.timeoutMs, 10_000);
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.match(script, /GetProcessesByName\('pnputil'\)/); assert.match(script, /GetProcessesByName\('drvinst'\)/);
      assert.doesNotMatch(script, /Get-CimInstance|Get-WmiObject|Where-Object/); assert.match(script, /\.Dispose\(\)/);
      await held.promise; return marker;
    } });
    const a = probe(), b = probe(); assert.equal(a, b); await tick(); assert.equal(calls, 1);
    held.release(); assert.equal((await a).state, 'idle'); assert.equal((await b).busy, false);
    await probe(); assert.equal(calls, 2);
  });
  test('installer probe identifies real installers and emits timestamp/duration', async () => {
    let now = 1_000;
    const probe = createWindowsDeviceInstallProbe({ now: () => now, run: async () => {
      now += 800; return `${marker}\n21\tdrvinst.exe\tdate\n22\tpnputil.exe\tdate`;
    } });
    const value = await probe(); assert.equal(value.state, 'busy'); assert.equal(value.reason, 'device_install_busy');
    assert.equal(value.processes.length, 2); assert.equal(value.durationMs, 800); assert.ok(value.checkedAt);
  });
  for (const [label, error] of [['timeout', Object.assign(Error('private command must not leak'), { killed: true, code: 'ETIMEDOUT' })],
    ['failure', Object.assign(Error('private command must not leak'), { code: 1 })]]) {
    test(`probe ${label} is unknown, blocks mutations and recovers on next observation`, async () => {
      let calls = 0; const probe = createWindowsDeviceInstallProbe({ run: async () => { if (!calls++) throw error; return marker; } });
      const value = await probe(); assert.equal(value.state, 'unknown'); assert.equal(value.busy, true);
      assert.equal(value.reason, 'device_install_probe_failed'); assert.equal(value.timedOut, label === 'timeout');
      assert.deepEqual(value.processes, []); assert.doesNotMatch(JSON.stringify(value), /private command/);
      assert.equal((await probe()).state, 'idle');
    });
  }
  for (const output of ['', 'WMI failed', `${marker}\nnot-a-process`, `${marker}\n0\tdrvinst.exe`]) {
    test(`malformed probe output fails closed: ${JSON.stringify(output)}`, async () => {
      const value = await createWindowsDeviceInstallProbe({ run: async () => output })();
      assert.equal(value.state, 'unknown'); assert.equal(value.busy, true); assert.equal(value.errorCode, 'invalid_output');
    });
  }
}


test('startup and recovery-wake entry points use the same scan guard', async () => {
  const h = scans();
  h.context.inspectWindowsDeviceInstallActivity = async () => ({ busy: false });
  const first = h.context.periodic(); await tick();
  const startLine = source.split('\n').find(line => line.startsWith('await ') && line.includes('startup scan failed'));
  vm.runInContext(`async function startup() { ${startLine} }`, h.context);
  const begin = source.indexOf('  async run(reason) {', source.indexOf('pnpRecoveryWakeScheduler = createPnpRecoveryWakeScheduler'));
  const end = source.indexOf('\n  onError(error, reason)', begin);
  const wake = source.slice(begin, end).trim().replace(/^async run/, 'async function wake').replace(/,$/, '');
  vm.runInContext(wake, h.context);
  const startup = h.context.startup(); const followup = h.context.wake('pnp_retry_due');
  await tick(); const stats = h.stats(); h.held.release();
  const [, , result] = await Promise.all([first, startup, followup]);
  assert.equal(stats.maximum, 1); assert.equal(stats.started, 1);
  assert.equal(result.skipped, true, 'wake scheduler must receive skipped and reschedule');
});

test('expired physical inventory at action time blocks mutation without consuming attempts', async () => {
  const h = targets(); const pending = h.context.recoverSelectedTarget('A'); await tick();
  h.context.isPhysicalPnpInventoryReady = () => false; h.unblock();
  const result = await pending; assert.equal(result.reason, 'physical_inventory_unavailable');
  assert.equal(h.actions.length, 0); assert.equal(h.state.size, 0);
});
