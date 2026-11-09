import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRecoveryIsolation } from '../candidate/windows-agent/src/recovery-isolation.mjs';

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recovery-status-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let clock = 1_000, fail = false, saved;
  const args = { file: path.join(dir, 'isolation.json'), agentId: 'fixture', now: () => clock,
    write: async value => { if (fail) throw Error('disk_failure'); saved = structuredClone(value); }, ...options };
  const store = await createRecoveryIsolation(args);
  const scan = (at, rows = [{ adbSerial: 'online-a', state: 'device' }], policy) => {
    clock = at;
    return store.observeAdb({ observedAt: at, devices: rows }, policy);
  };
  return { store, args, scan, dir, saved: () => saved, setNow: at => { clock = at; }, fail: v => { fail = v; } };
}
async function stable(f, serial = 'online-a', start = 1_000) {
  for (const at of [start, start + 30_000, start + 60_000]) {
    assert.deepEqual(await f.scan(at, [{ adbSerial: serial, state: 'device' }]), []);
  }
  return f.scan(start + 90_000, [{ adbSerial: serial, state: 'device' }]);
}
test('historical isolated target without an attempt is cleared only after fresh stable scans; other target stays isolated', async t => {
  const f = await fixture(t);
  await f.store.isolate('online-a'); await f.store.isolate('offline-b');
  assert.deepEqual(await stable(f), ['ONLINE-A']);
  assert.equal(f.store.reason('online-a'), '');
  assert.equal(f.store.reason('offline-b'), 'device_recovery_isolated');
  const row = f.saved().targets['ONLINE-A'];
  assert.equal(row.recoveredAt, 91_000);
  assert.equal(row.lastIsolation.reason, 'recovery_attempts_exhausted');
  assert.equal(row.lastIsolation.isolatedAt, 1_000);
  assert.equal(row.releaseRevision, 0);
});
test('single device state and repeated same snapshot cannot release isolation', async t => {
  const f = await fixture(t); await f.store.isolate('online-a');
  await f.scan(1_000);
  for (const at of [10_000, 20_000, 30_000]) {
    f.setNow(at); await f.store.observeAdb({ observedAt: 1_000, devices: [{ adbSerial: 'online-a', state: 'device' }] });
  }
  assert.equal(f.store.reason('online-a'), 'device_recovery_isolated');
});
test('scan count and duration are independent; invalid policy cannot weaken either bound', async t => {
  const f = await fixture(t); await f.store.isolate('online-a');
  for (const at of [1_000, 2_000, 3_000, 4_000]) await f.scan(at);
  assert.equal(f.store.reason('online-a'), 'device_recovery_isolated');
  await f.scan(34_000, undefined, {minStableMs: 1, minStableScans: 1});
  for (const at of [64_000, 94_000, 124_000, 154_000]) {
    assert.deepEqual(await f.scan(at, undefined, {minStableScans: 5}), []);
  }
  assert.deepEqual(await f.scan(184_000, undefined, {minStableScans: 5}), ['ONLINE-A']);
});
test('observation owns a copy and never edits a manual pause file', async t => {
  const f = await fixture(t); await f.store.isolate('online-a');
  const pauseFile=path.join(f.dir,'pnp-recovery-control.json');
  const pauseBytes=JSON.stringify({revision:52,paused:[{serial:'ONLINE-A'}]});
  await fs.writeFile(pauseFile,pauseBytes);
  const devices=[{adbSerial:'online-a',state:'device'}];
  const pending=f.store.observeAdb({observedAt:1_000,devices});
  devices[0].state='offline';await pending;
  await f.scan(31_000);await f.scan(61_000);
  assert.deepEqual(await f.scan(91_000),['ONLINE-A']);
  assert.equal(await fs.readFile(pauseFile,'utf8'),pauseBytes);
});
for (const [name, rows] of [
  ['missing', []], ['offline', [{ adbSerial: 'online-a', state: 'offline' }]],
  ['unauthorized', [{ adbSerial: 'online-a', state: 'unauthorized' }]],
  ['ambiguous duplicate', [{ adbSerial: 'online-a', state: 'device' }, { adbSerial: 'ONLINE-A', state: 'offline' }]]
]) test(`${name} interrupts stability and cannot release`, async t => {
  const f = await fixture(t); await f.store.isolate('online-a');
  await f.scan(1_000); await f.scan(31_000); await f.scan(61_000, rows);
  await f.scan(91_000); await f.scan(121_000);
  assert.equal(f.store.reason('online-a'), 'device_recovery_isolated');
  await f.scan(151_000); assert.deepEqual(await f.scan(181_000), ['ONLINE-A']);
});
test('stale, future, regressing, invalid snapshots and long gaps discard prior proof', async t => {
  for (const kind of ['stale', 'future', 'regressing', 'invalid', 'gap']) {
    const f = await fixture(t); await f.store.isolate('online-a');
    await f.scan(1_000); await f.scan(31_000);
    if (kind === 'gap') await f.scan(121_000);
    else {
      f.setNow(61_000);
      const at = ({ stale: 10_000, future: 62_000, regressing: 30_000 })[kind];
      await f.store.observeAdb(kind === 'invalid' ? { observedAt: 61_000, devices: null } : {
        observedAt: at, devices: [{ adbSerial: 'online-a', state: 'device' }] });
    }
    await f.scan(151_000); await f.scan(181_000);
    assert.equal(f.store.reason('online-a'), 'device_recovery_isolated', kind);
  }
});
test('restart loses ephemeral proof and preserves durable isolation; successful clear survives restart', async t => {
  const f = await fixture(t); await f.store.isolate('online-a');
  await f.scan(1_000); await f.scan(31_000); await f.scan(61_000);
  await fs.writeFile(f.args.file, JSON.stringify(f.saved()));
  let clock = 91_000;
  const restarted = await createRecoveryIsolation({ ...f.args, now: () => clock, write: value => fs.writeFile(f.args.file, JSON.stringify(value)) });
  for (clock of [91_000, 121_000, 151_000]) {
    assert.deepEqual(await restarted.observeAdb({ observedAt: clock, devices: [{ adbSerial: 'ONLINE-A', state: 'device' }] }), []);
  }
  clock = 181_000;
  assert.deepEqual(await restarted.observeAdb({ observedAt: clock, devices: [{ adbSerial: 'online-a', state: 'device' }] }), ['ONLINE-A']);
  assert.equal((await createRecoveryIsolation(f.args)).reason('online-a'), '');
});
test('new release/reisolation cannot reuse old stable proof, even with same timestamp', async t => {
  const f = await fixture(t); await f.store.isolate('online-a');
  await f.scan(1_000); await f.scan(31_000); await f.scan(61_000);
  await f.store.release({ releases: [{ serial: 'ONLINE-A', revision: 7 }] });
  await f.store.isolate('online-a');
  await f.scan(91_000);
  assert.equal(f.store.reason('online-a'), 'device_recovery_isolated');
  assert.equal(f.saved().targets['ONLINE-A'].releaseRevision, 7);
});
test('a missed 30-second scan resets stability rather than bridging an unobserved minute',async t=>{
  const f=await fixture(t);await f.store.isolate('online-a');
  await f.scan(1_000);await f.scan(31_000);await f.scan(91_000);await f.scan(121_000);await f.scan(151_000);
  assert.equal(f.store.reason('online-a'),'device_recovery_isolated');
  assert.deepEqual(await f.scan(181_000),['ONLINE-A']);
});
test('slow durable write leaves isolation closed and cannot accumulate observation writes',async t=>{
  let resolveWrite,slow=false,writes=0;
  const f=await fixture(t,{write:async()=>{writes++;if(slow)await new Promise(r=>{resolveWrite=r;});}});
  await f.store.isolate('online-a');await f.scan(1_000);await f.scan(31_000);await f.scan(61_000);
  slow=true;const pending=f.scan(91_000);
  await new Promise(r=>setImmediate(r));
  assert.equal(f.store.reason('online-a'),'device_recovery_isolated');
  assert.deepEqual(await f.scan(121_000),[]);assert.deepEqual(await f.scan(151_000),[]);
  assert.equal(writes,2);resolveWrite();await pending;
});
test('failed durable confirmation never opens target; next fresh observation can retry', async t => {
  const f = await fixture(t); await f.store.isolate('online-a');
  await f.scan(1_000); await f.scan(31_000); await f.scan(61_000);
  f.fail(true); await assert.rejects(f.scan(91_000), /recovery_isolation_save_failed/);
  assert.equal(f.store.health().isolated.length, 1);
  f.fail(false); assert.deepEqual(await f.scan(121_000), ['ONLINE-A']);
  assert.equal(f.store.reason('online-a'), '');
});
test('corrupt store remains closed and unchanged when online observations arrive', async t => {
  const f = await fixture(t); await fs.writeFile(f.args.file, 'invalid');
  const store = await createRecoveryIsolation(f.args);
  await assert.rejects(store.observeAdb({ observedAt: 1_000, devices: [] }), /recovery_isolation_load_failed/);
  assert.equal(await fs.readFile(f.args.file, 'utf8'), 'invalid');
});

