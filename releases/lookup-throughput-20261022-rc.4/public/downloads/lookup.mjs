// Node.js 18+；无需 npm install。只调用公开的三个接口。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API = '/api/v1/open/name-lookups';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// state 必须由调用方持久化。同一笔业务重试时，加载原 state，不能重新生成。
export async function lookupName({
  baseUrl = 'http://47.98.127.132', apiKey, phoneNumber,
  state, saveState, waitMs = 120_000, fetchImpl = globalThis.fetch,
  now = Date.now, sleep = delay, onProgress = () => {},
}) {
  if (!apiKey) throw new Error('请配置 API_KEY');
  if (!/^1\d{10}$/.test(phoneNumber)) throw new Error('手机号必须是11位数字');
  if (!Number.isFinite(waitMs) || waitMs <= 0) throw new Error('等待时间必须大于0');
  const origin = new URL(baseUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) throw new Error('BASE_URL 只能填写服务器地址');
  const binding = hash(JSON.stringify([origin.origin, apiKey, phoneNumber]));
  if (state.binding && state.binding !== binding) throw new Error('这份状态属于其他号码或客户，请使用新的业务编号');
  if (!state.binding) {
    Object.assign(state, { binding, prepareKey: crypto.randomUUID(), submitKey: crypto.randomUUID() });
    await saveState(state); // 必须先落盘，再发请求。
  }
  if (!state.prepareKey || !state.submitKey) throw new Error('状态文件损坏，请保留原文件并排查，勿盲目重提');
  const deadline = now() + waitMs;
  let ready = false;
  const pause = async ms => sleep(Math.max(0, Math.min(ms, deadline - now())));

  async function request(method, pathname, body, key) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'X-API-Key': apiKey };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(30_000, deadline - now())));
    let response, rawResponse;
    try {
      response = await fetchImpl(origin.origin + pathname, {
        method, headers, body: body === undefined ? undefined : raw,
        signal: controller.signal, redirect: 'error',
      });
      rawResponse = await response.text();
    } catch {
      const status = response?.status || 0;
      throw Object.assign(new Error(status ? `HTTP ${status}` : '网络超时或连接失败'), {
        retryable: !status || status < 400 || status === 429 || status >= 500,
      });
    } finally { clearTimeout(timer); }
    let result;
    try { result = JSON.parse(rawResponse); } catch { /* 下方处理非法响应。 */ }
    if (!response.ok) {
      const code = String(result?.code || result?.error || `http_${response.status}`);
      const retryHeader = response.headers.get('retry-after');
      const retryMs = /^\d+$/.test(retryHeader || '') ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - now();
      throw Object.assign(new Error(`接口错误：HTTP ${response.status}，${/^[a-zA-Z0-9_.:-]+$/.test(code) ? code : '请检查服务端错误记录'}`), {
        code, retryable: response.status === 429 || response.status >= 500,
        retryMs: Number.isFinite(retryMs) ? Math.max(5000, retryMs) : 5000,
      });
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('接口响应格式错误，保留原请求状态后排查');
    return result;
  }

  while (now() < deadline) {
    try {
      // 已有查询编号时，直接查原结果，不重新 prepare 或提交手机号。
      if (state.lookupId) {
        const result = await request('GET', `${API}/tasks/${encodeURIComponent(state.lookupId)}`);
        if (result.lookupId !== state.lookupId) throw new Error('返回的查询编号不匹配');
        if (result.status === 'failed') throw new Error('查询执行失败，请保留查询编号交给平台排查；这不代表没有姓名');
        if (!result.ok) throw new Error('查询结果异常，请保留查询编号排查');
        if (result.status === 'completed') {
          if (typeof result.name !== 'string') throw new Error('完成结果缺少 name 字段');
          return { status: 'completed', lookupId: state.lookupId, name: result.name };
        }
        if (!['queued', 'processing'].includes(result.status)) throw new Error('未知的查询状态');
        const unavailable = result.code === 'lookup_no_available_device';
        onProgress(unavailable ? '暂无可用手机，暂停传号，继续等原任务' : result.status === 'queued' ? '已提交，正在排队' : '正在查询');
        await pause(unavailable ? 30000 : 5000);
        continue;
      }

      // 1. 启动并等待准备就绪：反复 POST 同一个 prepareKey。
      if (!ready) {
        const result = await request('POST', `${API}/prepare`, {}, state.prepareKey);
        if (!result.ok) throw new Error('启动任务失败');
        if (['expired', 'stopping', 'stopped'].includes(result.status)) throw new Error('本轮已请求结束，请勿自动重新启动');
        if (result.acceptingRequests === false) {onProgress('平台暂不接收新号码，30秒后检查准备状态');await pause(30000);continue;}
        if (result.status === 'ready' && result.ready === true) ready = true;
        else if (result.status === 'preparing') {
          onProgress('等待平台准备就绪');
          await pause(5000);
          continue;
        } else throw new Error('未知的准备状态');
      }

      // 2. 提交手机号：正文只有 phoneNumber；手机分配由平台负责。
      const result = await request('POST', `${API}/tasks`, { phoneNumber }, state.submitKey);
      if (!result.ok || typeof result.lookupId !== 'string' || !result.lookupId) throw new Error('提交响应缺少有效查询编号，请保留原业务编号重试');
      state.lookupId = result.lookupId;
      await saveState(state);
      onProgress('提交成功，开始获取结果');
      // 3. 下一轮使用 GET 查询结果；每个号码独立返回。
    } catch (error) {
      if (error.code === 'lookup_preparation_expired') {
        state.prepareKey = crypto.randomUUID();
        await saveState(state);
        ready = false;
        continue;
      }
      if (['lookup_not_ready', 'lookup_no_available_device'].includes(error.code)) ready = false;
      if (!error.retryable) throw error;
      onProgress('暂时未获得响应，保留原请求并等待重试');
      await pause(error.retryMs || 5000);
    }
  }
  // 两分钟只是本次客户端等待上限，不是服务端失败，也不是“没名字”。
  return { status: 'pending', ...(state.lookupId ? { lookupId: state.lookupId } : {}) };
}

