import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const block = source.slice(source.indexOf("function recoveryRequestKey("), source.indexOf("function renderWindows()"));
function fixture(api = async () => ({control: {revision: 14}})) {
  const oldAt = "2026-10-19T01:29:34.504Z";
  const health = {protocol: "device_recovery_control_v1", revision: 13, synced: true, isolationReset: true,
    isolated: [{serial: "PHONE18", reason: "recovery_attempts_exhausted", isolatedAt: oldAt, failures: 0}]};
  const agent = {agentId: "fixture", agentName: "Fixture", lastSeenAt: "online",
    recoveryControl: {revision: 13, paused: [], releases: [{serial: "PHONE18", revision: 13}]},
    health: {recoveryControl: health, deviceRecovery: {observedAt: oldAt, queue: [{serial: "PHONE18", deviceName: "18", state: "adb_interface_ready_transport_missing"}]}}};
  const els = {windowsRecoveryConsole: {innerHTML: ""}};
  const state = {agents: [agent], devices: []};
  const calls = [];
  const context = vm.createContext({state, els, isOnline: Boolean, shortTime: value => value || "",
    escapeHtml: value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    api: async (...args) => {calls.push(args); return api(...args);}, loadAll: async () => {}});
  vm.runInContext(block, context);
  const render = () => vm.runInContext("renderWindowsRecoveryConsole()", context);
  const submit = () => context.submitRecoveryControl({dataset: {agentId: "fixture", recoveryToggle: "phone18", paused: "false", resetIsolation: "true", revision: "13"}});
  render();
  return {context, state, health, agent, calls, render, submit, html: () => els.windowsRecoveryConsole.innerHTML,
    request: () => state.windowsRecoveryRequests.get(context.recoveryRequestKey("fixture", "PHONE18"))};
}

test("click immediately shows progress and a second click cannot duplicate the release", async () => {
  let resolve;
  const f = fixture(() => new Promise(value => {resolve = value;}));
  const pending = f.submit();
  assert.match(f.html(), /正在提交/);
  assert.match(f.html(), /处理中…/);
  await f.submit();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(f.calls[0][1].body), {adbSerial: "phone18", paused: false, resetIsolation: true, expectedRevision: 13});
  resolve({control: {revision: 14}});
  await pending;
  assert.match(f.html(), /等待管理器确认执行/);
});

test("an ACK with the old isolation still present is never presented as a successful release", async () => {
  const f = fixture(); await f.submit(); f.health.revision = 14; f.render();
  assert.match(f.html(), /解除结果待确认/);
  assert.doesNotMatch(f.html(), /<em[^>]*>隔离已解除/);
  f.request().startedAt -= 91_000; f.render();
  assert.match(f.html(), /解除尚未确认/);
  assert.doesNotMatch(f.html(), /处理中…/);
});

test("cleared isolation confirms release without claiming that the phone is online", async () => {
  const f = fixture(); await f.submit(); f.health.revision = 14; f.health.isolated = []; f.render();
  assert.match(f.html(), /隔离已解除/);
  assert.match(f.html(), /设备是否上线以当前断点为准/);
  assert.doesNotMatch(f.html(), /设备已上线/);
});

test("a later incident explicitly says isolated again and retains its actual reason", async () => {
  const f = fixture(); await f.submit(); f.health.revision = 14;
  f.health.isolated[0].isolatedAt = "2026-10-19T02:29:34.504Z"; f.render();
  assert.match(f.html(), /恢复后再次隔离/);
  assert.match(f.html(), /恢复动作链已耗尽/);
  assert.doesNotMatch(f.html(), /处理中…/);
});

test("offline manager and persistence errors remain distinct from completed release", async () => {
  const f = fixture(); await f.submit(); f.agent.lastSeenAt = ""; f.render();
  assert.match(f.html(), /等待管理器上线/);
  f.agent.lastSeenAt = "online"; f.health.revision = 14; f.health.isolationError = "recovery_isolation_save_failed"; f.render();
  assert.match(f.html(), /未能读写恢复记录/);
});

test("failed or malformed responses remain unconfirmed and are never automatically repeated", async () => {
  for (const api of [async () => {throw Error("recovery_control_revision_conflict");}, async () => {throw Error("network");}, async () => ({})]) {
    const f = fixture(api); await f.submit(); f.render(); f.render();
    assert.match(f.html(), /提交结果未确认/);
    assert.equal(f.calls.length, 1);
    assert.doesNotMatch(f.html(), /<em[^>]*>隔离已解除/);
  }
});

test("reloaded page explains a synced prior release while preserving current isolation", () => {
  const f = fixture();
  assert.match(f.html(), /当前仍处于隔离/);
  assert.match(f.html(), /解除请求已送达/);
  assert.match(f.html(), /解除隔离并继续/);
});

test("request feedback is scoped to one phone and escaped by the actual row renderer", async () => {
  const f = fixture();
  f.health.isolated.push({serial: "PHONE19", reason: "recovery_attempts_exhausted", isolatedAt: "2026-10-19T01:20:00Z"});
  await f.submit();
  const otherRow = f.html().split('<article class="recovery-device-row').find(row => row.includes('data-recovery-toggle="PHONE19"'));
  assert.ok(otherRow);
  assert.doesNotMatch(otherRow, /处理中…/);
  f.request().phase = "unconfirmed"; f.request().error = '<img src=x onerror="alert(1)">'; f.render();
  assert.doesNotMatch(f.html(), /<img src=x/);
  assert.match(f.html(), /&lt;img src=x/);
});

test("ordinary pause still waits for ACK and later admin changes cannot show stale success", async () => {
  const f = fixture(); f.health.isolated = []; f.agent.recoveryControl.releases = [];
  await f.context.submitRecoveryControl({dataset: {agentId: "fixture", recoveryToggle: "phone18", paused: "true", resetIsolation: "false", revision: "13"}});
  assert.match(f.html(), /等待管理器确认执行/);
  f.agent.recoveryControl.paused = [{serial: "PHONE18"}]; f.health.revision = 14; f.render();
  assert.match(f.html(), /自动恢复已暂停/);
  f.agent.recoveryControl.paused = []; f.health.revision = 15; f.render();
  assert.match(f.html(), /恢复设置已更新/);
  assert.doesNotMatch(f.html(), /<em[^>]*>自动恢复已暂停/);
});

test("clearing isolation cannot claim resumed recovery when a newer pause is active", async () => {
  const f = fixture(); await f.submit(); f.health.revision = 15;
  f.health.isolated = []; f.agent.recoveryControl.paused = [{serial: "PHONE18"}]; f.render();
  assert.match(f.html(), /隔离已解除，恢复仍暂停/);
  assert.doesNotMatch(f.html(), /已继续自动恢复；设备是否上线/);
});

test("an acknowledged old request cannot report success for an unacknowledged newer setting", async () => {
  const f = fixture(); await f.submit(); f.health.revision = 14;
  f.agent.recoveryControl.revision = 15; f.agent.recoveryControl.paused = [{serial: "PHONE18"}];
  f.health.isolated = []; f.render();
  assert.match(f.html(), /新设置等待确认/);
  assert.doesNotMatch(f.html(), /隔离已解除，恢复仍暂停/);
  f.health.revision = 15; f.render();
  assert.match(f.html(), /隔离已解除，恢复仍暂停/);
});
