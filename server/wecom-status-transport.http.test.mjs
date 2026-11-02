import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runWecomPreviewTask } from '../windows-agent/src/wecom-preview-task.mjs';
import { WECOM_PREVIEW_DEVICES } from './wecom-preview.mjs';
import { createSimulatedWecomCleanup } from './wecom-causal-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const source = await fs.readFile(new URL('../windows-agent/src/index.mjs', import.meta.url), 'utf8');
function actualFunction(name) {
  const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^\\}', 'm'));
  assert.ok(match, 'actual Agent function ' + name);
  return match[0];
}
function agentContext(api, execute) {
  const context = vm.createContext({ Buffer, api, log: () => {}, taskEvent: async () => {},
    taskWecomPreview: execute, isAutomationTaskCancellation: () => false, isScreenPriorityCancellation: () => false,
    captureFailureEvidence: () => assert.fail('WeCom must not start a separate phone evidence reader'),
    shouldRunPostTaskDeviceScan: () => assert.fail('WeCom must not trigger a global scan'),
    compactScreenshotForTransport: value => { assert.equal(value, null); return null; } });
  for (const name of ['normalizeEvidenceForTransport', 'compactEventDetail', 'compactTaskResultForEvent',
    'compactTaskResultForStatus', 'taskFailureResult', 'taskStatus', 'runTask']) {
    vm.runInContext(actualFunction(name), context);
  }
  return context;
}

async function fixture(t) {
  let cleanupFixture;
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-status-wire-'));
  const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child;
  async function stop() {
    if (child?.exitCode === null) {
      const exited = once(child, 'exit'); child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited; clearTimeout(timer);
    }
  }
  t.after(async () => { await stop(); await fs.rm(data, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'], env: {
      PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data,
      DATABASE_URL: '', REDIS_URL: '', STORAGE_BACKEND: 'json', STRUCTURED_WRITES: 'true',
      ADMIN_USERNAME: 'fixture_admin', ADMIN_PASSWORD: 'fixture-password',
      PUBLIC_BASE_URL: origin, SCREEN_MEDIA_AUTH_SECRET: 'fixture-only-secret', WINDOWS_AGENT_ONLINE_SECONDS: '300'
    } });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { if ((await fetch(origin + '/readyz')).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('isolated JSON service not ready');
  }
  async function request(method, route, token, body, expected = 200) {
    const r = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(5000) });
    const result = await r.json(); assert.equal(r.status, expected, `${method} ${route}`);
    await cleanupFixture?.observe(method, route, body, result); return result;
  }
  await start();
  const admin = (await request('POST', '/api/v1/auth/login', '', { username: 'fixture_admin', password: 'fixture-password' })).session.token;
  const agent = (await request('POST', '/api/v1/windows-agents', admin, { agentId: 'wire-fixture', agentName: 'Synthetic' }, 201)).token;
  const serial = WECOM_PREVIEW_DEVICES['59'].serial;
  await request('POST', '/api/v1/windows-agents/wire-fixture/devices/sync', agent,
    { agent: { agentId: 'wire-fixture' }, devices: [{ adbSerial: serial, state: 'device', model: 'Synthetic' }] });
  await request('PUT', '/api/v1/devices/' + encodeURIComponent('adb:' + serial), admin,
    { deviceName: '59', listingStatus: 'listed' });
  cleanupFixture = createSimulatedWecomCleanup({ request, agentId: 'wire-fixture', token: agent,
    nextRoute: '/api/v1/windows-agents/wire-fixture/tasks/next?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1' });
  return { request, admin, agent, restart: async () => { await stop(); await start(); } };
}