async function main() {
  const [phoneNumber, businessId] = process.argv.slice(2);
  if (!phoneNumber || !businessId || !/^[A-Za-z0-9_-]{1,80}$/.test(businessId)) {
    throw new Error('用法：node lookup.mjs 手机号 业务编号；业务编号只能含字母、数字、下划线、短横线');
  }
  const directory = path.resolve(process.env.LOOKUP_STATE_DIR || '.lookup-api-key-state');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${businessId}.json`);
  const lockPath = path.join(directory, `${businessId}.lock`);
  // 防止两个进程同时处理同一业务编号，生成两组不同的业务 key。
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`同一业务正在运行，或上次异常退出留下锁文件：${lockPath}。先确认原进程已经结束，再删除该 .lock 文件；保留 .json 状态文件。`);
  }
  try {
    let state;
    try { state = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('状态文件无法读取，请保留原文件排查'); state = {}; }
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('状态文件格式错误');
    const saveState = async value => {
      const temp = `${filename}.tmp`;
      const handle = await fs.open(temp, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, filename);
    };
    const result = await lookupName({
      baseUrl: process.env.BASE_URL || 'http://47.98.127.132',
      apiKey: process.env.API_KEY,
      phoneNumber, state, saveState,
      waitMs: Number(process.env.WAIT_SECONDS || 120) * 1000,
      onProgress: message => console.error(message),
    });
    console.log(JSON.stringify(result));
    if (result.status === 'pending') {
      console.error('本轮等待结束；再次运行同一条命令，会继续原任务。请保留状态文件。');
      process.exitCode = 2;
    }
  } finally { await lock.close(); await fs.unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
