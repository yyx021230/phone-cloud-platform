import { createSimulatedWecomCleanup } from "./wecom-cleanup-fixture.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WecomClient, WecomApiError } from '../examples/wecom-integration/client.mjs';
import { WECOM_PREVIEW_DEVICES as pool } from './wecom-preview.mjs';
import { runWecomPreviewTask } from '../windows-agent/src/wecom-preview-task.mjs';

const root = path.resolve(import.meta.dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await pause(20); }
  assert.fail('timed out: ' + label);
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-external-e2e-'));
  const agentDir = path.join(dir, 'fake-agent'); await fs.mkdir(agentDir);
  const reservation = net.createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let service; const children = new Set(), jobs = new Set(), trace = [], held = new Set(); let losePost = false, lostTaskId;
  const env = { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(dir, 'data'),
    STORAGE_BACKEND: 'json', STRUCTURED_WRITES: 'true', DATABASE_URL: '', REDIS_URL: '', PUBLIC_BASE_URL: origin,
    ADMIN_USERNAME: 'fixture_admin', ADMIN_PASSWORD: 'fixture-password', SCREEN_MEDIA_AUTH_SECRET: 'fixture-only-secret', WINDOWS_AGENT_ONLINE_SECONDS: '300' };
  async function start() {
    service = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
    service.stderr.on('data', () => {});
    await until(async () => { try { return (await fetch(origin + '/readyz')).ok; } catch { return false; } }, Boolean, 'local fixture readiness');
  }
  async function stop() {
    if (service?.exitCode === null) {
      const exit = once(service, 'exit'); service.kill('SIGTERM'); const timer = setTimeout(() => service.kill('SIGKILL'), 2000);
      await exit; clearTimeout(timer);
    }
  }
  const gateway = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      trace.push({ method: req.method, route: req.url });
      const response = await fetch(origin + req.url, { method: req.method, redirect: 'error',
        headers: { authorization: req.headers.authorization || '', 'content-type': 'application/json' },
        ...(['POST', 'PUT'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
      const bytes = await response.arrayBuffer();
      if (losePost && req.method === 'POST' && req.url === '/api/v1/wecom/customer-invitations' && response.status === 202) {
        losePost = false; lostTaskId = JSON.parse(Buffer.from(bytes).toString()).taskId;
        held.add(res); res.on('close', () => held.delete(res)); return; // Client's real request timeout discards the reply.
      }
      res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(Buffer.from(bytes));
    } catch { if (!res.destroyed) { res.writeHead(502); res.end('{"error":"fixture_gateway_error"}'); } }
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const baseUrl = `http://127.0.0.1:${gateway.address().port}`;
  t.after(async () => {
    for (const child of children) child.kill();
    await Promise.allSettled([...jobs]);
    for (const response of held) response.destroy();
    gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
    await stop(); await fs.rm(dir, { recursive: true, force: true });
  });
  await start();
  let cleanupFixture;
  async function adminCall(method, route, token, body, expected = 200) {
    const response = await fetch(origin + route, { method, headers: { authorization: token ? `Bearer ${token}` : '', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expected, `harness ${method} ${route}`); await cleanupFixture?.observe(method,route,body,value); return value;
  }
  const admin = (await adminCall('POST', '/api/v1/auth/login', '', { username: 'fixture_admin', password: 'fixture-password' })).session.token;
  const agentToken = (await adminCall('POST', '/api/v1/windows-agents', admin, { agentId: 'simulated-agent', agentName: 'isolated fixture' }, 201)).token;
  await adminCall('POST', '/api/v1/windows-agents/simulated-agent/devices/sync', agentToken,
    { agent: { agentId: 'simulated-agent' }, devices: [...Object.values(pool).map(d => ({ adbSerial: d.serial, state: 'device', model: 'Synthetic' })),
      { adbSerial: 'SIM-NON-WECOM', state: 'device', model: 'Synthetic' }, { adbSerial: 'SIM-OFFLINE', state: 'device', model: 'Synthetic' }] });
  for (const [number, entry] of Object.entries(pool)) await adminCall('PUT', '/api/v1/devices/' + encodeURIComponent('adb:' + entry.serial), admin, { listingStatus: 'listed', deviceName: number });
  await adminCall('PUT', '/api/v1/devices/adb%3ASIM-NON-WECOM', admin, { deviceName: '67', listingStatus: 'listed' });
  await adminCall('PUT', '/api/v1/devices/adb%3ASIM-OFFLINE', admin, { deviceName: '68', listingStatus: 'listed' });
  await adminCall('POST', '/api/v1/windows-agents/simulated-agent/devices/sync', agentToken, { agent: { agentId: 'simulated-agent' }, devices: [...Object.values(pool).map(d => ({ adbSerial: d.serial, state: 'device', model: 'Synthetic' })), { adbSerial: 'SIM-NON-WECOM', state: 'device', model: 'Synthetic' }, { adbSerial: 'SIM-OFFLINE', state: 'offline', model: 'Synthetic' }] });
  const client = new WecomClient({ baseUrl, token: admin });
  async function next() { return (await adminCall('GET', '/api/v1/windows-agents/simulated-agent/tasks/next?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1', agentToken)).task; }
  cleanupFixture=createSimulatedWecomCleanup({request:adminCall,agentId:"simulated-agent",token:agentToken,nextRoute:"/api/v1/windows-agents/simulated-agent/tasks/next?wecomPreview=wecom-invitation-v4&wecomCleanupProtocol=1",runtimeHostRegistration:true});
  function execute(task, { waitAtClaim = false, loseClaimReply = false } = {}) {
    const operation = (async () => {
      const result = await runWecomPreviewTask(task, {
        config: { pythonCommand: 'python3', serverBaseUrl: origin, agentId: 'simulated-agent', agentToken }, agentDir,
        cleanupRequest: (route, { method = 'POST', body } = {}) => adminCall(method, route, agentToken, body),
        spawnChild: (command, args, options) => {
          assert.equal(path.basename(args[0]), 'wecom_platform_preview.py');
          assert.ok(!JSON.stringify(args).includes(task.payload.phoneNumber), 'customer input must be stdin-only');
          const child = spawn(command, [path.join(root, 'verification/wecom-external-api-20261029/simulated_worker.py')], {
            ...options, cwd: root, env: { PATH: process.env.PATH, PYTHONPATH: path.join(root, 'windows-agent/scripts'),
              PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', WECOM_SIM_PHYSICAL_READY: '1', WECOM_SIM_PAUSE: String(waitAtClaim), WECOM_SIM_LOSE_CLAIM_REPLY: String(loseClaimReply) } });
          children.add(child); child.once('exit', () => children.delete(child)); return child;
        }
      });
      await adminCall('POST', `/api/v1/windows-agent-tasks/${task.taskId}/status`, agentToken,
        { status: result.previewStatus === 'send_attempted' ? 'succeeded' : 'failed', result });
      return result;
    })();
    jobs.add(operation); operation.then(() => jobs.delete(operation), () => jobs.delete(operation));
    return operation;
  }
  async function record(task) {
    try { return JSON.parse(await fs.readFile(path.join(agentDir, 'data/simulation', task.taskId + '.json'), 'utf8')); } catch { return null; }
  }
  async function release(task) { await fs.writeFile(path.join(agentDir, 'data/simulation', task.taskId + '.release'), 'release'); }
  return { dir, client, baseUrl, admin, agentToken, adminCall, next, execute, record, release, trace,
    loseNextPostReply() { losePost = true; }, lostTaskId: () => lostTaskId, restart: async () => { await stop(); await start(); },
    async allRecords() { return Promise.all((await fs.readdir(path.join(agentDir, 'data/simulation'))).filter(f => f.endsWith('.json')).map(async f => JSON.parse(await fs.readFile(path.join(agentDir, 'data/simulation', f), 'utf8')))); } };
}

const input = (deviceNumber, appSlot = 'main', phoneNumber = '19900000001') => ({ deviceNumber, appSlot, phoneNumber, remarkName: '联调（客户）😀' });
const apiFailure = status => error => error instanceof WecomApiError && error.status === status;

test('external client: discover -> four-field submit -> actual synthetic remark/send -> result; dual slots, timeout and restart never replay', { timeout: 45000 }, async t => {
  const f = await fixture(t), c = f.client;
  const inventory = await c.devices(); assert.equal(inventory.total, 10);
  const online = await c.devices({ onlineOnly: true }); assert.equal(online.total, 9);
  assert.equal(online.devices.find(d => d.deviceNumber === '67').available, false);
  const dual = online.devices.find(d => d.deviceNumber === '155');
  assert.equal(dual.available, true); assert.deepEqual(dual.appSlots.map(s => s.appSlot), ['main', 'clone']);
  await assert.rejects(c.submit({ ...input('155'), appSlot: undefined }), apiFailure(400));
  const replies = await Promise.all(Array.from({ length: 6 }, () => c.submit(input(dual.deviceNumber))));
  assert.equal(new Set(replies.map(r => r.taskId)).size, 1); assert.equal(replies.filter(r => !r.reused).length, 1);
  const firstId = replies[0].taskId; assert.equal((await c.result(firstId)).status, 'queued');
  const allocated = (await c.devices()).devices.find(d => d.deviceNumber === '155');
  assert.equal(allocated.busy, true); assert.equal(allocated.available, false);
  await assert.rejects(c.submit(input('155', 'clone')), apiFailure(409));
  await assert.rejects(c.submit({ ...input('155'), remarkName: 'changed' }), apiFailure(409));
  const firstTask = await f.next(); assert.equal(firstTask.payload.automationJobId, firstId); assert.equal(firstTask.payload.androidUser, 0);
  const firstRun = f.execute(firstTask, { waitAtClaim: true });
  await until(() => f.record(firstTask), r => r?.atSendBoundary, 'main application send boundary');
  assert.equal((await c.result(firstId)).status, 'running');
  const singleInput=input('59');delete singleInput.appSlot;
  const second = await c.submit(singleInput);assert.equal(second.appSlot,'main');const secondTask = await f.next();assert.equal(secondTask.payload.deviceNumber,'59');assert.equal(secondTask.payload.automationJobId,second.taskId);
  await f.execute(secondTask); assert.equal((await c.result(second.taskId)).status, 'unknown');
  assert.equal((await c.result(firstId)).status, 'running', 'one paused phone does not block another');
  const secondRecord = await f.record(secondTask); assert.equal(secondRecord.searchCalls, 1); assert.equal(secondRecord.saveCalls, 1); assert.equal(secondRecord.sendCalls, 1); assert.equal(secondRecord.remarkVerified, true);
  await f.release(firstTask); await firstRun; assert.equal((await c.result(firstId)).status, 'unknown');
  const mainRecord = await f.record(firstTask); assert.equal(mainRecord.sendCalls, 1); assert.equal(mainRecord.saveCalls, 1);
  assert.equal((await c.submit(input('155'))).taskId, firstId);
  assert.equal((await c.devices()).devices.find(d => d.deviceNumber === '155').available, true);

  f.loseNextPostReply();
  await assert.rejects(c.submit(input('155', 'clone'), { timeoutMs: 100 }), apiFailure(0));
  const lostId = await until(async () => f.lostTaskId(), Boolean, 'accepted reply deliberately withheld');
  const recovered = await c.submit(input('155', 'clone')); assert.equal(recovered.taskId, lostId); assert.equal(recovered.reused, true);
  const cloneTask = await f.next(); assert.equal(cloneTask.payload.automationJobId, lostId); assert.equal(cloneTask.payload.androidUser, 999); assert.equal(cloneTask.payload.appSlot, 'clone');
  await f.execute(cloneTask); assert.equal((await c.result(lostId)).status, 'unknown');
  const cloneRecord = await f.record(cloneTask); assert.equal(cloneRecord.sendCalls, 1); assert.equal(cloneRecord.saveCalls, 1);

  const unknownInput = input('59', 'main', '19900000002'); const uncertain = await c.submit(unknownInput);
  const uncertainTask = await f.next(); await f.execute(uncertainTask, { loseClaimReply: true });
  const uncertainty = await f.record(uncertainTask);
  assert.equal(uncertainty.localClaimCreated, true); assert.equal(uncertainty.cloudClaimPersisted, true); assert.equal(uncertainty.sendCalls, 0);
  assert.equal((await c.result(uncertain.taskId)).status, 'unknown');
  await f.restart();
  for (const [body, id] of [[input('155'), firstId], [input('155', 'clone'), lostId], [unknownInput, uncertain.taskId]]) {
    const replay = await c.submit(body); assert.equal(replay.taskId, id); assert.equal(replay.reused, true); assert.equal((await c.result(id)).status, 'unknown');
  }
  assert.equal(await f.next(), null, 'restart and external retries enqueue no extra worker');
  const records = await f.allRecords(); assert.equal(records.length, 4); assert.equal(records.reduce((n, r) => n + r.sendCalls, 0), 3);
  assert.ok(records.every(r => r.searchCalls === 1 && r.saveCalls === 1 && r.remarkVerified));
  assert.deepEqual(new Set(f.trace.map(x => x.route.split('?')[0].replace(/\/customer-invitations\/[^/]+$/, '/customer-invitations/:taskId'))),
    new Set(['/api/v1/wecom/devices', '/api/v1/wecom/customer-invitations', '/api/v1/wecom/customer-invitations/:taskId']), 'external caller uses only the three documented APIs');
  t.diagnostic('WECOM_EXTERNAL_EVIDENCE '+JSON.stringify({
    simulatedTasks:records.length, syntheticSearchCalls:records.reduce((n,r)=>n+r.searchCalls,0),
    syntheticSaveCalls:records.reduce((n,r)=>n+r.saveCalls,0), syntheticSendCalls:records.reduce((n,r)=>n+r.sendCalls,0),
    recipientsDeliveryConfirmed:0, realPhoneOperations:0, realInvitations:0,
    simultaneousDuplicatePosts:6, duplicateTaskCount:1, pausedPhoneDidNotBlockOtherPhone:true,
    acceptanceReplyLostAndRecoveredOriginal:true, unknownClaimReplyPreventedSend:true, restartEnqueuedExtraWorkers:0,
    publicEndpointKinds:3, clientTimeoutMs:100,
    perTask:records.map(({deviceNumber,appSlot,androidUser,searchCalls,saveCalls,sendCalls,claimCalls,remarkVerified})=>({deviceNumber,appSlot,androidUser,searchCalls,saveCalls,sendCalls,claimCalls,remarkVerified}))
  }));
});

test('external client: mapping, ownership, malformed fields and authentication fail before any worker', { timeout: 30000 }, async t => {
  const f = await fixture(t), c = f.client;
  for (const [body,status] of [[input('67'),403], [input('25','clone'),409], [{...input('59'),phoneNumber:'invalid'},400], [{...input('59'),mode:'preview'},400]]) await assert.rejects(c.submit(body),apiFailure(status));
  const bad = new WecomClient({ baseUrl: f.baseUrl, token: 'fixture-invalid' });
  await assert.rejects(bad.devices(), apiFailure(401)); await assert.rejects(bad.submit(input('59')), apiFailure(401)); await assert.rejects(bad.result('fixture-missing'), apiFailure(401));
  await f.adminCall('POST', '/api/v1/users', f.admin, { username: 'ordinary_user', password: 'fixture-password', role: 'user', enabled: true }, 201);
  const ordinaryToken=(await f.adminCall('POST','/api/v1/auth/login','',{username:'ordinary_user',password:'fixture-password'})).session.token;
  const ordinary=new WecomClient({baseUrl:f.baseUrl,token:ordinaryToken});
  await assert.rejects(ordinary.devices(),apiFailure(401));await assert.rejects(ordinary.submit(input('59')),apiFailure(401));await assert.rejects(ordinary.result('fixture-missing'),apiFailure(401));
  await f.adminCall('POST', '/api/v1/users', f.admin, { username: 'other_admin', password: 'fixture-password', role: 'admin', enabled: true }, 201);
  const otherToken = (await f.adminCall('POST', '/api/v1/auth/login', '', { username: 'other_admin', password: 'fixture-password' })).session.token;
  const other = new WecomClient({ baseUrl: f.baseUrl, token: otherToken });
  const task = await c.submit(input('59')); await assert.rejects(other.result(task.taskId), apiFailure(404));
  await f.adminCall('PUT', '/api/v1/devices/' + encodeURIComponent('adb:' + pool['43'].serial), f.admin, { deviceName: '59' });
  const conflict = (await c.devices()).devices.filter(d => d.deviceNumber === '59');
  assert.equal(conflict.length, 2); assert.ok(conflict.every(d => !d.available && !d.wecomAllowed && d.unavailableReason==='device_number_conflict'));
  await assert.rejects(c.submit(input('59')), apiFailure(409));
  assert.equal((await c.devices()).capacity.active, 1, 'rejections did not create additional tasks');
  t.diagnostic('WECOM_EXTERNAL_NEGATIVE_EVIDENCE '+JSON.stringify({parameterOrMappingRejections:5,invalidTokenRejections:3,ordinaryUserRejections:3,crossAdminResultRejections:1,workersRun:0}));
});
