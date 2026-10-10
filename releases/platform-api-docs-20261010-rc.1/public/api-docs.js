/* Static reference only: no business API calls, stored credentials or external assets. */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let data;
  let activeId = "overview";
  let copyTimer;
  let lastNavWasSearch = false;
  const expandedGroups = new Set();
  const navigationSections = [
    { title: "开始使用", guides: ["overview", "authentication"] },
    { title: "基础接口", groups: ["auth", "user"] },
    { title: "业务接口", groups: ["sms", "lookup-user", "qr-scan", "kuaishou-lead", "xhs-publish"] },
    { title: "设备工具", groups: ["screen"] },
    { title: "参考资料", guides: ["models", "errors"] }
  ];
  const authNames = { hmac: "HMAC-SHA256 · 第三方开放", "user,admin": "Bearer · 用户 / 管理员", "admin,user": "Bearer · 管理员 / 用户", admin: "Bearer · 管理员", windows: "Bearer · 绑定 Windows Agent", device: "Bearer · Android device", "admin,windows,device": "Bearer · admin / windows / device", "third-party": "Bearer · 旧版第三方", public: "无需认证", "media-hook": "媒体服务专用凭据", "admin / evidence-signature": "管理员或临时证据签名" };
  const guideIcons = { overview: "◈", authentication: "⌘", "lookup-flow": "↗", states: "⇄", models: "▤", errors: "!", websockets: "⌁" };
  const exampleValues = { deviceId: "adb:SERIAL-DEMO", sessionId: "session-demo", queryId: "query-demo", requestId: "request-demo", taskId: "task-demo", userId: "user-demo", agentId: "agent-demo", clientReference: "demo-order-0001", consentReference: "demo-consent-0001", phoneNumber: "13800000000", username: "integration_demo", password: "<PASSWORD>", currentPassword: "<CURRENT_PASSWORD>", newPassword: "<NEW_PASSWORD>", deliveryToken: "<DELIVERY_TOKEN>", title: "示例标题", content: "已审核的示例正文", imageDataUrls: ["data:image/png;base64,<IMAGE_BYTES>"], qrImageDataUrl: "data:image/png;base64,<QR_BYTES>", imageDataUrl: "data:image/png;base64,<IMAGE_BYTES>", listingStatus: "listed", deviceIds: ["adb:SERIAL-DEMO"], type: "adb_collect_diagnostics", status: "running", probeId: "probe-demo", state: "search_ready" };

  function fieldTable(fields, parameters = false) {
    if (!fields.length) return '<p class="empty-note">无额外参数。</p>';
    return `<div class="table-wrap"><table><thead><tr><th>名称</th><th>类型${parameters ? " / 必填" : ""}</th><th>说明</th></tr></thead><tbody>${fields.map((p) => `<tr><td><code>${esc(p.name)}</code></td><td><span class="type-cell">${esc(p.type)}</span>${parameters ? `<br/><span class="${p.required ? "required" : "optional"}">${p.required ? "必填" : "可选"}</span>` : ""}</td><td>${esc(p.description)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function codePanel(code, label = "JSON") {
    return `<div class="code-panel"><div class="code-toolbar"><span>${esc(label)}</span><button class="copy-small" data-copy-code>复制代码</button></div><pre><code>${esc(code)}</code></pre></div>`;
  }

  function navigationContent(query = "") {
    const matches = data.endpoints.filter((e) => `${e.title} ${e.method} ${e.path} ${e.description} ${e.auth} ${e.errors.join(" ")} ${e.parameters.map((p) => p.name).join(" ")}`.toLowerCase().includes(query));
    const guides = data.guides.filter((g) => !query || `${g.title} ${g.intro} ${g.paragraphs.join(" ")}`.toLowerCase().includes(query));
    const guideLink = (id) => {
      const g = guides.find((g) => g.id === id); if (!g) return "";
      return `<a class="nav-link${activeId === id ? " active" : ""}" ${activeId === id ? 'aria-current="page"' : ""} href="#${esc(id)}"><span class="nav-icon" aria-hidden="true">${esc(guideIcons[id])}</span><span>${esc(g.title)}</span></a>`;
    };
    const groupNav = (id) => {
      const group = data.groups.find((g) => g[0] === id);
      const endpoints = matches.filter((e) => e.group === id); if (!endpoints.length) return "";
      const expanded = Boolean(query) || expandedGroups.has(id) || endpoints.some((e) => e.id === activeId);
      return `<details class="nav-group" data-group="${esc(id)}" ${expanded ? "open" : ""}><summary><span>${esc(group[1])}</span><span class="nav-count">${endpoints.length}</span></summary><div class="nav-children">${endpoints.map((e) => `<a class="nav-link${e.id === activeId ? " active" : ""}" ${e.id === activeId ? 'aria-current="page"' : ""} href="#${esc(e.id)}"><span class="nav-method ${esc(e.method)}">${esc(e.method)}</span><span>${esc(e.title)}</span></a>`).join("")}</div></details>`;
    };
    const sections = navigationSections;
    const html = sections.map((section) => {
      const body = (section.guides || []).map(guideLink).join("") + (section.groups || []).map(groupNav).join("");
      return body ? `<section class="nav-section"><h2 class="nav-label">${esc(section.title)}</h2>${body}</section>` : "";
    }).join("");
    return { html: html || '<p class="loading">没有找到相关内容。试试“查名”“短信”或接口路径。</p>', count: matches.length, guides: guides.length };
  }

  function renderNavigation() {
    if (!lastNavWasSearch) $("navigation").querySelectorAll(".nav-group").forEach((group) => {
      if (group.open) expandedGroups.add(group.dataset.group); else expandedGroups.delete(group.dataset.group);
    });
    const query = $("docsSearch").value.trim().toLowerCase();
    const content = navigationContent(query);
    $("searchSummary").textContent = query ? `找到 ${content.count} 个平台接口 · ${content.guides} 篇说明` : `${data.endpoints.length} 个接口 · ${data.groups.length} 个功能模块`;
    $("clearSearch").hidden = !query;
    $("navigation").innerHTML = content.html;
    lastNavWasSearch = Boolean(query);
  }

  function footer() {
    return `<footer class="article-footer">接口基线：${esc(data.baseline)} · ${esc(data.status)} · ${esc(data.updatedAt)}<br/>结构参考 <a href="https://open.feishu.cn/document/server-docs/docs/drive-v1/file/get" target="_blank" rel="noopener noreferrer">飞书开放平台接口文档 ↗</a>，契约以本平台实际代码为准。</footer>`;
  }

  function section(id, title, body) { return `<section><h2 id="${esc(id)}">${esc(title)}</h2>${body}</section>`; }
  function breadcrumb(name) { return `<div class="breadcrumb"><a href="#overview">开发者文档</a><span>/</span><span>${esc(name)}</span></div>`; }

  function guidePage(g) {
    let html = `${breadcrumb(g.title)}${g.eyebrow ? `<p class="eyebrow">${esc(g.eyebrow)}</p>` : ""}<h1>${esc(g.intro)}</h1><p class="intro">${g.id === "overview" ? "短信接码、支付宝查名字、小红书自动登录、快手录入、小红书一键发布，各业务独立查阅。" : esc(g.title)}</p>`;
    if (g.id === "overview") {
      html += `<div class="metrics-line"><div><strong>${data.endpoints.length}</strong><span>平台接口</span></div><div><strong>${data.groups.length}</strong><span>功能模块</span></div><div><strong>Bearer</strong><span>登录认证</span></div></div>`;
      html += section("getting-started", "调用顺序", '<p>登录获取令牌 → 获取可用设备 → 提交业务任务 → 按原任务ID查询结果。</p><a href="#authentication">查看认证与登录 →</a>');
      html += section("platform-modules", "平台功能", `<div class="feature-links">${data.groups.map(([id, title]) => { const endpoints = data.endpoints.filter((e) => e.group === id); return `<a class="feature-link" href="#${esc((id === "user" ? endpoints.find((e) => e.id === "get-api-v1-user-devices") : endpoints[0]).id)}"><span><b>${esc(title)}</b><small>${endpoints.length} 个接口</small></span><span class="arrow" aria-hidden="true">↗</span></a>`; }).join("")}</div>`);
      html += section("scope", "文档范围与版本", g.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("") + '<p><a href="./openapi.json" download="phone-cloud-platform-openapi.json">下载平台 OpenAPI 3.1 ↗</a> · <a href="./api-reference.json" download="phone-cloud-platform-api-reference.json">下载平台接口参考 JSON ↗</a></p>');
    } else {
      html += g.paragraphs.map((p, i) => section(`guide-part-${i}`, g.id === "lookup-flow" ? ["选择设备与创建会话", "提交号码与顺序队列", "保存查询 ID 并取结果", "拼图与自动人工交接", "首次准备账户遇到拼图", "普通故障恢复", "账户限制与冷却", "结束与释放设备"][i] : (i === 0 ? "使用说明" : `说明 ${i + 1}`), `<p>${esc(p)}</p>`)).join("");
      if (g.code) html += section("code-example", g.id === "authentication" ? "Node.js 调用示例" : "Node.js 调用示例", codePanel(g.code, "Node.js · 服务端执行"));
      if (g.id === "models") html += Object.entries(data.models).map(([name, fields]) => section(`model-${name}`, name, fieldTable(fields))).join("");
      if (g.id === "errors") html += section("error-reference", "公共错误参考", `<div class="table-wrap"><table><thead><tr><th>HTTP</th><th>error</th><th>处理方式</th></tr></thead><tbody>${data.commonErrors.map(([status, error, action]) => `<tr><td>${esc(status)}</td><td><code>${esc(error)}</code></td><td>${esc(action)}</td></tr>`).join("")}</tbody></table></div>`);
      if (g.id === "websockets") html += data.websockets.map((w, i) => section(`channel-${i}`, w.path, `<p><strong>认证：</strong>${esc(w.auth)}</p><p>${esc(w.description)}</p>`)).join("");
    }
    return html + footer();
  }

  function bodyExample(e) {
    if (e.example) return e.example;
    return Object.fromEntries(e.parameters.filter((p) => p.location === "body" && p.required).map((p) => [p.name, exampleValues[p.name] ?? (p.type === "boolean" ? true : /integer|number/.test(p.type) ? 1 : p.type.endsWith("[]") ? [] : p.type === "object" ? {} : `<${p.name}>`)]));
  }

  function exampleForType(type, name, depth = 0) {
    const t = type.replace(/\|null$/, "");
    if (t === "OpenLookupSession") return { sessionId: "session-demo", deviceId: "adb:SERIAL-DEMO", status: "starting", pending: true, queuedCount: 0, resultCount: 0, resultsTruncated: false, successfulCount: 0, currentAccount: "", results: [], queueState: { status: "running" }, humanAction: { required: false }, error: "", createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", endedAt: null };
    if (t === "OpenLookupResult") return { queryId: "query-demo", clientReference: "demo-order-0001", queuePosition: null, phoneNumber: "138****0000", status: "succeeded", stage: "查询完成", maskedName: "**某", nameTailCharacter: "某", accountSwitched: false, accountSwitchReason: "", accountSwitchCount: 0, reason: "", error: "", createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z" };
    if (t.endsWith("[]")) return depth > 2 ? [] : [exampleForType(t.slice(0, -2), name, depth + 1)];
    if (data.models[t] && depth < 3) return Object.fromEntries(data.models[t].map((f) => [f.name, exampleForType(f.type, f.name, depth + 1)]));
    if (t === "boolean") return ["ok", "available", "listed", "adbOnline", "enabled"].includes(name);
    if (/integer|number/.test(t)) return name === "queuePosition" ? null : 0;
    if (t === "object") return {};
    if (name === "phoneNumber") return "138****0000";
    if (name === "status") return "queued";
    if (name === "role") return "user";
    if (name === "maskedName" || name === "nameTailCharacter") return "";
    if (name === "queueState") return { status: "idle" };
    if (/At$|Until$/.test(name)) return type.includes("null") ? null : "2026-10-10T00:00:00.000Z";
    return exampleValues[name] ?? "";
  }

  function responseFields(e) {
    return e.response.split(",").map((part) => { const [name, type] = part.split(":"); return { name, type, description: data.models[type?.replace(/\[\]|\|null/g, "")] ? `参见 ${type} 数据模型` : ({ ok: "受理成功标记；业务完成需读取任务状态", queryId: "稳定查询ID；请持久保存", idempotent: "仅重放时返回", ignored: "仅忽略迟到或重复状态时返回", binary: "文件原始字节；非JSON", token: "本次返回的完整凭据，妥善保存", total: "筛选后或集合总数", limit: "实际分页条数", offset: "实际偏移", capacity: "仅容量分支返回 {running,max}", accountCooldown: "仅已持久化限制事件的ACK返回", accepted: "只读观察是否受理，非恢复完成", probes: "当前可用只读观察任务", payload: "对应type的执行载荷", actor: "当前操作者名称" }[name] || "当前接口的业务返回对象；类型专属扩展字段见说明") }; });
  }

  function requestExample(e, language) {
    const path = e.path.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(exampleValues[name] || `${name}-demo`));
    const json = JSON.stringify(bodyExample(e), null, 2);
    const body = ["POST", "PUT", "PATCH"].includes(e.method) && !e.bodyFormat ? json : "";
    if (language === "HTTP") return `${e.method} ${path} HTTP/1.1\nHost: cloud.example.com\n${e.auth === "hmac" ? "X-Client-Id: <CLIENT_ID>\nX-Timestamp: <UNIX_MILLISECONDS>\nX-Nonce: <NEW_NONCE>\nX-Signature: <COMPUTED_HMAC_HEX>\n" : !["public", "media-hook"].includes(e.auth) ? "Authorization: Bearer <TOKEN>\n" : ""}${e.idempotency ? "Idempotency-Key: demo-business-0001\n" : ""}${body || e.bodyFormat ? `Content-Type: ${e.bodyFormat || "application/json"}\n\n${body || "<RAW_APK_BYTES>"}` : ""}`;
    if (e.bodyFormat) return "// 本接口发送原始 APK 二进制。参见 HTTP 示例；使用文件读取字节后上传，不能 JSON.stringify。";
    if (language === "Python") {
      return `import os, json, time, uuid, hashlib, hmac, urllib.request\n\nbase = os.environ["PHONE_CLOUD_BASE_URL"]\npath = ${JSON.stringify(path)}\nmethod = ${JSON.stringify(e.method)}\nraw = ${body ? `json.dumps(json.loads(${JSON.stringify(JSON.stringify(bodyExample(e)))}), ensure_ascii=False, separators=(",", ":")).encode("utf-8")` : 'b""'}\nheaders = {"Content-Type": "application/json"}\n${e.auth === "hmac" ? 'timestamp = str(int(time.time() * 1000))\nnonce = str(uuid.uuid4())\ncanonical = "\\n".join([method, path, timestamp, nonce, hashlib.sha256(raw).hexdigest()])\nheaders.update({\n    "X-Client-Id": os.environ["PHONE_CLOUD_CLIENT_ID"],\n    "X-Timestamp": timestamp, "X-Nonce": nonce,\n    "X-Signature": hmac.new(os.environ["PHONE_CLOUD_SECRET"].encode(), canonical.encode(), hashlib.sha256).hexdigest()\n})\n' : !["public", "media-hook"].includes(e.auth) ? 'headers["Authorization"] = "Bearer " + os.environ["PHONE_CLOUD_TOKEN"]\n' : ""}${e.idempotency ? 'headers["Idempotency-Key"] = "demo-business-0001" # 重试保持此值\n' : ""}req = urllib.request.Request(base.rstrip("/") + path, data=${body ? "raw" : "None"}, headers=headers, method=method)\n# HTTPError携带error响应；网络超时后按原ID/幂等键确认，勿重复业务提交\nwith urllib.request.urlopen(req, timeout=20) as response:\n    ${e.binary ? 'content = response.read() # 原始文件字节' : 'result = json.load(response)\n    print(result)'}\n`;
    }
    return `${e.auth === "hmac" ? 'import { signedHeaders } from "./sign.mjs"; // 认证与签名章节\n' : ""}const base = process.env.PHONE_CLOUD_BASE_URL;\nconst path = ${JSON.stringify(path)};\nconst method = ${JSON.stringify(e.method)};\nconst rawBody = ${body ? `JSON.stringify(${json})` : '""'};\nconst headers = ${e.auth === "hmac" ? 'signedHeaders(process.env.PHONE_CLOUD_SECRET, process.env.PHONE_CLOUD_CLIENT_ID, method, path, rawBody)' : ["public", "media-hook"].includes(e.auth) ? '{ "Content-Type": "application/json" }' : '{ "Authorization": `Bearer ${process.env.PHONE_CLOUD_TOKEN}`, "Content-Type": "application/json" }'};\n${e.idempotency ? 'headers["Idempotency-Key"] = "demo-business-0001"; // 同业务重试保持此值\n' : ""}const response = await fetch(new URL(path, base), {\n  method, headers, ${body ? 'body: rawBody, ' : ""}signal: AbortSignal.timeout(20000)\n});\n${e.binary ? 'if (!response.ok) throw new Error(`HTTP ${response.status}`);\nconst bytes = await response.arrayBuffer();' : 'const result = await response.json();\nif (!response.ok) throw Object.assign(new Error(result.error), { status: response.status, result });\nconsole.log(result); // 受理后按返回的ID轮询业务结果'}`;
  }

  function endpointPage(e) {
    const category = data.groups.find(([id]) => id === e.group)?.[1] || "接口参考";
    let html = `${breadcrumb(category)}<p class="eyebrow">API REFERENCE</p><h1>${esc(e.title)}</h1><p class="intro">${esc(e.description)}</p><div class="api-meta"><span class="tag auth">${esc(authNames[e.auth] || e.auth)}</span>${e.scope ? `<span class="tag">scope: ${esc(e.scope)}</span>` : ""}<span class="tag">成功 HTTP ${e.successCodes.join(" / ")}</span>${e.idempotency ? `<span class="tag">幂等键${e.idempotency === "required" ? "必填" : "可选 · 旧语义"}</span>` : ""}${e.deprecated ? '<span class="tag deprecated">兼容接口 · 新接入请用开放接口</span>' : ""}</div><div class="endpoint-url"><span class="method ${e.method}">${e.method}</span><code>${esc(e.path)}</code><button class="copy-small" data-copy-text="${esc(e.path)}" aria-label="复制接口路径">复制</button></div>`;
    html += section("request", "请求", `<p>基础地址：管理员交付的 HTTPS 根地址，例如 <code>https://cloud.example.com</code>。接口权限沿用现有服务端，不因文档入口而扩大。</p>${e.auth === "hmac" ? '<div class="notice">每次携带 <code>X-Client-Id</code>、<code>X-Timestamp</code>（毫秒）、<code>X-Nonce</code>、<code>X-Signature</code>。<a href="#authentication">查看签名算法与示例 →</a></div>' : `<p>认证：${esc(authNames[e.auth] || e.auth)}。</p>`}${e.idempotency ? `<p><code>Idempotency-Key</code>：${e.idempotency === "required" ? "必填，同业务相同参数重试使用同键，参数不同返回409。" : "可选。同客户端同键直接返回旧请求，当前实现不做参数冲突比较；调用方应确保同键只用于同一业务。"}</p>` : ""}${e.bodyFormat ? `<p>请求体：<code>${esc(e.bodyFormat)}</code> 原始字节。</p>` : e.method === "POST" || e.method === "PUT" ? '<p>请求体：<code>application/json</code>。没有字段时也发送 <code>{}</code>。</p>' : ""}`);
    for (const [location, title] of [["path", "路径参数"], ["query", "查询参数"], ["body", "请求体字段"]]) {
      const params = e.parameters.filter((p) => p.location === location);
      if (params.length || location === "body" && ["POST", "PUT"].includes(e.method) && !e.bodyFormat) html += section(`params-${location}`, title, fieldTable(params, true));
    }
    html += section("request-example", "请求示例", `<p>仅为后端接入示例，不会在此页面执行。替换示例资源ID；图片/密码/令牌占位符需替换为你有权使用的真实输入。</p><div class="code-panel" id="requestCodePanel"><div class="code-toolbar" role="tablist" aria-label="示例语言">${["Node.js", "Python", "HTTP"].map((l, i) => `<button role="tab" aria-selected="${i === 0}" data-language="${l}">${l}</button>`).join("")}<button class="copy-small" data-copy-code>复制代码</button></div><pre role="tabpanel" aria-label="请求代码"><code id="requestCode">${esc(requestExample(e, "Node.js"))}</code></pre></div>`);
    const fields = responseFields(e);
    html += section("response", "响应", `<p>HTTP ${e.successCodes.join(" / ")}；${e.binary ? "返回原始文件字节，不使用JSON包装。" : "以下为成功响应字段；条件分支字段可以省略。幂等重放可能增加 idempotent=true。"}</p>${fieldTable(fields)}`);
    const models = [...new Set(fields.map((f) => f.type.replace(/\[\]|\|null/g, "")).filter((name) => data.models[name]))];
    html += models.map((name) => `<details class="model-details" open><summary>${esc(name)} · 展开字段</summary>${fieldTable(data.models[name])}<p><a href="#models">查看所有嵌套模型 →</a></p></details>`).join("");
    if (!e.binary) {
      const example = Object.fromEntries(fields.filter((f) => !["ignored", "accountCooldown", "capacity", "idempotent"].includes(f.name)).map((f) => [f.name, exampleForType(f.type, f.name)]));
      if (example.session?.humanAction) example.session.humanAction = { required: false };
      if (example.session?.queueState) example.session.queueState = { status: example.session.pending ? "running" : "idle" };
      if (example.session && e.path.endsWith("/queries")) { example.session.queuedCount = 1; example.session.resultCount = 1; example.session.results = [{ ...exampleForType("OpenLookupResult", ""), status: "queued", stage: "队列等待中", queuePosition: 1, maskedName: "", nameTailCharacter: "" }]; }
      if (example.session && e.method === "POST" && e.path.endsWith("/sessions")) example.session.status = "starting";
      if (example.session && e.method === "POST" && e.path.endsWith("/end")) example.session.status = "stopping";
      html += section("response-example", "响应示例", codePanel(JSON.stringify(example, null, 2), "JSON · 结构示例，非实时数据"));
    }
    html += section("endpoint-errors", "错误处理", e.errors.length ? `<p>路由直接返回的错误如下。认证、参数规范化、执行器和存储还可能产生公共或扩展错误。</p><div class="table-wrap"><table><thead><tr><th>HTTP</th><th>error</th><th>处理方式</th></tr></thead><tbody>${e.errors.map((error) => `<tr><td>${esc(e.errorStatuses?.[error]?.join(" / ") || "扩展")}</td><td><code>${esc(error)}</code></td><td>${esc(data.commonErrors.find(([, codes]) => codes.split(" / ").includes(error))?.[2] || "核对请求字段、资源归属和当前状态；任务超时先查询原ID，按错误原因修正后处理。")}</td></tr>`).join("")}</tbody></table></div>` : '<p>本路由没有直接声明固定 error 字符串；认证、参数规范化、执行器或存储仍可能返回公共/扩展错误。</p>');
    html += '<p><a href="#errors">查看公共错误码、限流和重试策略 →</a></p>';
    return html + footer();
  }

  function setMenu(open) { const mobile = window.matchMedia("(max-width: 800px)").matches; open = Boolean(open && mobile); document.body.classList.toggle("menu-open", open); $("menuButton").setAttribute("aria-expanded", String(open)); $("menuBackdrop").hidden = !open; $("sidebar").inert = mobile && !open; }
  function renderPage() {
    if (!data) return;
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)) || "overview"; } catch { id = "overview"; }
    const [pageId, sectionId] = id.split("~");
    id = pageId;
    if (activeId === id && sectionId && $(sectionId) && $("article").contains($(sectionId))) { $(sectionId).scrollIntoView(); return; }
    const guide = data.guides.find((g) => g.id === id);
    const endpoint = data.endpoints.find((e) => e.id === id);
    activeId = guide || endpoint ? id : "overview";
    $("article").innerHTML = guide ? guidePage(guide) : endpoint ? endpointPage(endpoint) : guidePage(data.guides[0]);
    document.title = `${guide?.title || endpoint?.title || "接入概览"} · Phone Cloud API`;
    $("outline").innerHTML = [...$("article").querySelectorAll("h2[id]")].map((h) => `<a href="#${esc(activeId)}~${esc(h.id)}">${esc(h.textContent)}</a>`).join("");
    renderNavigation(); setMenu(false); window.scrollTo(0, 0);
    if (sectionId && $(sectionId) && $("article").contains($(sectionId))) $(sectionId).scrollIntoView();
  }

  async function copy(value) {
    let message = "已复制";
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const textarea = document.createElement("textarea"); textarea.value = value; textarea.style.position = "fixed"; textarea.style.opacity = "0"; document.body.append(textarea); textarea.select();
        const ok = document.execCommand("copy"); textarea.remove(); if (!ok) throw new Error("copy_failed");
      }
    } catch { message = "复制未成功，请手动选择代码复制"; }
    $("copyStatus").textContent = message; $("copyStatus").hidden = false;
    clearTimeout(copyTimer); copyTimer = setTimeout(() => { $("copyStatus").hidden = true; }, 2600);
  }

  async function load() {
    try {
      const response = await fetch("./api-reference.json", { cache: "no-store" });
      if (!response.ok) throw new Error("reference_unavailable");
      data = await response.json();
      if (!Array.isArray(data.endpoints) || !Array.isArray(data.guides)) throw new Error("invalid_reference");
      renderPage();
    } catch {
      $("article").innerHTML = '<div class="error-box"><h1>文档暂时无法加载</h1><p>请确认页面和 api-reference.json 来自同一版本，再重试。</p><button id="retryDocs">重新加载</button></div>';
      $("retryDocs").addEventListener("click", load); $("navigation").textContent = "文档数据加载失败";
    }
  }
  $("docsSearch").addEventListener("input", () => { if (data) renderNavigation(); });
  $("clearSearch").addEventListener("click", () => { $("docsSearch").value = ""; renderNavigation(); $("docsSearch").focus(); });
  $("menuButton").addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
  $("menuBackdrop").addEventListener("click", () => setMenu(false));
  window.addEventListener("hashchange", renderPage);
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setMenu(true); $("docsSearch").focus(); }
    if (event.key === "Escape") { setMenu(false); $("menuButton").focus(); }
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest(".skip-link")) { event.preventDefault(); $("article").focus(); return; }
    const button = event.target.closest("button");
    if (button?.hasAttribute("data-copy-text")) copy(button.dataset.copyText);
    if (button?.hasAttribute("data-copy-code")) copy(button.closest(".code-panel").querySelector("pre code").textContent);
    if (button?.hasAttribute("data-language")) {
      const endpoint = data.endpoints.find((e) => e.id === activeId); if (!endpoint) return;
      $("requestCode").textContent = requestExample(endpoint, button.dataset.language);
      button.closest(".code-toolbar").querySelectorAll("[data-language]").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
    }
  });
  window.addEventListener("resize", () => setMenu(document.body.classList.contains("menu-open")));
  load();
})();
