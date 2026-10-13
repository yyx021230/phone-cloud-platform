import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLookupHumanNotifier, lookupNotificationDeviceLabel, pendingLookupHumanNotifications, readLookupHumanWebhook } from "./lookup-human-notifications.mjs";

const webhookUrl = "https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-test-only";
const session = { sessionId: "synthetic-session", deviceId: "synthetic-device", status: "ready",
  results: [{ resultId: "synthetic-result", status: "needs_human_verification",
    errorCode: "alipay_human_verification_required", phoneNumber: "13800000000", name: "private-name" }] };
const devices = [{ deviceId: session.deviceId, deviceName: "102" }];
const targets = () => pendingLookupHumanNotifications([session], devices);
const fixture = async (t) => {
  const receiptsDir = await fs.mkdtemp(path.join(os.tmpdir(), "phone-cloud-notification-test-"));
  t.after(() => fs.rm(receiptsDir, { recursive: true, force: true }));
  return receiptsDir;
};

test("only a current evidenced jigsaw can produce a target, without private query data", () => {
  assert.equal(targets().length, 1);
  assert.deepEqual(Object.keys(targets()[0]).sort(), ["deviceName", "key"]);
  for (const changed of [{ status: "ended" }, { pendingJobId: "running" },
    { results: [{ ...session.results[0], status: "failed", errorCode: "transport_error" }] },
    { results: [{ ...session.results[0], errorCode: "transport_error" }] },
    { results: [{ resultId: "new", status: "succeeded" }, ...session.results] }]) {
    assert.deepEqual(pendingLookupHumanNotifications([{ ...session, ...changed }], devices), []);
  }
  assert.deepEqual(pendingLookupHumanNotifications([session], []), []);
  assert.deepEqual(pendingLookupHumanNotifications([session], [{ ...devices[0], deviceName: "13800000000\n测试" }]), []);
});

test("reminders use the inventory number and never infer it from a model or serial", () => {
  for (const name of ["102", "102号", "102号手机", "102手机", "102号测试手机", " 102 "]) {
    assert.equal(lookupNotificationDeviceLabel({ deviceName: name }), "102号手机");
  }
  for (const name of ["本机 Vivo 冷却测试手机", "V2357A", "13800000000", "", "vivo102"]) {
    assert.equal(lookupNotificationDeviceLabel({ deviceName: name, deviceId: "adb:102", model: "102" }), "");
  }
});

test("a new human challenge on the same query sends once; ordinary polls and restarts remain deduplicated", async (t) => {
  const receiptsDir = await fixture(t);
  let current = { ...session, results: [{ ...session.results[0], updatedAt: "2026-01-01T00:00:00Z" }] };
  const getTargets = () => pendingLookupHumanNotifications([current], devices);
  let calls = 0;
  const make = () => createLookupHumanNotifier({ webhookUrl, receiptsDir, getTargets,
    fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({ code: 0 }) }; } });
  await make().poll();
  const firstKey = getTargets()[0].key;
  current = { ...current, updatedAt: "2026-01-01T00:00:10Z" };
  await make().poll(); assert.equal(calls, 1, "session refresh is not another puzzle");
  current = { ...current, pendingJobId: "resume-job" };
  await make().poll(); assert.equal(calls, 1);
  current = { ...current, pendingJobId: "", results: [{ ...current.results[0], updatedAt: "2026-01-01T00:01:00Z" }] };
  assert.notEqual(getTargets()[0].key, firstKey);
  await Promise.all([make().poll(), make().poll()]);
  await make().poll();
  assert.equal(calls, 2, "the second challenge is sent exactly once");
});

test("sends the requested text once across concurrent polls and process restart", async (t) => {
  const receiptsDir = await fixture(t); let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, webhookUrl); assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { msg_type: "text", content: {
      text: "102号手机出现拼图，请人工介入到云手机平台实时控制完成拼图。" } });
    assert.doesNotMatch(options.body, /13800000000|private-name|synthetic-result/);
    const claim = JSON.parse(await fs.readFile(path.join(receiptsDir, `${targets()[0].key}.json`)));
    assert.equal(claim.status, "sending");
    return { ok: true, status: 200, json: async () => ({ code: 0 }) };
  };
  const make = () => createLookupHumanNotifier({ webhookUrl, receiptsDir, getTargets: targets, fetchImpl });
  const notifier = make(); await Promise.all([notifier.poll(), notifier.poll(), make().poll()]);
  await notifier.poll(); await make().poll();
  assert.equal(calls, 1);
  const receipt = JSON.parse(await fs.readFile(path.join(receiptsDir, `${targets()[0].key}.json`)));
  assert.equal(receipt.status, "sent");
  assert.equal((await fs.stat(path.join(receiptsDir, `${targets()[0].key}.json`))).mode & 0o777, 0o600);
});

