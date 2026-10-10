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
const instrumented = script.replace(/  load\(\);\n\}\)\(\);\s*$/, "  globalThis.referenceTest = { load, requestExample, endpointPage, guidePage, navigationContent, navigationSections, setData: v => { data = v; } };\n})();");
assert.ok(instrumented !== script, "Test instrumentation must replace only the auto-load call");
vm.runInContext(instrumented, context);
const render = context.referenceTest;
render.setData(data);

test("platform catalog is reproducible and publishes 32 platform routes only", () => {
  const before = ["api-reference.json", "openapi.json"].map((file) => fs.readFileSync(path.join(publicDir, file), "utf8"));
  const build = spawnSync("python3", [path.join(root, "scripts/build-api-docs.py")], { cwd: root, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  assert.deepEqual(["api-reference.json", "openapi.json"].map((file) => fs.readFileSync(path.join(publicDir, file), "utf8")), before);
  assert.equal(data.endpoints.length, 32);
  assert.equal(data.websockets.length, 0);
  assert.equal(new Set(data.endpoints.map((e) => e.id)).size, 32);
  assert.equal(Object.values(spec.paths).reduce((n, p) => n + Object.keys(p).length, 0), 32);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(candidate, "server/index.mjs"))).digest("hex"), data.routerSha256);
  assert.equal(data.sourceRoutesReviewed, 106);
});

test("OpenAPI references, path parameters, methods and Bearer security are valid", () => {
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
    assert.notEqual(e.auth, "hmac");
    assert.deepEqual(op.security, e.auth === "public" ? [] : [{ Bearer: [] }]);
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
    assert.equal(Number(python.stdout), 32);
  } finally { fs.rmSync(temp, { recursive: true }); }
});

test("published data and downloads exclude other categories and unused models", () => {
  const reviewed = JSON.parse(fs.readFileSync(path.join(root, "docs/api-reference-contracts.json")));
  const expected = new Set(["auth", "user", "lookup-user", "sms", "automation", "screen"]);
  assert.deepEqual(new Set(data.groups.map((g) => g[0])), expected);
  for (const e of data.endpoints) assert.ok(expected.has(e.group));
  assert.deepEqual(data.guides.map((g) => g.id), ["overview", "authentication", "models", "errors"]);
  assert.equal(spec.components.securitySchemes.HmacSignature, undefined);
  assert.deepEqual(spec["x-websocket-channels"], []);
  assert.equal(data.models.OpenLookupSession, undefined);
  assert.equal(data.models.OpenLookupResult, undefined);
  for (const [name, fields] of Object.entries(data.models)) assert.deepEqual(fields, reviewed.models[name]);
  for (const path of Object.keys(spec.paths)) assert.ok(!path.includes("/open/") && !path.includes("/windows-agents") && !path.includes("/internal/"), path);
  assert.ok(!JSON.stringify(data.guides).includes("HMAC"));
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

test("platform navigation and search cannot restore excluded categories", () => {
  const groups = render.navigationSections.flatMap((section) => Array.from(section.groups || []));
  assert.equal(new Set(groups).size, 6);
  const nav = render.navigationContent().html;
  for (const e of data.endpoints) assert.ok(nav.includes(`href="#${e.id}"`), e.id);
  for (const guide of data.guides) assert.ok(nav.includes(`href="#${guide.id}"`));
  assert.ok(!nav.includes('data-group="open-lookup"'));
  assert.ok(!nav.includes('data-group="admin"'));
  assert.ok(!nav.includes('data-group="agent"'));
  assert.equal(render.navigationContent("/api/v1/open/").count, 0);
  assert.equal(render.navigationContent("/api/v1/windows-agents").count, 0);
  assert.ok(!fs.readFileSync(path.join(publicDir, "api-docs.html"), "utf8").includes('id="docsScope"'));
  for (const guide of data.guides) {
    const html = render.guidePage(guide);
    for (const [, id] of html.matchAll(/href="#([^"~]+)(?:~[^"]*)?"/g)) assert.ok(data.guides.some((g) => g.id === id) || data.endpoints.some((e) => e.id === id), id);
  }
});
