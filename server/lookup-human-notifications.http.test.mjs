import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("server sends a waiting puzzle reminder without a browser and deduplicates across restart", { timeout: 20_000 }, async (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "phone-cloud-feishu-http-test-"));
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited; clearTimeout(timer);
  };
  t.after(async () => { await stop(); await fs.rm(temp, { recursive: true, force: true }); });
  await fs.cp(path.join(root, "server"), path.join(temp, "server"), {
    recursive: true, filter: (source) => !source.endsWith(".test.mjs")
  });
  await fs.symlink(path.join(root, "node_modules"), path.join(temp, "node_modules"), "dir");
  await fs.mkdir(path.join(temp, "data"));
  const createdAt = new Date().toISOString();
  await fs.writeFile(path.join(temp, "data/state.json"), JSON.stringify({
    devices: [{ deviceId: "synthetic-device", deviceName: "177" }],
    automationSessions: [{ sessionId: "synthetic-session", deviceId: "synthetic-device", status: "ready", createdAt,
      results: [{ resultId: "synthetic-result", status: "needs_human_verification", createdAt,
        errorCode: "alipay_human_verification_required", phoneNumber: "13800000000" }] }]
  }));
  const capture = path.join(temp, "messages.jsonl");
  const preload = path.join(temp, "mock-feishu.mjs");
  await fs.writeFile(preload, `import fs from 'node:fs/promises';
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://open.feishu.cn/open-apis/bot/v2/hook/')) {
    await fs.appendFile(${JSON.stringify(capture)}, options.body+'\\n');
    return new Response(JSON.stringify({code:0}), {status:200});
  }
  const host = new URL(String(url)).hostname;
  if (!['127.0.0.1','localhost'].includes(host)) throw new Error('external_network_disabled');
  return original(url, options);
};`);
  const reservation = net.createServer(); reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening"); const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const start = async () => {
    child = spawn(process.execPath, ["--import", preload, path.join(temp, "server/index.mjs")], {
      cwd: temp, env: { PATH: process.env.PATH, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
        STORAGE_BACKEND: "json", DATA_DIR: path.join(temp, "data"), DATABASE_URL: "", REDIS_URL: "",
        ADMIN_API_TOKEN: "synthetic-admin-only", ADMIN_PASSWORD: "SyntheticPassword!2026",
        WINDOWS_AGENT_TOKEN: "synthetic-agent-only", DEVICE_AGENT_TOKEN: "synthetic-device-only",
        EVIDENCE_SIGNING_SECRET: "synthetic-evidence-only", SCREEN_MEDIA_AUTH_SECRET: "synthetic-media-only",
        THIRD_PARTY_API_CLIENTS: "", OPEN_NAME_LOOKUP_API_ENABLED: "false", SCREEN_MEDIA_TRANSPORT: "websocket",
        LOOKUP_HUMAN_FEISHU_WEBHOOK: "https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-test-only"
      }, stdio: ["ignore", "ignore", "pipe"]
    });
    let errors = ""; child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-2000); });
    for (let i = 0; i < 100; i++) {
      assert.equal(child.exitCode, null, `isolated server exited: ${errors}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.fail("server did not start");
  };
  await start();
  let text = "";
  for (let i = 0; i < 70; i++) {
    try { text = await fs.readFile(capture, "utf8"); } catch {}
    if (text) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(JSON.parse(text), { msg_type: "text", content: {
    text: "177号手机出现拼图，请人工介入到云手机平台实时控制完成拼图。" } });
  assert.doesNotMatch(text, /13800000000/);
  await stop(); await start();
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.equal((await fs.readFile(capture, "utf8")).trim().split("\n").length, 1);
  const state = JSON.parse(await fs.readFile(path.join(temp, "data/state.json")));
  assert.equal(state.automationSessions[0].results[0].status, "needs_human_verification");
});