test("HTTP, business rejection and unknown delivery never trigger blind duplicate sends", async (t) => {
  for (const kind of ["http", "business", "timeout", "invalid_json", "missing_code", "legacy"]) {
    const receiptsDir = await fixture(t); let calls = 0;
    const notifier = createLookupHumanNotifier({ webhookUrl, receiptsDir, getTargets: targets,
      fetchImpl: async () => {
        calls++; if (kind === "timeout") throw new Error(`sensitive ${webhookUrl}`);
        return { ok: kind !== "http", status: kind === "http" ? 429 : 200, json: async () => {
          if (kind === "invalid_json") throw new Error("bad json");
          return kind === "business" ? { code: 19024, msg: webhookUrl }
            : kind === "missing_code" ? {} : kind === "legacy" ? { StatusCode: 0 } : { code: 0 };
        } };
      } });
    const [outcome] = await notifier.poll(); await notifier.poll();
    assert.equal(calls, 1);
    assert.equal(outcome.status, ["http", "business"].includes(kind) ? "rejected" : kind === "legacy" ? "sent" : "unknown");
    assert.doesNotMatch(JSON.stringify(outcome), /open\.feishu\.cn|sensitive/);
  }
});

test("a vanished challenge and unavailable durable claim both prevent sending", async (t) => {
  const receiptsDir = await fixture(t); let reads = 0; let calls = 0;
  const fetchImpl = async () => { calls++; assert.fail("must not send"); };
  const notifier = createLookupHumanNotifier({ webhookUrl, receiptsDir,
    getTargets: () => ++reads === 1 ? targets() : [], fetchImpl });
  assert.equal((await notifier.poll())[0].status, "cancelled");
  const blocker = path.join(receiptsDir, "blocker"); await fs.writeFile(blocker, "");
  await assert.rejects(createLookupHumanNotifier({ webhookUrl, receiptsDir: blocker, getTargets: targets, fetchImpl }).poll());
  assert.equal(calls, 0);
});

test("a persisted pre-response claim prevents resend after an interrupted process", async (t) => {
  const receiptsDir = await fixture(t);
  await fs.writeFile(path.join(receiptsDir, `${targets()[0].key}.json`), '{"status":"sending"}');
  const notifier = createLookupHumanNotifier({ webhookUrl, receiptsDir, getTargets: targets, fetchImpl: assert.fail });
  assert.deepEqual(await notifier.poll(), []);
  const next = { ...session, results: [{ ...session.results[0], resultId: "another-result" }] };
  assert.notEqual(pendingLookupHumanNotifications([next], devices)[0].key, targets()[0].key);
});

test("empty configuration is disabled, invalid destinations fail without disclosing a URL", async () => {
  assert.deepEqual(await createLookupHumanNotifier({ getTargets: assert.fail }).poll(), []);
  for (const url of ["http://open.feishu.cn/open-apis/bot/v2/hook/test", "https://example.com/hook",
    `${webhookUrl}?secret=test`, "https://user:password@open.feishu.cn/open-apis/bot/v2/hook/test"]) {
    assert.throws(() => createLookupHumanNotifier({ webhookUrl: url }), /^Error: invalid_lookup_human_webhook$/);
  }
});

test("private file configuration takes precedence over an environment value", async (t) => {
  const dir = await fixture(t); const file = path.join(dir, "secret");
  await fs.writeFile(file, `  ${webhookUrl}\n`, { mode: 0o600 });
  assert.equal(await readLookupHumanWebhook({ LOOKUP_HUMAN_FEISHU_WEBHOOK_FILE: file,
    LOOKUP_HUMAN_FEISHU_WEBHOOK: "unused" }), webhookUrl);
  assert.equal(await readLookupHumanWebhook({}), "");
});
