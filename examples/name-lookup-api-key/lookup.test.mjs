import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lookupName } from './lookup.mjs';

const ready = { ok: true, status: 'ready', ready: true };
const accepted = { ok: true, lookupId: 'test-query-1', status: 'queued' };
const complete = name => ({ ...accepted, status: 'completed', name });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

function fixture(handler) {
  let time = 0, saved;
  const requests = [], state = {}, nonces = new Set();
  const options = {
    baseUrl: 'http://example.invalid', apiKey: 'mock-key',
    phoneNumber: '13800000000', state, now: () => time,
    sleep: async ms => { time += ms; },
    saveState: async value => { saved = structuredClone(value); },
    fetchImpl: async (url, req) => {
      assert.ok(saved?.submitKey, '必须在网络请求前保存幂等键');
      const pathname = new URL(url).pathname, h = req.headers;
      assert.equal(h['X-API-Key'], 'mock-key');
      for (const name of ['X-Client-Id','X-Signature','X-Nonce','X-Timestamp']) assert.equal(h[name], undefined);
      const call = { pathname, ...req };
      requests.push(call);
      return handler(call, requests);
    },
  };
  return { options, requests, state, get time() { return time; } };
}

test('启动轮询→只传手机号→排队→处理中→逐条姓名；API Key请求头核验', async () => {
  let prepares = 0, gets = 0;
  const f = fixture(r => {
    if (r.pathname.endsWith('/prepare')) {
      assert.equal(r.body, '{}');
      return json(++prepares === 1 ? { ok: true, status: 'preparing', ready: false } : ready);
    }
    if (r.method === 'POST') { assert.deepEqual(JSON.parse(r.body), { phoneNumber: '13800000000' }); return json(accepted, 202); }
    assert.equal(r.body, undefined);
    assert.equal(r.headers['Idempotency-Key'], undefined);
    return json(++gets < 3 ? { ...accepted, status: gets === 1 ? 'queued' : 'processing' } : complete('**某'));
  });
  assert.equal((await lookupName(f.options)).name, '**某');
  assert.equal(f.requests[0].headers['Idempotency-Key'], f.requests[1].headers['Idempotency-Key']);
});

test('完成且 name 为空才表示没有姓名', async () => {
  const f = fixture(r => json(r.pathname.endsWith('/prepare') ? ready : r.method === 'POST' ? accepted : complete('')));
  assert.equal((await lookupName(f.options)).name, '');
});

test('提交已受理但网络断开：同一业务 key 重试且保持API Key', async () => {
  let posts = 0;
  const f = fixture(r => {
    if (r.pathname.endsWith('/prepare')) return json(ready);
    if (r.method === 'POST') { if (++posts === 1) throw new Error('connection lost after acceptance'); return json(accepted); }
    return json(complete('**某'));
  });
  await lookupName(f.options);
  const submits = f.requests.filter(r => r.pathname.endsWith('/tasks'));
  assert.equal(submits.length, 2);
  assert.equal(submits[0].headers['Idempotency-Key'], submits[1].headers['Idempotency-Key']);
});

test('120秒没有结果：重启后只GET原lookupId，不重新提交或prepare', async () => {
  let finished = false;
  const f = fixture(r => json(r.pathname.endsWith('/prepare') ? ready : r.method === 'POST' ? accepted : finished ? complete('**某') : accepted));
  const first = await lookupName(f.options);
  assert.equal(f.time, 120_000);
  assert.deepEqual(first, { status: 'pending', lookupId: 'test-query-1' });
  assert.ok(!('name' in first));
  const previousCount = f.requests.length;
  finished = true;
  assert.equal((await lookupName({ ...f.options, state: structuredClone(f.state) })).name, '**某');
  assert.deepEqual(f.requests.slice(previousCount).map(r => r.method), ['GET']);
});

test('准备超过120秒：重跑保持原准备key和提交key', async () => {
  let available = false;
  const f = fixture(r => json(r.pathname.endsWith('/prepare') ? available ? ready : { ok: true, status: 'preparing' } : r.method === 'POST' ? accepted : complete('')));
  assert.equal((await lookupName(f.options)).status, 'pending');
  const old = { ...f.state };
  available = true;
  await lookupName(f.options);
  assert.equal(f.state.prepareKey, old.prepareKey);
  assert.equal(f.state.submitKey, old.submitKey);
});

