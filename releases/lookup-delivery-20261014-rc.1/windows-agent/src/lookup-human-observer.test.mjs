import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { classifyHumanVerificationXml, createLookupHumanObserver } from "./lookup-human-observer.mjs";
const focus = "mCurrentFocus=Window{a com.eg.android.AlipayGphone/.SearchActivity}";
const node = '<node package="com.eg.android.AlipayGphone" resource-id="com.alipay.mobile.antui:id/search_input_box" enabled="true" text="" />';
const xml = `<hierarchy rotation="0">${node}</hierarchy>`;

test("complete exact search page with positive before/after foreground can prove ready", () => {
  assert.equal(classifyHumanVerificationXml(xml, focus, focus), "search_ready");
});
test("a virtual display with exactly null focus does not hide the unique Alipay window", () => {
  const multiDisplay = `mTopFocusedDisplayId=0\nDisplay: mDisplayId=90000 (organized)\n  mCurrentFocus=null\nDisplay: mDisplayId=0 (organized)\n  ${focus}`;
  assert.equal(classifyHumanVerificationXml(xml, multiDisplay, multiDisplay), "search_ready");
  assert.equal(classifyHumanVerificationXml(xml, `${focus}\n  mCurrentFocus = null  `, focus), "search_ready");
  const vivo = "  mCurrentFocus=Window{a u0 com.eg.android.AlipayGphone/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity type=1}";
  assert.equal(classifyHumanVerificationXml(xml, `  mCurrentFocus=null\n${vivo}`, vivo), "search_ready");
});
test("null focus is ignored only when an unambiguous exact Alipay window remains", () => {
  for (const value of ["mCurrentFocus=null", "mCurrentFocus=null\nmCurrentFocus=null",
    `${focus}\n${focus}`, `${focus}\nmCurrentFocus=Window{b other/app}`,
    `${focus}\nmCurrentFocus=unknown`, `${focus}\nmCurrentFocus=null trailing-data`,
    "mCurrentFocus=Window{a prefix.com.eg.android.AlipayGphone/.SearchActivity}",
    "mCurrentFocus=Window{a other/app com.eg.android.AlipayGphone/.SearchActivity-extra} trailing-data",
    "mCurrentFocus=com.eg.android.AlipayGphone/.SearchActivity",
    "mCurrentFocus=Window{a u0 com.eg.android.AlipayGphone/.SearchActivity type=other/app}"]) {
    assert.equal(classifyHumanVerificationXml(xml, value, focus), "unknown", value);
    assert.equal(classifyHumanVerificationXml(xml, focus, value), "unknown", value);
  }
});
for (const marker of ["为保障您的正常访问请进行验证", "请拖动滑块完成拼图", "向右滑动验证"]) {
  test(`remaining verification marker is present, even with an input behind it: ${marker}`, () => {
    assert.equal(classifyHumanVerificationXml(xml.replace("</hierarchy>", `<node text="${marker}" /></hierarchy>`), focus, focus), "present");
  });
}
test("restriction pages sharing a feedback code are unknown, never a puzzle or a cleared search", () => {
  for (const texts of [["反馈码: synthetic"], ["操作频繁或访问异常，请稍后再试", "请稍后", "反馈码: synthetic"]]) {
    const page = xml.replace("</hierarchy>", texts.map((text) => `<node text="${text}" />`).join("") + "</hierarchy>");
    assert.equal(classifyHumanVerificationXml(page, focus, focus), "unknown");
  }
});
for (const value of ["", "<hierarchy></hierarchy>", xml.slice(0, -3), xml.replace("enabled=\"true\"", "enabled=\"false\""),
  `<hierarchy>${node}${node}</hierarchy>`, xml.replace("resource-id", "wrong-id"), xml.replace("/>", ">"),
  xml.replace("/>", ' enabled="false" />')]) {
  test(`missing, malformed, duplicate, disabled hierarchy remains unknown: ${value.length}`, () => {
    assert.equal(classifyHumanVerificationXml(value, focus, focus), "unknown");
  });
}
test("other app, missing focus and foreground change cannot prove clear", () => {
  assert.equal(classifyHumanVerificationXml(xml, "", focus), "unknown");
  assert.equal(classifyHumanVerificationXml(xml, focus, "mCurrentFocus=Window{other/app}"), "unknown");
});

