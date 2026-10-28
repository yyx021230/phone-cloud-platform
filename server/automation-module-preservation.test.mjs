import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import vm from "node:vm";
import test from "node:test";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const app = read("public/app.js");
const html = read("public/index.html");
const proof = JSON.parse(read("docs/evidence/xhs-data-automation-20261013-rc2-kuaishou.json"));
const chunk = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const queueFunctions = chunk("function activeKuaishouLeadTask(", "function renderAutomationJobCard(");
const queueHandlers = chunk("els.userKuaishouStartButton?.addEventListener(", "els.userPublishImagesInput?.addEventListener(");

test("automation retains all existing modules and adds collection as the fifth module", () => {
  assert.deepEqual([...html.matchAll(/data-automation-module="([^"]+)"/g)].map((match) => match[1]),
    ["scan", "publish", "kuaishou", "data", "name"]);
  for (const name of proof.modules) assert.match(html, new RegExp(`data-automation-module-panel="${name}"`));
  const styles = read("public/styles.css");
  assert.equal([...styles.matchAll(/\.automation-module-tabs \{[^}]*repeat\(5, minmax\(0, 1fr\)\)/g)].length, 2);
});

test("the existing deployed Kuaishou handlers and task rendering are preserved byte for byte", () => {
  for (const [key, value] of [["kuaishou-functions", queueFunctions], ["kuaishou-handlers", queueHandlers]]) {
    assert.equal(crypto.createHash("sha256").update(value).digest("hex"), proof.preserved_chunks[key]);
  }
});

test("all five module clicks persist the selected module and render the workbench", () => {
  let handler;
  let renders = 0;
  const saved = new Map();
  const state = {};
  vm.runInNewContext(chunk("els.userAutomationModuleTabs?.addEventListener(", "function clearUserDataSession("), {
    state, els: { userAutomationModuleTabs: { addEventListener: (_type, fn) => { handler = fn; } } },
    localStorage: { setItem: (key, value) => saved.set(key, value) }, renderUserWorkbench: () => renders++
  });
  for (const module of proof.modules) {
    handler({ target: { closest: () => ({ dataset: { automationModule: module } }) } });
    assert.equal(state.userAutomationModule, module);
    assert.equal(saved.get("phoneCloudUserAutomationModule"), module);
  }
  assert.equal(renders, 5);
});

function harness() {
  const handlers = {};
  const calls = [];
  const state = { userSelectedDeviceId: "fixture102", userKuaishouBusy: false, userKuaishouTasks: [],
    userDataTasks: [{ jobId: "data-history" }] };
  const element = (name) => ({ value: "", disabled: false, dataset: {}, innerHTML: "", textContent: "",
    addEventListener: (_type, fn) => { handlers[name] = fn; } });
  const els = Object.fromEntries(["Status", "MinDelay", "MaxDelay", "Hint", "StartButton", "StopButton", "TaskList"]
    .map((name) => [`userKuaishou${name}`, element(name)]));
  els.userKuaishouMinDelay.value = "240";
  els.userKuaishouMaxDelay.value = "420";
  const context = vm.createContext({ state, els, escapeHtml: (value) => String(value), shortTime: () => "fixture-time",
    automationReadyForDevice: () => true, renderUserWorkbench: () => {}, refreshUserXhsTasksOnly: async () => {},
    api: async (url, options) => {
      calls.push({ url, ...options });
      return { task: { jobId: "queue-102", deviceId: "fixture102", status: url.endsWith("/stop") ? "cancelled" : "running" } };
    }
  });
  vm.runInContext(`${queueFunctions}\n${queueHandlers}`, context);
  return { state, els, calls, handlers, render: (device) => vm.runInContext(`renderKuaishouLead(${JSON.stringify(device)})`, context) };
}

test("Kuaishou uses its existing start/stop protocol and preserves data collection history", async () => {
  const h = harness();
  await h.handlers.StartButton();
  assert.equal(h.calls[0].url, "/api/v1/user/automation/kuaishou-lead-tasks");
  assert.equal(h.calls[0].method, "POST");
  assert.deepEqual(JSON.parse(h.calls[0].body), { deviceId: "fixture102", minDelaySeconds: 240, maxDelaySeconds: 420 });
  h.render({ deviceId: "fixture102" });
  assert.equal(h.els.userKuaishouStartButton.disabled, true);
  assert.equal(h.els.userKuaishouStopButton.disabled, false);
  await h.handlers.StopButton();
  assert.equal(h.calls[1].url, "/api/v1/user/automation/kuaishou-lead-tasks/queue-102/stop");
  assert.equal(h.state.userKuaishouTasks[0].status, "cancelled");
  assert.equal(h.state.userDataTasks[0].jobId, "data-history");
});

test("invalid delay does not create a queue task, and stopping another selected phone cannot stop this one", async () => {
  const h = harness();
  h.els.userKuaishouMinDelay.value = "29";
  await h.handlers.StartButton();
  assert.equal(h.calls.length, 0);
  assert.match(h.els.userKuaishouHint.textContent, /30–3600/);
  h.state.userKuaishouTasks = [{ jobId: "foreign-device", deviceId: "fixture74", status: "running" }];
  await h.handlers.StopButton();
  assert.equal(h.calls.length, 0);
  h.render({ deviceId: "fixture102", busy: true });
  assert.equal(h.els.userKuaishouStartButton.disabled, true);
});