test('429等待Retry-After，503重新等待就绪，提交key始终不变', async () => {
  let submits = 0;
  const f = fixture(r => {
    if (r.pathname.endsWith('/prepare')) return json(ready);
    if (r.method === 'GET') return json(complete('**某'));
    if (++submits === 1) return json({ code: 'lookup_inflight_limit' }, 429, { 'Retry-After': '7' });
    if (submits === 2) return json({ code: 'lookup_not_ready' }, 503);
    return json(accepted);
  });
  await lookupName(f.options);
  assert.equal(f.time, 12_000);
  assert.equal(f.requests.filter(r => r.pathname.endsWith('/prepare')).length, 2);
  assert.equal(new Set(f.requests.filter(r => r.pathname.endsWith('/tasks')).map(r => r.headers['Idempotency-Key'])).size, 1);
});

for (const expiredResponse of [json({ ok: true, status: 'expired' }), json({ code: 'lookup_preparation_expired' }, 409)]) {
  test(`准备过期 ${expiredResponse.status}：只换preparekey，提交key保留`, async () => {
    let prepares = 0;
    const f = fixture(r => r.pathname.endsWith('/prepare') ? ++prepares === 1 ? expiredResponse : json(ready) : json(r.method === 'POST' ? accepted : complete('')));
    await lookupName(f.options);
    assert.notEqual(f.requests[0].headers['Idempotency-Key'], f.requests[1].headers['Idempotency-Key']);
  });
}

for (const terminal of [json({ ...accepted, status: 'failed', ok: false }), json({ code: 'invalid_signature' }, 401), json({ ...complete(''), name: null })]) {
  test(`失败/认证/非法结果不伪装成空姓名 ${terminal.status}`, async () => {
    const f = fixture(r => r.pathname.endsWith('/prepare') ? json(ready) : r.method === 'POST' ? json(accepted) : terminal);
    await assert.rejects(lookupName(f.options));
    assert.equal(f.requests.length, 3);
  });
}

test('同一持久化状态禁止换号码，避免复用错任务', async () => {
  const f = fixture(r => json(r.pathname.endsWith('/prepare') ? ready : r.method === 'POST' ? accepted : complete('')));
  await lookupName(f.options);
  const count = f.requests.length;
  await assert.rejects(lookupName({ ...f.options, phoneNumber: '13900000000' }), /其他号码/);
  assert.equal(f.requests.length, count);
});

test('CLI真实本地HTTP：落盘、等待退出码2、重启续查、退出码0；不保存密钥', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lookup-example-'));
  let finished = false, submissions = 0, preparations = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    if (req.headers['x-api-key'] !== 'local-mock-key') { res.writeHead(401); res.end('{}'); return; }
    let result;
    if (req.url.endsWith('/prepare')) { preparations++; result = ready; }
    else if (req.method === 'POST') { submissions++; result = accepted; }
    else result = finished ? complete('**某') : accepted;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const run = waitSeconds => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./lookup.mjs', import.meta.url)), '13800000000', 'mock-order'], {
      env: { BASE_URL: `http://127.0.0.1:${server.address().port}`, API_KEY: 'local-mock-key', LOOKUP_STATE_DIR: directory, WAIT_SECONDS: String(waitSeconds) },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  try {
    const first = await run(1);
    assert.equal(first.code, 2, first.stderr);
    assert.equal(JSON.parse(first.stdout).status, 'pending');
    const saved = await fs.readFile(path.join(directory, 'mock-order.json'), 'utf8');
    assert.equal(JSON.parse(saved).lookupId, 'test-query-1');
    assert.ok(!saved.includes('local-mock-key'));
    assert.ok(!saved.includes('13800000000'));
    assert.ok(!(await fs.readdir(directory)).some(file => file.endsWith('.lock')));
    finished = true;
    const second = await run(10);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).name, '**某');
    assert.equal(preparations, 1);
    assert.equal(submissions, 1);
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
});