const uiSource = await fs.readFile(new URL('../candidate/public/recovery-console.js', import.meta.url), 'utf8');
const publishSource = await fs.readFile(new URL('../candidate/windows-agent/src/publish-device-snapshot.mjs', import.meta.url), 'utf8');
function uiFixture({ queue = [], holds = ['ONLINE-A'], paused = [], devices, online = true, recoveryMode } = {}) {
  const agent = { agentId: 'fixture', lastSeenAt: online, recoveryControl: { revision: 7, paused: paused.map(serial => ({ serial })) },
    health: { recoveryControl: { protocol: 'device_recovery_control_v1', isolationReset: true, revision: 7, synced: true,
      isolated: holds.map(serial => ({ serial, isolatedAt: '2026-11-01T00:00:00Z', reason: 'recovery_attempts_exhausted' })) },
      deviceRecovery: { observedAt: new Date().toISOString(), queue, recoveryMode } } };
  const c = { state: { agents: [agent], windowsRecoveryFilter: 'all', devices: devices || [{ deviceName: 'test-online', adb: { agentId: 'fixture', serial: 'online-a' }, recovery: { state: 'adb_device' } }] },
    els: { windowsRecoveryConsole: { innerHTML: '' } }, isOnline: Boolean, escapeHtml: value => String(value ?? ''), shortTime: value => value || '',
    api: () => { throw Error('network_forbidden'); }, loadAll: () => { throw Error('network_forbidden'); } };
  vm.runInNewContext(uiSource + '\nrenderWindowsRecoveryConsole();', c);
  return c;
}
test('healthy isolated phone is in historical settings, not recovery queue or release action', () => {
  const c = uiFixture(); const html = c.els.windowsRecoveryConsole.innerHTML;
  assert.match(html, /恢复设置与历史隔离/);
  assert.match(html, /旧隔离待稳定核对/);
  assert.doesNotMatch(html, /解除隔离并继续/);
  assert.match(html, /recovery-kpi is-queue[^]*?<strong>0<\/strong>/);
});
test('empty continuous mode does not show ongoing recovery or imply every phone is online', () => {
  const c=uiFixture({recoveryMode:'continuous_recovery'});
  assert.doesNotMatch(c.els.windowsRecoveryConsole.innerHTML,/异常设备持续恢复<\/strong>/);
  assert.match(c.els.windowsRecoveryConsole.innerHTML,/当前无待恢复项/);
});
test('healthy paused record retains pending, acknowledged and offline feedback without joining recovery queue',()=>{
  const c=uiFixture({holds:[],paused:['ONLINE-A']});
  const agent=c.state.agents[0];
  agent.health.recoveryControl.revision=6;
  vm.runInNewContext('renderWindowsRecoveryConsole()',c);
  assert.match(c.els.windowsRecoveryConsole.innerHTML,/暂停待确认/);
  assert.match(c.els.windowsRecoveryConsole.innerHTML,/继续自动恢复/);
  agent.health.recoveryControl.revision=7;
  vm.runInNewContext('renderWindowsRecoveryConsole()',c);
  assert.match(c.els.windowsRecoveryConsole.innerHTML,/自动恢复已暂停/);
  agent.lastSeenAt=false;
  vm.runInNewContext('renderWindowsRecoveryConsole()',c);
  assert.match(c.els.windowsRecoveryConsole.innerHTML,/暂停待确认/);
  assert.match(c.els.windowsRecoveryConsole.innerHTML,/recovery-kpi is-queue[^]*?<strong>0<\/strong>/);
});
test('previous release revision cannot mislabel healthy historical isolation as a present device fault',()=>{
  const c=uiFixture();
  const agent=c.state.agents[0];
  agent.recoveryControl.releases=[{serial:'ONLINE-A',revision:7}];
  vm.runInNewContext('renderWindowsRecoveryConsole()',c);
  assert.doesNotMatch(c.els.windowsRecoveryConsole.innerHTML,/设备仍有故障/);
  c.state.windowsRecoveryRequests=new Map([[JSON.stringify(['fixture','ONLINE-A']),{
    kind:'release',phase:'submitted',revision:7,startedAt:Date.now()-100_000,
    previousIsolationAt:'2026-11-01T00:00:00Z'}]]);
  vm.runInNewContext('renderWindowsRecoveryConsole()',c);
  assert.match(c.els.windowsRecoveryConsole.innerHTML,/以连续在线扫描核对旧隔离/);
  assert.doesNotMatch(c.els.windowsRecoveryConsole.innerHTML,/故障仍在/);
});
test('real abnormal isolated, unauthorized and in-progress items remain in queue; manual pause remains accessible', () => {
  const c = uiFixture({ holds: ['ONLINE-A', 'OFFLINE-B'], paused: ['PAUSED-C'], queue: [
    { serial: 'OFFLINE-B', deviceName: 'bad', state: 'adb_offline' },
    { serial: 'UNAUTHORIZED-D', deviceName: 'auth', state: 'adb_unauthorized' },
    { serial: 'FINISHING-E', deviceName: 'finishing', state: 'adb_device', inProgress: true }
  ] });
  const html = c.els.windowsRecoveryConsole.innerHTML;
  assert.match(html, /recovery-kpi is-queue[^]*?<strong>3<\/strong>/);
  assert.match(html, /解除隔离并继续/); assert.match(html, /继续自动恢复/);
  assert.match(html, /待授权/); assert.match(html, /正在执行/);
  assert.deepEqual(c.state.agents[0].recoveryControl.paused.map(x => x.serial), ['PAUSED-C']);
});
test('historical absent/unknown records are retained separately, not called recovered; offline Agent cannot prove recovery', () => {
  const c = uiFixture({ holds: ['ABSENT-A', 'UNKNOWN-B'], online: false, devices: [] });
  const html = c.els.windowsRecoveryConsole.innerHTML;
  assert.match(html, /ABSENT-A/); assert.match(html, /UNKNOWN-B/);
  assert.match(html, /recovery-kpi is-queue[^]*?<strong>0<\/strong>/);
  assert.doesNotMatch(html, /所有已物理连接的手机都已到达 ADB 在线状态/);
});
test('publish path enqueues observation without waiting for storage, keeps publication, and does not call ADB/PnP/control', async () => {
  let observerRows, observed = false, published = false;
  const logs = [];
  const c = { recoveryIsolation: { observeAdb(snapshot) { observed = true; observerRows = structuredClone(snapshot.devices); return new Promise(() => {}); } },
    config: { pnpRecoveryStableSeconds: 90, pnpRecoveryStableScans: 3 }, health: {}, lastDevices: [], lastDevicesScannedAt: 0,
    hasActiveAutomationTask: () => false, buildDeviceRecoveryObservations: () => [], lastPhysicalPnpInventory: [],
    cachedAdbSerials: () => [], lastServerDevicesById: new Map(), isPhysicalPnpInventoryReady: () => true,
    appendPhysicalRecoveryRows: rows => rows.push({ adbSerial: 'synthetic', state: 'offline' }),
    currentPnpRecoveryHealth: () => ({}), markAutomationPreflightPending() {}, annotateDeviceAutomationStatus() {},
    async syncDevicesToPlatform(rows) { published = true; return { devices: rows }; }, rememberServerDevices() {},
    async saveDeviceScanCache() {}, log: (...args) => logs.push(args) };
  vm.runInNewContext(publishSource, c);
  await c.publishDeviceSnapshot({ observedAt: Date.now(), devices: [{ adbSerial: 'ONLINE-A', state: 'device' }] });
  assert.equal(observed, true); assert.equal(published, true);
  assert.equal(observerRows.length, 1); assert.equal(c.lastDevices.length, 2);
});
test('observation error is handled without blocking normal publication', async () => {
  const c = { recoveryIsolation: { observeAdb: () => Promise.reject(Error('recovery_isolation_save_failed')) },
    config: { pnpRecoveryStableSeconds: 90, pnpRecoveryStableScans: 3 }, health: {}, hasActiveAutomationTask: () => false,
    buildDeviceRecoveryObservations: () => [], lastPhysicalPnpInventory: [], cachedAdbSerials: () => [], lastServerDevicesById: new Map(),
    isPhysicalPnpInventoryReady: () => true, appendPhysicalRecoveryRows() {}, currentPnpRecoveryHealth: () => ({}),
    markAutomationPreflightPending() {}, annotateDeviceAutomationStatus() {}, async syncDevicesToPlatform() { return { devices: [] }; },
    rememberServerDevices() {}, async saveDeviceScanCache() {}, log() {} };
  vm.runInNewContext(publishSource, c); await c.publishDeviceSnapshot({ observedAt: Date.now(), devices: [] });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(c.health.lastScan.ok, true);
});
