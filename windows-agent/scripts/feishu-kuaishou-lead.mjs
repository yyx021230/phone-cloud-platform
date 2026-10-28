#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_WIKI_TOKEN = "XbIfwqgGZipPAjkhwmlcjMaEnZe";
const DEFAULT_CREDENTIALS = path.join(os.homedir(), ".config", "phone-cloud", "feishu.env");
const DEFAULT_MIN_DELAY_SECONDS = 240;
const DEFAULT_MAX_DELAY_SECONDS = 420;
const RETRYABLE_STATUS = "推送失败（提交前）";
const HEADER_NAMES = Object.freeze({
  phone: "电话",
  province: "省份",
  city: "城市",
  status: "推送状态",
  pushedAt: "推送时间",
});
let activePhoneRunner = null;

export function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function normalizePhone(value) {
  const phone = String(value ?? "").replace(/\D/g, "");
  return /^1\d{10}$/.test(phone) ? phone : "";
}

export function maskPhone(phone) {
  return phone ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : "";
}

export function buildRegion(province, city) {
  const left = String(province ?? "").trim();
  const right = String(city ?? "").trim();
  if (!left || !right) return "";
  if (left === right && ["北京市", "上海市", "天津市", "重庆市"].includes(left)) {
    return `${left}${right}`;
  }
  return right.startsWith(left) ? right : `${left}${right}`;
}

export function findColumns(headers) {
  const result = {};
  for (const [key, title] of Object.entries(HEADER_NAMES)) {
    const matches = headers.flatMap((value, index) => String(value ?? "").trim() === title ? [index] : []);
    if (matches.length !== 1) throw new Error(`表头“${title}”必须且只能出现一次，当前 ${matches.length} 次`);
    result[key] = matches[0];
  }
  return result;
}

export function eligibleRows(values, columns) {
  const blockedPhones = new Set();
  const firstBlankRowByPhone = new Map();
  const firstRetryRowByPhone = new Map();
  for (let index = 1; index < values.length; index += 1) {
    const row = values[index] ?? [];
    const phone = normalizePhone(row[columns.phone]);
    const status = String(row[columns.status] ?? "").trim();
    if (phone && status && status !== RETRYABLE_STATUS) blockedPhones.add(phone);
    if (phone && !status && !firstBlankRowByPhone.has(phone)) firstBlankRowByPhone.set(phone, index);
    if (phone && status === RETRYABLE_STATUS && !firstRetryRowByPhone.has(phone)) firstRetryRowByPhone.set(phone, index);
  }
  const buildCandidate = (phone, index, retry) => {
    const row = values[index] ?? [];
    const city = String(row[columns.city] ?? "").trim();
    const region = buildRegion(row[columns.province], city);
    if (!city || !region) return null;
    return { rowIndex: index, rowNumber: index + 1, phone, cityQuery: city, region, retry };
  };
  const fresh = [];
  const retry = [];
  const phones = new Set([...firstBlankRowByPhone.keys(), ...firstRetryRowByPhone.keys()]);
  for (const phone of phones) {
    if (blockedPhones.has(phone)) continue;
    const retryIndex = firstRetryRowByPhone.get(phone);
    const blankIndex = firstBlankRowByPhone.get(phone);
    const candidate = Number.isInteger(retryIndex)
      ? buildCandidate(phone, retryIndex, true)
      : buildCandidate(phone, blankIndex, false);
    if (candidate) (candidate.retry ? retry : fresh).push(candidate);
  }
  return [...fresh.sort((a, b) => a.rowNumber - b.rowNumber), ...retry.sort((a, b) => a.rowNumber - b.rowNumber)];
}

export function randomInteger(min, max, random = Math.random) {
  return Math.floor(random() * (max - min + 1)) + min;
}

export function selectCandidate(eligible, options, random = Math.random) {
  if (options.rowNumber) {
    return eligible.find((item) => item.rowNumber === options.rowNumber);
  }
  if (options.command === "run") {
    return eligible[0];
  }
  return eligible[randomInteger(0, eligible.length - 1, random)];
}

export function localNoProxy(existing = "") {
  return [...new Set([
    ...String(existing).split(",").map((value) => value.trim()).filter(Boolean),
    "127.0.0.1",
    "localhost",
    "::1",
  ])].join(",");
}