test("an opaque WebView or account/login restriction cannot be mistaken for a cleared puzzle", () => {
  for (const attributes of ['class="android.webkit.WebView"', 'text="访问被拒绝"', 'text="短信验证码登录"']) {
    assert.equal(classifyHumanVerificationXml(xml.replace("</hierarchy>", `<node ${attributes} /></hierarchy>`), focus, focus), "unknown");
  }
  assert.equal(classifyHumanVerificationXml("<hierarchy></hierarchy>" + xml, focus, focus), "unknown");
  assert.equal(classifyHumanVerificationXml(xml.replace("</hierarchy>", '<node text="&#x4e3a;" /></hierarchy>'), focus, focus), "unknown");
});

test("observer bounds work, rotates devices, reports only enum and opaque lease", async () => {
  const calls = [], reads = [];
  const probes = Array.from({ length: 5 }, (_, i) => ({ adbSerial: `SYNTHETIC-${i}`, probeId: `lease-${i}` }));
  const observer = createLookupHumanObserver({ agentId: "a", canObserve: () => true,
    observe: async (probe) => { reads.push(probe.adbSerial); return "search_ready"; },
    request: async (_path, options) => { calls.push(options); return { probes }; } });
  await observer.poll(); await observer.poll();
  assert.deepEqual(reads, ["SYNTHETIC-0", "SYNTHETIC-1", "SYNTHETIC-2", "SYNTHETIC-3", "SYNTHETIC-4", "SYNTHETIC-0"]);
  for (const request of calls.filter((call) => call.method === "POST")) assert.deepEqual(Object.keys(request.body).sort(), ["probeId", "state"]);
});

test("busy devices, read errors and unrecognised state are unknown", async () => {
  const states = [];
  const observer = createLookupHumanObserver({ agentId: "a", canObserve: (probe) => probe.probeId !== "busy",
    observe: async (probe) => { if (probe.probeId === "error") throw Error("timeout"); return "arbitrary text"; },
    request: async (_path, options) => {
      if (options.method === "POST") states.push(options.body.state);
      return { probes: ["busy", "error", "bad"].map((probeId) => ({ probeId })) };
    } });
  await observer.poll(); assert.deepEqual(states, ["unknown", "unknown", "unknown"]);
});

test("single-flight and shutdown ignore late read completions", async () => {
  let complete, reads = 0, posts = 0;
  const observer = createLookupHumanObserver({ agentId: "a", canObserve: () => true,
    observe: () => { reads++; return new Promise((resolve) => { complete = resolve; }); },
    request: async (_path, options) => { if (options.method === "POST") posts++; return { probes: [{ probeId: "one" }] }; } });
  const running = observer.poll(); await new Promise((resolve) => setImmediate(resolve));
  await observer.poll(); assert.equal(reads, 1);
  observer.stop(); complete("search_ready"); await running;
  assert.equal(posts, 0);
});

test("fresh requery only for the explicit new handover flag; generic query_resume unchanged", () => {
  const agent = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
  const start = agent.indexOf("  const operation = task.type === \"alipay_name_start\"");
  const end = agent.indexOf("  const queryOperation", start);
  const operation = (payload) => vm.runInNewContext(`${agent.slice(start, end)};operation`, { task: { type: "alipay_name_query", payload } });
  assert.equal(operation({ resumeAfterHumanVerification: true, restartAfterHumanVerification: true }), "query");
  assert.equal(operation({ resumeAfterHumanVerification: true }), "query_resume");
  assert.equal(operation({}), "query");
  const observation = agent.slice(agent.indexOf("async function observeLookupHumanVerification"), agent.indexOf("async function taskAlipayNameLookup"));
  assert.doesNotMatch(observation.replace(/\/\/[^\n]*/g, ""), /stopAirtestWorker|getAirtestWorker|runXhsAirtestPocoWorker|"input"|force-stop|screencap/);
  assert.match(observation, /exec-out", "uiautomator", "dump", "\/dev\/tty/);
  assert.match(agent, /\.\.\.activeTaskSerials, \.\.\.screenControlledSerials/);
});

function agentObservationHarness({ screen = true, worker = null, busy = false } = {}) {
  const agent = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
  const observation = agent.slice(agent.indexOf("async function observeLookupHumanVerification"), agent.indexOf("async function taskAlipayNameLookup"));
  const calls = [];
  const manual = { serial: "SYNTHETIC", closed: false };
  const context = vm.createContext({
    activeTaskSerials: new Set(busy ? ["SYNTHETIC"] : []),
    automationPreflightRunning: new Set(),
    screenControlledSerials: new Set(screen ? ["SYNTHETIC"] : []),
    airtestWorkersBySerial: new Map(worker ? [["SYNTHETIC", worker]] : []),
    failedHumanProbeWorkers: new WeakSet(),
    screenStreamManager: { sessions: new Map(screen ? [["manual", manual]] : []) },
    config: { adbPath: "synthetic-adb-never-executed" },
    classifyHumanVerificationXml,
    adb: async (_serial, args, options) => {
      calls.push({ args, options });
      return args[0] === "exec-out" ? xml : focus;
    }
  });
  vm.runInContext(observation, context);
  return { calls, manual, context, observe: () => context.observeLookupHumanVerification({
    adbSerial: "SYNTHETIC", screenSessionId: screen ? "manual" : "", probeId: "opaque"
  }) };
}