test('real Agent runTask -> taskStatus -> compactor -> HTTP persistence -> public result retains WeCom states',
  { timeout: 30000 }, async t => {
    const f = await fixture(t), retained = [], proofs = [];
    const samples = [
      { name: 'native click attempt remains unknown', claimed: true, workerStatus: 'succeeded', publicStatus: 'unknown',
        result: { previewStatus: 'send_attempted', previewCode: 'invitation_click_issued_delivery_unknown',
          sendStatus: 'unknown', invitationSent: null, remarkSaveStatus: 'confirmed' } },
      { name: 'definite prewrite block remains failed/not_attempted', workerStatus: 'failed', publicStatus: 'failed',
        result: { previewStatus: 'blocked', previewCode: 'not_found', sendStatus: 'not_attempted',
          invitationSent: false, remarkSaveStatus: 'not_attempted' } },
      { name: 'unknown remark save remains held without a send claim', workerStatus: 'failed', publicStatus: 'unknown',
        result: { previewStatus: 'blocked', previewCode: 'remark_persistence_unconfirmed', sendStatus: 'not_attempted',
          invitationSent: false, remarkSaveStatus: 'unknown' } },
      { name: 'actual Python identity guard -> child wrapper -> Agent -> HTTP diagnostics', nativeFixture: true,
        workerStatus: 'failed', publicStatus: 'unknown',
        result: { previewStatus: 'blocked', previewCode: 'adb_identity_unconfirmed', sendStatus: 'not_attempted',
          invitationSent: false, remarkSaveStatus: 'unknown' } },
      { name: 'actual parent timeout catch stays unknown and exposes its code', workerStatus: 'failed', publicStatus: 'unknown',
        error: 'wecom_preview_worker_timeout_no_replay',
        result: { previewStatus: 'blocked', previewCode: 'wecom_preview_worker_timeout_no_replay',
          sendStatus: 'unknown', invitationSent: null, remarkSaveStatus: 'unknown' } }
    ];
    for (const [index, sample] of samples.entries()) await t.test(sample.name, async () => {
      const body = { deviceNumber: '59', appSlot: 'main', phoneNumber: '1990000000' + (index + 1), remarkName: '本地序列化测试' };
      const submitted = await f.request('POST', '/api/v1/wecom/customer-invitations', f.admin, body, 202);
      const task = (await f.request('GET', '/api/v1/windows-agents/wire-fixture/tasks/next?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1&wecomCausalProtocol=wecom-causal-v1', f.agent)).task;
      assert.equal(task.payload.automationJobId, submitted.taskId);
      if (sample.claimed) await f.request('POST', `/api/v1/windows-agents/wire-fixture/wecom-preview-tasks/${task.taskId}/send-claim`, f.agent, {}, 201);
      const writes = [];
      const actual = agentContext(async (route, options) => {
        assert.equal(route, `/api/v1/windows-agent-tasks/${task.taskId}/status`);
        writes.push(JSON.parse(JSON.stringify(options.body)));
        return f.request(options.method, route, f.agent, options.body);
      }, async () => {
        if (sample.nativeFixture) {
          // This case checks the pre-existing identity diagnostic transport,
          // with a synthetic physical lifecycle. The separate integrated v1
          // test exercises the actual host-ready/close/proof product path.
          const diagnosticTask = { ...task, payload: { ...task.payload } };
          delete diagnosticTask.payload.physicalCleanup;
          return runWecomPreviewTask(diagnosticTask, { config: { pythonCommand: 'python3', agentId: 'wire-fixture', serverBaseUrl: 'http://127.0.0.1', agentToken: 'fixture-only-token' }, agentDir: path.join(root, 'windows-agent'),
            spawnChild: (_command, _args, options) => spawn('python3', [path.join(root, 'verification/wecom-native-diagnostics-20261030/native_diagnostic_fixture.py')], options) });
        }
        if (sample.error) throw Object.assign(new Error(sample.error), {diagnostic: {wecomExecution: {version:1,phase:'selector_click',failurePhase:'',elapsedMs:230000,cleanupConfirmed:null,events:[{version:1,step:1,phase:'selector_click',state:'begin',elapsedMs:12}]}}});
        return { ...sample.result, privateWecomField: 'must_not_cross_status_transport' };
      });
      await actual.runTask(task);
      assert.equal(writes.length, 1); assert.equal(writes[0].status, sample.workerStatus);
      for (const [key, value] of Object.entries(sample.result)) assert.equal(writes[0].result[key], value, 'wire preserves ' + key);
      assert.equal(writes[0].result.privateWecomField, undefined);
      const view = await f.request('GET', '/api/v1/wecom/customer-invitations/' + submitted.taskId, f.admin);
      assert.equal(view.status, sample.publicStatus); assert.equal(view.code, sample.result.previewCode);
      if (sample.nativeFixture || sample.error) {
        assert.equal(view.execution.version,1);
        assert.equal(view.execution.failurePhase, sample.nativeFixture ? 'adb_identity' : '');
        assert.equal(view.execution.phase, sample.nativeFixture ? 'adb_identity' : 'selector_click');
        assert.equal(JSON.stringify(view.execution).includes('fixture-only-token'),false);
        assert.deepEqual(writes[0].result.diagnostic.wecomExecution,view.execution);
      }
      const detail = (await f.request('GET', '/api/v1/user/automation/wecom-preview-tasks/' + submitted.taskId, f.admin)).task;
      assert.equal(detail.result.status, sample.result.previewStatus);
      assert.equal(detail.result.remarkSaveStatus, sample.result.remarkSaveStatus);
      assert.equal(detail.result.sendStatus, sample.result.sendStatus);
      assert.equal(detail.result.invitationSent, sample.result.invitationSent);
      retained.push({ body, taskId: submitted.taskId, view, held: sample.publicStatus === 'unknown' });
      proofs.push({ scenario: sample.name, status: view.status, code: view.code, statusWrites: writes.length });
    });
    assert.equal(retained.length, samples.length, 'all transport scenarios must pass before restart evidence');
    await f.restart();
    for (const row of retained) {
      const view = await f.request('GET', '/api/v1/wecom/customer-invitations/' + row.taskId, f.admin);
      assert.deepEqual(view, row.view, 'actual saved task fields survive service restart');
      if (row.held) {
        const again = await f.request('POST', '/api/v1/wecom/customer-invitations', f.admin, row.body);
        assert.equal(again.taskId, row.taskId); assert.equal(again.reused, true);
      }
    }
    assert.equal((await f.request('GET', '/api/v1/windows-agents/wire-fixture/tasks/next?wecomPreview=wecom-invitation-v4', f.agent)).task, null);
    t.diagnostic('WECOM_STATUS_TRANSPORT_EVIDENCE ' + JSON.stringify({ scenarios: proofs, persistedAfterRestart: retained.length,
      heldRepostsReuseOriginal: retained.filter(row => row.held).length, extraWorkers: 0, actualAgentCompactor: true, actualAgentTimeoutCatch: true,
      realPhoneOperations: 0, realInvitations: 0, backend: 'isolated JSON' }));
  });