export function kuaishouChildEnvironment(environment = process.env) {
  const noProxy = localNoProxy(environment.NO_PROXY || environment.no_proxy || "");
  return {
    ...environment,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // This phone can need about five seconds to produce a live-room Poco
    // hierarchy. Keep the tighter shared default for other automations, but
    // give this isolated Kuaishou child enough time to read proven elements.
    PHONE_CLOUD_POCO_RPC_TIMEOUT_SECONDS:
      environment.PHONE_CLOUD_POCO_RPC_TIMEOUT_SECONDS || "5",
  };
}

export function shanghaiTimestamp(now = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function tokenRefreshDeadline(nowMilliseconds, expiresInSeconds) {
  const parsed = Number(expiresInSeconds);
  const lifetimeSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 7200;
  const refreshBufferSeconds = Math.min(120, Math.max(5, Math.floor(lifetimeSeconds / 10)));
  return nowMilliseconds + Math.max(1, lifetimeSeconds - refreshBufferSeconds) * 1000;
}

function columnName(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function emit(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);
}

class FeishuClient {
  constructor({ appId, appSecret, fetchImpl = fetch }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.fetchImpl = fetchImpl;
    this.token = "";
    this.tokenRefreshAt = 0;
  }

  async request(url, options = {}) {
    const headers = { "Content-Type": "application/json; charset=utf-8", ...(options.headers ?? {}) };
    if (options.auth !== false) {
      if (!this.token || Date.now() >= this.tokenRefreshAt) await this.authenticate();
      headers.Authorization = `Bearer ${this.token}`;
    }
    const response = await this.fetchImpl(url, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 0) {
      const hint = body.code === 91403
        ? "；请在目标表格中把该应用添加为可编辑的文档应用"
        : "";
      throw new Error(`飞书 API 失败: HTTP ${response.status}, code=${body.code ?? "unknown"}, msg=${body.msg ?? "unknown"}${hint}`);
    }
    return body.data ?? {};
  }

  async authenticate() {
    const response = await this.fetchImpl("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`飞书认证失败: HTTP ${response.status}, code=${body.code ?? "unknown"}, msg=${body.msg ?? "unknown"}`);
    }
    this.token = body.tenant_access_token;
    this.tokenRefreshAt = tokenRefreshDeadline(Date.now(), body.expire);
  }

  async resolveSheet(wikiToken) {
    const node = await this.request(`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(wikiToken)}`);
    if (node.node?.obj_type !== "sheet" || !node.node?.obj_token) {
      throw new Error(`Wiki 节点不是普通电子表格: ${node.node?.obj_type ?? "unknown"}`);
    }
    const spreadsheetToken = node.node.obj_token;
    const sheets = await this.request(`https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`);
    const first = [...(sheets.sheets ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0];
    if (!first?.sheet_id) throw new Error("电子表格中没有可用工作表");
    return {
      spreadsheetToken,
      sheetId: first.sheet_id,
      title: node.node.title ?? "",
      sheetTitle: first.title ?? "",
      rowCount: Math.min(Math.max(first.grid_properties?.row_count ?? 2000, 200), 10000),
    };
  }

  async readValues(spreadsheetToken, range) {
    const data = await this.request(`https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}`);
    return data.valueRange?.values ?? [];
  }

  async writeValues(spreadsheetToken, range, values) {
    await this.request(`https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`, {
      method: "PUT",
      body: JSON.stringify({ valueRange: { range, values } }),
    });
  }
}

function readCredentials(filePath) {
  let values = {};
  try {
    values = parseEnv(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" || !process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) throw error;
  }
  const appId = process.env.FEISHU_APP_ID || values.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET || values.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error(`缺少 FEISHU_APP_ID/FEISHU_APP_SECRET: ${filePath}`);
  return { appId, appSecret };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireLock(lockPath, dependencies = {}) {
  const lockHost = dependencies.host ?? os.hostname();
  const lockPid = dependencies.pid ?? process.pid;
  const isProcessAlive = dependencies.isProcessAlive ?? processIsAlive;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch {}
      const ownerPid = Number(owner?.pid);
      const staleLocalLock = owner?.host === lockHost && Number.isInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid);
      if (!staleLocalLock) throw new Error(`已有消费器运行，请先从平台停止任务或核实锁文件: ${lockPath}`);
      try { fs.unlinkSync(lockPath); } catch {}
      handle = fs.openSync(lockPath, "wx", 0o600);
    } else {
      throw error;
    }
  }
  fs.writeFileSync(handle, JSON.stringify({ pid: lockPid, host: lockHost, startedAt: new Date().toISOString() }));
  return () => {
    try { fs.closeSync(handle); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  };
}

function runPython({ python, script, payload }) {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "kuaishou-lead-"));
  const payloadPath = path.join(tempDirectory, "payload.json");
  fs.writeFileSync(payloadPath, JSON.stringify(payload), { mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, "--payload", payloadPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: kuaishouChildEnvironment(process.env),
    });
    activePhoneRunner = child;
    let stdout = "";
    let stderr = "";
    const cleanup = () => {
      if (activePhoneRunner === child) activePhoneRunner = null;
      try { fs.rmSync(tempDirectory, { recursive: true, force: true }); } catch {}
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      const parsed = stdout.trim().split(/\r?\n/).reverse().map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).find((item) => item?.result)?.result;
      if (!parsed) return reject(new Error(`手机脚本未返回结构化结果 (exit=${code}, stderr=${stderr.slice(-500)})`));
      resolve(parsed);
    });
  });
}

