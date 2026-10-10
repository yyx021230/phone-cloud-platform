import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidate = path.join(root, "releases/platform-api-docs-20261010-rc.1");
const publicDir = path.join(candidate, "public");
const data = JSON.parse(fs.readFileSync(path.join(publicDir, "api-reference.json")));
const spec = JSON.parse(fs.readFileSync(path.join(publicDir, "openapi.json")));
const script = fs.readFileSync(path.join(publicDir, "api-docs.js"), "utf8");
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, { value: "", innerHTML: "", textContent: "", hidden: false, addEventListener() {}, setAttribute() {}, focus() {}, contains() { return false; }, querySelectorAll() { return []; } });
  return elements.get(id);
};
const context = vm.createContext({ document: { getElementById: element, addEventListener() {}, body: { classList: { toggle() {}, contains() { return false; } } } },
  window: { addEventListener() {}, scrollTo() {}, matchMedia() { return { matches: false }; } }, location: { hash: "" }, setTimeout, clearTimeout });
// Exercise the real renderer and snippet generator with a minimal DOM, without
// executing fetch() or changing production exports just to accommodate tests.
const instrumented = script.replace(/  load\(\);\n\}\)\(\);\s*$/, "  globalThis.referenceTest = { load, requestExample, endpointPage, guidePage, setData: v => { data = v; } };\n})();");
assert.ok(instrumented !== script, "Test instrumentation must replace only the auto-load call");
vm.runInContext(instrumented, context);
const render = context.referenceTest;
render.setData(data);

test("generated catalog is reproducible and all 106 HTTP / 6 WS routes are covered", () => {
  const before = ["api-reference.json", "openapi.json"].map((file) => fs.readFileSync(path.join(publicDir, file), "utf8"));
  const build = spawnSync("python3", [path.join(root, "scripts/build-api-docs.py")], { cwd: root, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  assert.deepEqual(["api-reference.json", "openapi.json"].map((file) => fs.readFileSync(path.join(publicDir, file), "utf8")), before);
  assert.equal(data.endpoints.length, 106);
  assert.equal(data.websockets.length, 6);
  assert.equal(new Set(data.endpoints.map((e) => e.id)).size, 106);
  assert.equal(Object.values(spec.paths).reduce((n, p) => n + Object.keys(p).length, 0), 106);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(candidate, "server/index.mjs"))).digest("hex"), data.routerSha256);
  const relay = fs.readFileSync(path.join(candidate, "server/screen-relay.mjs"), "utf8");
  assert.equal((relay.match(/const \w+Match = url\.pathname\.match/g) || []).length, data.websockets.length);
});

test("OpenAPI references, path parameters, methods and HMAC headers are valid", () => {
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.$ref) assert.ok(spec.components.schemas[value.$ref.split("/").at(-1)], value.$ref);
    for (const child of Object.values(value)) visit(child);
  };
  visit(spec);
  for (const e of data.endpoints) {
    const op = spec.paths[e.path][e.method.toLowerCase()];
    assert.equal(op.operationId, e.id);
    for (const [, name] of e.path.matchAll(/\{(\w+)\}/g)) assert.ok(op.parameters.some((p) => p.in === "path" && p.name === name && p.required));
    if (e.auth === "hmac") {
      assert.ok(op.security.some((s) => s.HmacSignature));
      for (const name of ["X-Client-Id", "X-Timestamp", "X-Nonce"]) assert.ok(op.parameters.some((p) => p.name === name && p.required));
      if (e.idempotency === "required") assert.ok(op.parameters.some((p) => p.name === "Idempotency-Key" && p.required));
    }
    assert.ok(!e.parameters.some((p) => p.name.startsWith("p1")));
  }
});

test("all endpoint pages render; Node.js and Python examples parse without execution", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "phone-api-doc-examples-"));
  try {
    const pythonExamples = [];
    for (const e of data.endpoints) {
      const html = render.endpointPage(e);
      assert.ok(html.includes(e.title));
      assert.ok(html.includes("错误处理"));
      assert.ok(!html.includes("undefined"), e.id);
      if (e.bodyFormat) continue;
      const js = render.requestExample(e, "Node.js");
      const file = path.join(temp, "example.mjs");
      fs.writeFileSync(file, js);
      const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      assert.equal(syntax.status, 0, e.id + "\n" + syntax.stderr);
      pythonExamples.push({ id: e.id, code: render.requestExample(e, "Python") });
    }
    const examples = path.join(temp, "examples.json");
    fs.writeFileSync(examples, JSON.stringify(pythonExamples));
    const python = spawnSync("python3", ["-c", "import json,sys; data=json.load(open(sys.argv[1])); [compile(x['code'], x['id'], 'exec') for x in data]; print(len(data))", examples], { encoding: "utf8" });
    assert.equal(python.status, 0, python.stderr);
    assert.equal(Number(python.stdout), 105);
  } finally { fs.rmSync(temp, { recursive: true }); }
});