test('WeCom status whitelist rejects arbitrary delivery claims and does not change unrelated transport', () => {
  const context = agentContext(() => assert.fail('no network'), () => assert.fail('no execution'));
  const wire = context.compactTaskResultForStatus({ previewStatus: 'invalid', previewCode: 'not a fixed code',
    sendStatus: 'sent', invitationSent: true, remarkSaveStatus: 'invalid', privateWecomField: 'drop' });
  assert.equal(wire.previewStatus, 'blocked'); assert.equal(wire.previewCode, 'wecom_preview_stopped');
  assert.equal(wire.sendStatus, 'not_attempted'); assert.equal(wire.invitationSent, false);
  assert.equal(wire.remarkSaveStatus, 'unknown'); assert.equal(wire.privateWecomField, undefined);
  for (const previewCode of [['allowed_code'], { code: 'allowed_code' }, 'x'.repeat(101)]) {
    assert.equal(context.compactTaskResultForStatus({ previewStatus: 'blocked', previewCode }).previewCode, 'wecom_preview_stopped');
  }
  const unrelated = context.compactTaskResultForStatus({ action: 'synthetic_other_task' });
  for (const key of ['previewStatus', 'previewCode', 'sendStatus', 'invitationSent', 'remarkSaveStatus']) assert.equal(Object.hasOwn(unrelated, key), false);
});