function parseArgs(argv) {
  const options = {
    command: argv[0] || "preview",
    credentials: DEFAULT_CREDENTIALS,
    wikiToken: DEFAULT_WIKI_TOKEN,
    minDelay: DEFAULT_MIN_DELAY_SECONDS,
    maxDelay: DEFAULT_MAX_DELAY_SECONDS,
    python: process.env.KUAISHOU_PYTHON || "python3",
    adbPath: process.env.ADB_PATH || "adb",
    serial: process.env.ANDROID_SERIAL || "",
    vehicleRunner: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "kuaishou_vehicle_lead.py"),
    heartbeatSeconds: 0,
    controlStdin: false,
    rowNumber: 0,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--control-stdin") {
      options.controlStdin = true;
      continue;
    }
    if (key === "--credentials") options.credentials = value;
    else if (key === "--wiki-token") options.wikiToken = value;
    else if (key === "--serial") options.serial = value;
    else if (key === "--adb") options.adbPath = value;
    else if (key === "--python") options.python = value;
    else if (key === "--vehicle-runner") options.vehicleRunner = value;
    else if (key === "--heartbeat-seconds") options.heartbeatSeconds = Number(value);
    else if (key === "--row") options.rowNumber = Number(value);
    else if (key === "--min-delay") options.minDelay = Number(value);
    else if (key === "--max-delay") options.maxDelay = Number(value);
    else throw new Error(`未知参数: ${key}`);
    index += 1;
  }
  if (!['preview', 'once', 'run'].includes(options.command)) throw new Error("命令必须是 preview、once 或 run");
  if (!Number.isInteger(options.minDelay) || !Number.isInteger(options.maxDelay) || options.minDelay < 0 || options.maxDelay < options.minDelay) {
    throw new Error("等待时间必须是有效的整数范围");
  }
  if (!Number.isInteger(options.heartbeatSeconds) || options.heartbeatSeconds < 0) {
    throw new Error("心跳间隔必须是非负整数秒");
  }
  if (options.command !== "preview" && !options.serial) throw new Error("once/run 必须提供 --serial 或 ANDROID_SERIAL");
  if (options.rowNumber && (!Number.isInteger(options.rowNumber) || options.rowNumber < 2)) {
    throw new Error("--row 必须是大于等于 2 的整数行号");
  }
  if (options.rowNumber && options.command !== "once") {
    throw new Error("--row 只允许与 once 一起使用");
  }
  return options;
}

async function loadTable(client, sheet) {
  const values = await client.readValues(sheet.spreadsheetToken, `${sheet.sheetId}!A1:K${sheet.rowCount}`);
  if (!values.length) throw new Error("电子表格为空");
  const columns = findColumns(values[0]);
  return { values, columns, eligible: eligibleRows(values, columns) };
}

export function claimVerificationState(value, expectedClaim) {
  const observed = String(value ?? "").trim();
  if (observed === expectedClaim) return "matched";
  if (!observed) return "retry";
  return "conflict";
}

function claimError(code, message, detail = {}) {
  return Object.assign(new Error(message), { code, ...detail });
}

export function isContinuableClaimError(error) {
  return ["row_claim_conflict", "row_claim_unverified", "row_claim_transient"].includes(String(error?.code || ""));
}

