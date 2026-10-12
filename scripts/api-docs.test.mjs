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

test("platform catalog is reproducible and publishes 39 reviewed platform operations", () => {
  const before = ["api-reference.json", "openapi.json", "downloads/name-lookup-integration.zip", "downloads/name-lookup-sha256.json", "downloads/name-lookup-openapi.json", "downloads/sign.mjs"].map((file) => fs.readFileSync(path.join(publicDir, file)));
  const build = spawnSync("python3", [path.join(root, "scripts/build-api-docs.py")], { cwd: root, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  assert.deepEqual(["api-reference.json", "openapi.json", "downloads/name-lookup-integration.zip", "downloads/name-lookup-sha256.json", "downloads/name-lookup-openapi.json", "downloads/sign.mjs"].map((file) => fs.readFileSync(path.join(publicDir, file))), before);
  assert.equal(data.endpoints.length, 39);
  assert.equal(data.websockets.length, 0);
  assert.equal(new Set(data.endpoints.map((e) => e.id)).size, 39);
  assert.equal(Object.values(spec.paths).reduce((n, p) => n + Object.keys(p).length, 0), 39);
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
    assert.deepEqual(op.security, e.auth === "public" ? [] : e.auth === "hmac" ? [{ HmacSignature: [] }] : [{ Bearer: [] }]);
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
    assert.equal(Number(python.stdout), 39);
  } finally { fs.rmSync(temp, { recursive: true }); }
});

test("published data and downloads exclude other categories and unused models", () => {
  const reviewed = JSON.parse(fs.readFileSync(path.join(root, "docs/api-reference-contracts.json")));
  const expected = new Set(["auth", "user", "sms", "lookup-user", "qr-scan", "kuaishou-lead", "xhs-publish", "screen"]);
  assert.deepEqual(new Set(data.groups.map((g) => g[0])), expected);
  for (const e of data.endpoints) assert.ok(expected.has(e.group));
  assert.deepEqual(data.guides.map((g) => g.id), ["overview", "authentication", "lookup-flow", "states", "business-flow", "handover", "models", "errors"]);
  assert.equal(spec.components.securitySchemes.HmacSignature.name, "X-Signature");
  assert.deepEqual(spec["x-websocket-channels"], []);
  assert.ok(data.models.OpenLookupSession);
  assert.ok(data.models.OpenLookupResult);
  for (const [name, fields] of Object.entries(data.models)) assert.deepEqual(fields, reviewed.models[name]);
  for (const path of Object.keys(spec.paths)) assert.ok((!path.includes("/open/") || path.startsWith("/api/v1/open/name-lookups/")) && !path.includes("/windows-agents") && !path.includes("/internal/"), path);
  assert.ok(JSON.stringify(data.guides).includes("HMAC"));
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
  assert.equal(new Set(groups).size, 8);
  const nav = render.navigationContent().html;
  for (const e of data.endpoints) assert.ok(nav.includes(`href="#${e.id}"`), e.id);
  for (const guide of data.guides) assert.ok(nav.includes(`href="#${guide.id}"`));
  assert.ok(!nav.includes('data-group="open-lookup"'));
  assert.ok(!nav.includes('data-group="admin"'));
  assert.ok(!nav.includes('data-group="agent"'));
  assert.equal(render.navigationContent("/api/v1/open/").count, 7);
  assert.ok(nav.includes("第三方接入 · HMAC") && nav.includes("平台操作 · Bearer"));
  assert.equal(render.navigationContent("/api/v1/windows-agents").count, 0);
  assert.ok(!fs.readFileSync(path.join(publicDir, "api-docs.html"), "utf8").includes('id="docsScope"'));
  for (const guide of data.guides) {
    const html = render.guidePage(guide);
    for (const [, id] of html.matchAll(/href="#([^"~]+)(?:~[^"]*)?"/g)) assert.ok(data.guides.some((g) => g.id === id) || data.endpoints.some((e) => e.id === id), id);
  }
});

test("SMS, lookup, QR, Kuaishou and publishing are distinct business references", () => {
  const expected = { sms: 6, "lookup-user": 13, "qr-scan": 4, "kuaishou-lead": 3, "xhs-publish": 3 };
  const titles = { sms: "短信接码", "lookup-user": "支付宝查名字", "qr-scan": "小红书自动登录", "kuaishou-lead": "快手录入", "xhs-publish": "小红书一键发布" };
  for (const [group, count] of Object.entries(expected)) {
    assert.equal(data.endpoints.filter((e) => e.group === group).length, count, group);
    assert.equal(data.groups.find((g) => g[0] === group)[1], titles[group]);
    assert.ok(render.navigationContent().html.includes(`data-group="${group}"`));
    assert.ok(render.guidePage(data.guides[0]).includes(`<b>${titles[group]}</b>`));
  }
  assert.equal(data.endpoints.find((e) => e.id === "get-api-v1-tasks-p1-progress").group, "qr-scan");
  assert.equal(data.endpoints.find((e) => e.id === "get-api-v1-user-phones").group, "sms");
  for (const e of data.endpoints) {
    if (e.path.includes("xhs-publish-tasks")) assert.equal(e.group, "xhs-publish");
    if (e.path.includes("kuaishou-lead-tasks")) assert.equal(e.group, "kuaishou-lead");
    if (e.path.includes("/xhs/qr-scan-tasks")) assert.equal(e.group, "qr-scan");
    assert.deepEqual(spec.paths[e.path][e.method.toLowerCase()].tags, [e.group]);
  }
});

test("HMAC examples match the deployed signing function for exact UTF-8 request bodies", async () => {
  const { signedHeaders } = await import(new URL("../releases/platform-api-docs-20261010-rc.1/public/downloads/sign.mjs", import.meta.url));
  const router = fs.readFileSync(path.join(candidate, "server/index.mjs"), "utf8");
  const source = router.match(/function signOpenApiRequest\([\s\S]*?\n\}/)[0];
  const sign = vm.runInNewContext(`(${source})`, { crypto });
  const secret = "synthetic-test-secret-with-32-characters";
  for (const [method, pathname, body] of [["GET", "/api/v1/open/name-lookups/devices", ""], ["POST", "/api/v1/open/name-lookups/sessions/demo/end", "{}"], ["POST", "/api/v1/open/name-lookups/sessions/demo/queries", JSON.stringify({ clientReference: "demo-order-0001", text: "示例字符" })]]) {
    const headers = signedHeaders(secret, "synthetic-client", method, pathname, body);
    assert.equal(headers["X-Signature"], sign(secret, method, pathname, headers["X-Timestamp"], headers["X-Nonce"], body));
    assert.notEqual(headers["X-Signature"], sign(secret, method, pathname, headers["X-Timestamp"], headers["X-Nonce"], body + " "));
  }
  for (const e of data.endpoints.filter((e) => e.auth === "hmac")) {
    const op = spec.paths[e.path][e.method.toLowerCase()];
    for (const name of ["X-Client-Id", "X-Timestamp", "X-Nonce"]) assert.ok(op.parameters.some((p) => p.in === "header" && p.name === name && p.required));
    assert.ok(e.errors.includes("invalid_open_api_signature"));
    if (e.idempotency) assert.ok(op.parameters.some((p) => p.name === "Idempotency-Key" && p.required));
  }
});

test("handover archive has verified members, seven HMAC operations and unchanged SDK code", () => {
  const program = String.raw`import hashlib,json,sys,zipfile,pathlib,re,ast
root=pathlib.Path(sys.argv[1]); public=root/'public'
manifest=json.loads((public/'downloads/name-lookup-sha256.json').read_text())
archive=public/'downloads/name-lookup-integration.zip'
assert hashlib.sha256(archive.read_bytes()).hexdigest()==manifest['archiveSha256']
with zipfile.ZipFile(archive) as z:
    assert set(z.namelist())==set(manifest['files'])|{'SHA256.json'}
    for name,digest in manifest['files'].items(): assert hashlib.sha256(z.read(name)).hexdigest()==digest
    inner=json.loads(z.read('SHA256.json')); assert inner['files']==manifest['files']
    spec=json.loads(z.read('openapi.json')); assert sum(len(p) for p in spec['paths'].values())==7
    assert set(spec['components']['securitySchemes'])=={'HmacSignature'}
    for name in ['node_client.mjs','python_client.py']:
        assert z.read(name)==(root/'verification/fixtures/sdk/open_name_lookup'/name).read_bytes()
    ast.parse(z.read('python_client.py').decode())
    readme=z.read('README.md').decode()
    fence=chr(96)*3
    for code in re.findall(fence+r'python\n([\s\S]*?)'+fence,readme): ast.parse(code)
    assert 'restrictedAt' not in z.read('OPEN_NAME_LOOKUP_API.md').decode()
print('Archive hashes, SDK provenance and seven-operation scope passed')`;
  const run = spawnSync("python3", ["-c", program, candidate], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(data.models.AccountCooldown.some((f) => f.name === "limitedAt"));
  assert.ok(data.models.AccountCooldown.some((f) => f.name === "remainingMs"));
  assert.ok(!data.models.AccountCooldown.some((f) => f.name === "restrictedAt"));
  const guide = { id: "handover", title: "safe", intro: "safe", paragraphs: [], sections: [{ title: '<script>x</script>', table: { headers: ["<img>"], rows: [["<script>alert(1)</script>"]] } }] };
  const html = render.guidePage(guide);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("downloads/name-lookup-integration.zip"));
});