test("published signing example matches the actual server signer with millisecond timestamps", () => {
  const guide = data.guides.find((g) => g.id === "authentication");
  const signerContext = vm.createContext({ crypto });
  vm.runInContext(guide.code.replace('import crypto from "node:crypto";', "").replace("export function", "function") + "\nglobalThis.sign = signedHeaders;", signerContext);
  const server = fs.readFileSync(path.join(candidate, "server/index.mjs"), "utf8");
  const actualFunction = server.match(/function signOpenApiRequest\([\s\S]*?\n\}/)[0];
  const actualSign = vm.runInNewContext(`(${actualFunction})`, { crypto });
  for (const [method, pathname, body] of [["GET", "/api/v1/open/name-lookups/devices", ""], ["POST", "/api/v1/open/name-lookups/sessions", '{"deviceId":"adb:SERIAL-DEMO"}'], ["POST", "/api/v1/open/name-lookups/sessions/demo/end", "{}"]]) {
    const headers = signerContext.sign("synthetic-test-secret-only", "partner-demo", method, pathname, body);
    assert.equal(headers["X-Timestamp"].length, 13);
    assert.equal(headers["X-Signature"], actualSign("synthetic-test-secret-only", method, pathname, headers["X-Timestamp"], headers["X-Nonce"], body));
  }
});

test("open lookup model tables exactly match real public serialization and queue actions", async () => {
  const { publicOpenLookupSession, publicOpenLookupResult } = await import(path.join(candidate, "server/open-name-lookup-api.mjs"));
  assert.deepEqual(data.models.OpenLookupSession.map((f) => f.name).sort(), Object.keys(publicOpenLookupSession()).sort());
  assert.deepEqual(data.models.OpenLookupResult.map((f) => f.name).sort(), Object.keys(publicOpenLookupResult()).sort());
  const recovery = publicOpenLookupSession({ sessionId: "demo", status: "ready", results: [{ resultId: "query-demo", status: "needs_recovery", phoneNumber: "13800000000" }] });
  assert.equal(recovery.humanAction.required, false);
  assert.equal(recovery.queueState.action, "retry_current_query");
  const exhausted = publicOpenLookupSession({ status: "ready", requiresAccountSwitch: true });
  assert.equal(exhausted.queueState.action, "end_session_and_select_another_device");
});

test("renderer escapes untrusted strings and only fetches static reference data", async () => {
  const endpoint = { ...data.endpoints[0], title: '<img src=x onerror=alert(1)>', description: '"<script>alert(1)</script>' };
  const html = render.endpointPage(endpoint);
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;img"));
  const calls = [];
  context.fetch = async (url) => { calls.push(url); return { ok: true, json: async () => data }; };
  await render.load();
  assert.deepEqual(calls, ["./api-reference.json"]);
  assert.ok(!/localStorage|sessionStorage|document\.cookie|eval\(/.test(script));
  const index = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const inventory = index.slice(index.indexOf('id="userDeviceInventoryView"'), index.indexOf('class="user-device-toolbar'));
  assert.match(inventory, /href="\.\/api-docs\.html"[^>]+rel="noopener noreferrer"/);
});

test("builder rejects an undocumented new route before generating files", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "phone-api-doc-unreviewed-"));
  try {
    fs.mkdirSync(path.join(temp, "server"));
    fs.mkdirSync(path.join(temp, "public"));
    const source = fs.readFileSync(path.join(candidate, "server/index.mjs"), "utf8");
    fs.writeFileSync(path.join(temp, "server/index.mjs"), source + '\nif (req.method === "POST" && url.pathname === "/api/v1/unreviewed-route") { return {}; }\n');
    const build = spawnSync("python3", [path.join(root, "scripts/build-api-docs.py"), temp], { cwd: root, encoding: "utf8" });
    assert.notEqual(build.status, 0);
    assert.match(build.stderr, /Unreviewed route POST \/api\/v1\/unreviewed-route/);
    assert.equal(fs.existsSync(path.join(temp, "public/api-reference.json")), false);
  } finally { fs.rmSync(temp, { recursive: true }); }
});

test("all server and Agent source files retain the immutable rc.2 hash", () => {
  const base = path.join(root, "releases/lookup-20261010-rc.2");
  const walk = (folder, relative = "") => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(path.join(folder, entry.name), name);
      else assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(candidate, name))).digest("hex"), crypto.createHash("sha256").update(fs.readFileSync(path.join(base, name))).digest("hex"), name);
    }
  };
  for (const folder of ["server", "windows-agent"]) walk(path.join(base, folder), folder);
});