async function claimRow(client, sheet, columns, candidate) {
  const claimId = crypto.randomUUID().slice(0, 8);
  const claim = `处理中 [${claimId}]`;
  const coordinate = `${columnName(columns.status)}${candidate.rowNumber}`;
  const statusCell = `${sheet.sheetId}!${coordinate}:${coordinate}`;
  try {
    await client.writeValues(sheet.spreadsheetToken, statusCell, [[claim]]);
  } catch (error) {
    if (isRetryableQueueReadError(error)) {
      throw claimError("row_claim_transient", `第 ${candidate.rowNumber} 行占用写入暂时失败，未操作手机`, { row: candidate.rowNumber });
    }
    throw error;
  }
  const deadline = Date.now() + 10000;
  let attempts = 0;
  await new Promise((resolve) => setTimeout(resolve, 1200 + randomInteger(0, 800)));
  do {
    attempts += 1;
    let check;
    try {
      check = await client.readValues(sheet.spreadsheetToken, statusCell);
    } catch (error) {
      if (isRetryableQueueReadError(error)) {
        throw claimError("row_claim_transient", `第 ${candidate.rowNumber} 行占用回读暂时失败，未操作手机`, { row: candidate.rowNumber });
      }
      throw error;
    }
    const state = claimVerificationState(check[0]?.[0], claim);
    if (state === "matched") return { claim, statusCell, attempts };
    if (state === "conflict") {
      throw claimError("row_claim_conflict", `第 ${candidate.rowNumber} 行已被其他写入覆盖，未操作手机`, {
        row: candidate.rowNumber,
        observedStatus: String(check[0]?.[0] ?? "").trim().slice(0, 100),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  } while (Date.now() < deadline);
  throw claimError("row_claim_unverified", `第 ${candidate.rowNumber} 行占用回读超时，未操作手机`, { row: candidate.rowNumber });
}

async function finalizeRow(client, sheet, columns, candidate, status) {
  const statusColumn = columnName(columns.status);
  const timeColumn = columnName(columns.pushedAt);
  const statusCoordinate = `${statusColumn}${candidate.rowNumber}`;
  const timeCoordinate = `${timeColumn}${candidate.rowNumber}`;
  await client.writeValues(
    sheet.spreadsheetToken,
    `${sheet.sheetId}!${statusCoordinate}:${statusCoordinate}`,
    [[status]],
  );
  await client.writeValues(
    sheet.spreadsheetToken,
    `${sheet.sheetId}!${timeCoordinate}:${timeCoordinate}`,
    [[shanghaiTimestamp()]],
  );
}

export function statusForResult(result) {
  if (result.status === "success" || result.status === "success_close_failed") return "推送成功";
  if (result.submitted || result.status === "submitted_unknown") return "结果待确认";
  return "推送失败（提交前）";
}

export function shouldContinueRun(outcome) {
  return outcome?.empty === false;
}

export function shouldPollAfterEmpty(command, outcome) {
  return command === "run" && outcome?.empty === true;
}

export function isRetryableQueueReadError(error) {
  const message = String(error?.message ?? error ?? "");
  if (/\bfetch failed\b/i.test(message)) return true;
  const status = Number(message.match(/HTTP\s+(\d{3})/i)?.[1]);
  return status === 429 || (status >= 500 && status <= 599);
}

async function consumeOne(client, sheet, options, table) {
  if (!table.eligible.length) return { empty: true };
  const candidate = selectCandidate(table.eligible, options);
  if (!candidate) {
    throw new Error(`第 ${options.rowNumber} 行当前不符合消费条件，未操作手机`);
  }
  emit("candidate_selected", { row: candidate.rowNumber, phone: maskPhone(candidate.phone), city: candidate.cityQuery });
  const claimed = await claimRow(client, sheet, table.columns, candidate);
  emit("row_claimed", {
    row: candidate.rowNumber,
    claim: claimed.claim,
    verificationAttempts: claimed.attempts,
  });
  let result;
  try {
    result = await runPython({
      python: options.python,
      script: options.vehicleRunner,
      payload: { serial: options.serial, adbPath: options.adbPath, phone: candidate.phone, cityQuery: candidate.cityQuery, region: candidate.region },
    });
  } catch (error) {
    result = { status: "failed_before_submit", submitted: false, error: error.message };
  }
  const status = statusForResult(result);
  await finalizeRow(client, sheet, table.columns, candidate, status);
  emit("row_finalized", {
    row: candidate.rowNumber,
    status,
    phone: maskPhone(candidate.phone),
    detail: result.status,
    lastStep: result.log?.at(-1)?.step,
    error: result.error ? String(result.error).slice(0, 300) : undefined,
  });
  return {
    empty: false,
    row: candidate.rowNumber,
    submitted: Boolean(result.submitted),
    status,
    resultStatus: result.status,
  };
}

export async function main() {
  const options = parseArgs(process.argv.slice(2));
  const credentials = readCredentials(options.credentials);
  const client = new FeishuClient(credentials);
  const sheet = await client.resolveSheet(options.wikiToken);
  if (options.command === "preview") {
    const table = await loadTable(client, sheet);
    emit("preview", {
      document: sheet.title,
      sheet: sheet.sheetTitle,
      eligibleRows: table.eligible.length,
      nextCandidates: table.eligible.slice(0, 10).map((item) => ({ row: item.rowNumber, phone: maskPhone(item.phone), city: item.cityQuery })),
    });
    return;
  }
  const lockHash = crypto.createHash("sha256").update(options.wikiToken).digest("hex").slice(0, 12);
  const releaseLock = acquireLock(path.join(path.dirname(options.credentials), `feishu-kuaishou-${lockHash}.lock`));
  const heartbeatTimer = options.heartbeatSeconds > 0
    ? setInterval(() => emit("consumer_heartbeat", { state: "running" }), options.heartbeatSeconds * 1000)
    : null;
  heartbeatTimer?.unref?.();
  let stopping = false;
  let controlBuffer = "";
  const stopConsumer = (signal) => {
    if (stopping) return;
    stopping = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try { activePhoneRunner?.kill("SIGTERM"); } catch {}
    releaseLock();
    emit("consumer_stopped", { signal });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const stopOnInterrupt = () => stopConsumer("SIGINT");
  const stopOnTerminate = () => stopConsumer("SIGTERM");
  const stopOnControlData = (chunk) => {
    controlBuffer += String(chunk || "");
    const lines = controlBuffer.split(/\r?\n/);
    controlBuffer = lines.pop() || "";
    if (lines.some((line) => line.trim().toLowerCase() === "stop")) stopConsumer("CONTROL");
  };
  const stopOnControlEnd = () => stopConsumer("CONTROL_EOF");
  process.once("SIGINT", stopOnInterrupt);
  process.once("SIGTERM", stopOnTerminate);
  if (options.controlStdin) {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", stopOnControlData);
    process.stdin.once("end", stopOnControlEnd);
    process.stdin.resume();
  }
  try {
    do {
      let table;
      try {
        table = await loadTable(client, sheet);
      } catch (error) {
        if (options.command !== "run" || !isRetryableQueueReadError(error)) throw error;
        const delay = randomInteger(options.minDelay, options.maxDelay);
        emit("queue_read_failed", { error: String(error.message).slice(0, 300) });
        emit("waiting_for_queue_retry", { seconds: delay });
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
        continue;
      }
      let outcome;
      try {
        outcome = await consumeOne(client, sheet, options, table);
      } catch (error) {
        if (options.command !== "run" || !isContinuableClaimError(error)) throw error;
        emit("row_skipped", {
          row: Math.max(0, Number(error.row || 0)),
          errorCode: error.code,
          reason: String(error.message || "领取冲突").slice(0, 300),
        });
        const delay = randomInteger(options.minDelay, options.maxDelay);
        emit("waiting_after_row_skip", { seconds: delay });
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
        continue;
      }
      if (outcome.empty) {
        emit("queue_empty");
        if (!shouldPollAfterEmpty(options.command, outcome)) break;
        const delay = randomInteger(options.minDelay, options.maxDelay);
        emit("waiting_for_new_rows", { seconds: delay });
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
        continue;
      }
      if (options.command === "once") break;
      if (!shouldContinueRun(outcome)) {
        emit("queue_paused", {
          row: outcome.row,
          status: outcome.status,
          detail: outcome.resultStatus,
        });
        break;
      }
      const delay = randomInteger(options.minDelay, options.maxDelay);
      emit("waiting", { seconds: delay });
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    } while (true);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    process.removeListener("SIGINT", stopOnInterrupt);
    process.removeListener("SIGTERM", stopOnTerminate);
    if (options.controlStdin) {
      process.stdin.removeListener("data", stopOnControlData);
      process.stdin.removeListener("end", stopOnControlEnd);
      process.stdin.pause();
    }
    releaseLock();
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}