test("real Agent observer uses only background foreground/dump reads during manual control", async () => {
  const h = agentObservationHarness();
  assert.equal(await h.observe(), "search_ready");
  assert.deepEqual(h.calls.map(({ args }) => Array.from(args)), [
    ["shell", "dumpsys", "window"], ["exec-out", "uiautomator", "dump", "/dev/tty"], ["shell", "dumpsys", "window"]
  ]);
  for (const call of h.calls) {
    assert.equal(call.options.allowScreenControl, true);
    assert.equal(call.options.actorPriority, undefined, "no priority promotion over human control");
    assert.ok(call.options.timeoutMs <= (call.args[0] === "exec-out" ? 15_000 : 2_000));
  }
});

test("real observer never reads a busy phone or takes UiAutomation from a resident worker", async () => {
  for (const options of [{ busy: true }, { worker: { exited: false } }]) {
    const h = agentObservationHarness(options);
    assert.equal(await h.observe(), "unknown"); assert.equal(h.calls.length, 0);
  }
});

test("idle existing Poco observer never creates/repairs workers and quarantines a timed-out probe", async () => {
  const requests = [];
  const worker = { enqueue: async (request) => { requests.push(request); return { ok: true, verificationState: "search_ready" }; } };
  const h = agentObservationHarness({ screen: false, worker });
  assert.equal(await h.observe(), "search_ready"); assert.equal(h.calls.length, 0);
  assert.equal(requests[0].operation, "human_probe");
  assert.equal(requests[0].workflow, "alipay_name");
  worker.enqueue = async () => { requests.push("timeout"); throw Error("timeout"); };
  assert.equal(await h.observe(), "unknown");
  assert.equal(await h.observe(), "unknown");
  assert.equal(requests.length, 2, "no blind repeat into a timed-out worker");
});


test("an exited or absent worker permits bounded read-only fallback without a control window", async () => {
  for (const worker of [null, { exited: true }]) {
    const h = agentObservationHarness({ screen: false, worker });
    assert.equal(await h.observe(), "search_ready");
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls[1].options.timeoutMs, 15_000);
    assert.ok(h.calls.every((call) => call.options.allowScreenControl === false));
  }
});

for (const change of ["task", "worker", "control", "screen-replaced", "preflight"]) {
  test(`handover during a read cannot approve a stale observation: ${change}`, async () => {
    const h = agentObservationHarness({ screen: change === "screen-replaced" });
    const original = h.context.adb;
    h.context.adb = async (...args) => {
      const result = await original(...args);
      if (args[1][0] === "exec-out") {
        if (change === "task") h.context.activeTaskSerials.add("SYNTHETIC");
        if (change === "preflight") h.context.automationPreflightRunning.add("SYNTHETIC");
        if (change === "worker") h.context.airtestWorkersBySerial.set("SYNTHETIC", { exited: false });
        if (change === "control") h.context.screenControlledSerials.add("SYNTHETIC");
        if (change === "screen-replaced") h.context.screenStreamManager.sessions.set("manual", { ...h.manual });
      }
      return result;
    };
    assert.equal(await h.observe(), "unknown");
    assert.equal(h.calls.length, 2);
  });
}

test("a slow phone cannot delay another phone's observation report", async () => {
  let finish;
  const posted = [];
  const observer = createLookupHumanObserver({ agentId: "a", canObserve: () => true,
    observe: (probe) => probe.probeId === "slow" ? new Promise((resolve) => { finish = resolve; }) : "search_ready",
    request: async (_path, options) => {
      if (options.method === "POST") posted.push(options.body.probeId);
      return { probes: [{ probeId: "slow" }, { probeId: "fast" }] };
    } });
  const polling = observer.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posted, ["fast"]);
  finish("unknown"); await polling;
  assert.deepEqual(posted, ["fast", "slow"]);
});

test("the newly observed native frequency restriction is never a cleared puzzle", () => {
  const page = xml.replace("</hierarchy>", '<node text="您请求次数过于频繁" /><node text="待会来试试" /></hierarchy>');
  assert.equal(classifyHumanVerificationXml(page, focus, focus), "unknown");
});
