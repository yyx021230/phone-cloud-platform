# 第三方短信验证码接口（小红书 / 抖音）

更新日期：2026-09-08。抖音适配是**本地已实现、隔离测试通过、尚未部署及实机验收**的候选；不要仅凭本文认定线上已经支持。此接口仅接收已授权手机的短信，不会触发抖音/小红书发码，也不会代替业务系统完成登录；小红书扫码接口不因此支持抖音扫码。

本接口用于第三方平台请求验证码，不使用网页登录态。调用方必须配置独立的 `clientId/secret` 并对每个请求签名。

旧 `/api/v1/third-party/sms-orders` 仅作为兼容接口保留。新平台、新客户、新渠道一律接入本签名接口。

## 接口地址与调用顺序

`BASE_URL` 是管理员交付的云手机平台 HTTP(S) 根地址，不是 Windows Agent 地址，不包含 `/api/v1`。本仓库不保存真实生产 IP；实际接入地址单独在私有交接文档中提供。下面的 `https://phone-cloud.example.com` **只是占位符，必须替换**；建议使用 HTTPS，明文 HTTP 只能在明确确认的受信通道内使用。

| 用途 | 方法 | 完整 URL 模板 |
|---|---|---|
| 订阅一次验证码 | POST | `https://phone-cloud.example.com/api/v1/open/sms-code-requests` |
| 查询结果 | GET | `https://phone-cloud.example.com/api/v1/open/sms-code-requests/{requestId}` |
| 取消等待 | POST | `https://phone-cloud.example.com/api/v1/open/sms-code-requests/{requestId}/cancel` |

调用顺序：取得独立 `clientId/secret` 和已登记手机号 → 签名创建请求 → 调用方在抖音/小红书触发一次发码 → 每 3–5 秒签名查询 → `received` 时读取 `request.code`，终态停止轮询。新一轮发码新建订单；网络重试沿用原幂等键，但换新时间戳、Nonce 和签名。

## 平台参数与识别范围

| 场景 | `platform` 推荐值 | 兼容别名 |
|---|---|---|
| 抖音登录验证码 | `抖音` | `douyin`，大小写不敏感 |
| 小红书验证码 | `小红书` | `xhs`、`xiaohongshu`、`redbook` |

- 服务端将抖音别名归一为 `抖音`，响应中的 `request.platform` 也是 `抖音`。
- 标准短信支持正文中的完整 `【抖音】` / `[抖音]` / `[Douyin]` 品牌标记（前置或后置）；默认短信应用的缩短通知支持标题恰好为 `抖音` / `Douyin` 或相应带括号标记。受信设备上传的明确 `platform` 标签继续兼容。
- 不会因为正文随便提到“抖音”，或来源是 `字节跳动`、`TikTok`、`今日头条`，就猜测它属于抖音。新模板缺乏明确来源时保持等待，需经脱敏样本核对后另行适配。
- `platform` 是订单匹配条件，不是备注。不要省略；Open API 省略时使用 `第三方平台`，不是“任意平台”，也不会自动订阅所有验证码。
- 匹配同时要求时间窗、设备、号码及安全 SIM 规则成立，并存在有效的 4–8 位纯数字验证码。普通通知、掩码、其他平台短信、长数字截断、字母数字混合码不得消费订单。
- 小红书与抖音即使恰好收到相同数字，也分别保留，不跨平台去重；同平台的通知与短信库记录仍可补全合并。
- 保留现有双源采集和定向探针：创建后立即调度目标设备；查询按设备约 2.5 秒节流补采，服务端约 10 秒维护兜底。同设备正在投屏/前台任务时既有避让规则不变。没有修改 Windows 采集频率、手机 APK 或投屏。
- 同设备不同 SIM 均在等同平台验证码且通知缺少可信卡槽时不猜归属；调用方应串行处理同一实体手机的登录收码。

## 服务端配置

在 `.env` 中配置：

```env
THIRD_PARTY_API_CLIENTS=demo-client:replace-with-long-random-secret
```

多个客户端用逗号分隔：

```env
THIRD_PARTY_API_CLIENTS=client-a:secret-a-32chars,client-b:secret-b-32chars
```

## 签名请求头

每个请求必须带：

```text
X-Client-Id: demo-client
X-Timestamp: 1782280063148
X-Nonce: nonce-abc123456
X-Signature: hex(hmac_sha256)
Idempotency-Key: 可选，创建请求时建议传
```

`X-Timestamp` 是毫秒时间戳。默认允许 5 分钟误差。

`X-Nonce` 每次请求都必须更新，长度 8–120，只允许 `A-Z a-z 0-9 . _ : -`。`X-Signature` 是小写十六进制。短信 HMAC 凭据不是网页用户 Token；不要将 secret 放在用户浏览器前端或共享文档中。

## 签名原文

```text
METHOD + "\n" +
PATH + "\n" +
TIMESTAMP + "\n" +
NONCE + "\n" +
SHA256(rawBody)
```

示例：

```text
POST
/api/v1/open/sms-code-requests
1782280063148
nonce-abc123456
<body_sha256_hex>
```

然后：

```text
X-Signature = HMAC_SHA256(secret, canonical_text)
```

`METHOD` 必须大写，`PATH` 只签 URL pathname，不包含域名或查询串。GET 的 `rawBody` 为零字节空串（不是 `{}`）；POST 对最终实际发送的 UTF-8 JSON 字符串签名，签名后不能重新排版 JSON。

## 创建验证码请求

```http
POST /api/v1/open/sms-code-requests
Content-Type: application/json
X-Client-Id: demo-client
X-Timestamp: ...
X-Nonce: ...
X-Signature: ...
Idempotency-Key: order-123

{
  "phoneNumber": "13800000005",
  "platform": "抖音"
}
```

以上手机号是虚构示例，必须替换为有权使用且已在平台登记的实际 SIM 号码。小红书只需将 `platform` 改为 `小红书`，地址与鉴权相同。

| 字段 | 类型 | 说明 |
|---|---|---|
| `phoneNumber` | string | 推荐传已登记手机号；与 `deviceId` 至少提供一个 |
| `deviceId` | string | 平台设备 ID，不是数字显示编号；同时传手机号时须属于同一设备 |
| `slotIndex` | number | 可选，0 为 SIM1，1 为 SIM2；不是小红书应用槽位 |
| `subscriptionId` | number | 可选，实际 Android 订阅 ID，不能按槽位猜测 |
| `platform` | string | 显式传 `抖音` 或 `小红书` |

按设备示例：`{"deviceId":"adb:DEMO_SERIAL","slotIndex":0,"platform":"抖音"}`。有效期由服务端 `SMS_ORDER_TTL_SECONDS` 控制，默认 300 秒；请求不能自定义 `startedAt` 或有效期，以响应 `expiresAt` 为准。只有手机号却没有登记设备时不保证能建立定向采集，接入前必须核对映射。

首次创建 HTTP 201；同 client 相同幂等键复用已有请求时 HTTP 200，额外返回 `idempotent: true`。响应节选：

```json
{
  "ok": true,
  "request": {
    "requestId": "uuid",
    "status": "waiting",
    "code": "",
    "platform": "抖音",
    "phoneNumber": "138****0005",
    "deviceId": "adb:DEMO_SERIAL",
    "expiresAt": "2026-09-08T01:05:00.000Z"
  }
}
```

## 查询验证码请求

```http
GET /api/v1/open/sms-code-requests/{requestId}
X-Client-Id: demo-client
X-Timestamp: ...
X-Nonce: ...
X-Signature: ...
```

状态：

- `waiting`
- `received`
- `expired`
- `cancelled`
- `failed`

查询返回 HTTP 200，最外层是 `request`，不是 `order`。收到后的响应节选：

```json
{
  "request": {
    "requestId": "uuid",
    "status": "received",
    "platform": "抖音",
    "code": "123456",
    "sender": "10600000000",
    "phoneNumber": "138****0005",
    "deviceId": "adb:DEMO_SERIAL",
    "matchedAt": "2026-09-08T01:00:20.000Z",
    "matchStrategy": "exact_sim"
  }
}
```

`waiting` 继续轮询；`received`、`expired`、`cancelled`、`failed` 均停止。只有 `received` 且 `code` 有效才能提交业务系统。`matchStrategy` 可能为 `exact_sim`、`unique_device_stale_sim` 或 `unique_device_unknown_sim`；后两者只在唯一逻辑目标可证明时使用。

## 可见范围

- 本 Open API 的第三方调用方只能按本 client 的 requestId 查询；其他 client 的请求按不存在处理。用户工作台短信库有独立的已上架设备权限规则，不适用这里的订单可见性描述。
- 返回手机号和正文按现有规则脱敏，但验证码、发送方和正文片段仍属敏感信息，不要记录完整响应或转发公共日志。
- 管理员完整查询短信库会写审计日志。

## 稳定错误码

| HTTP | `error` | 处理 |
|---|---|---|
| 401 | `open_api_auth_required` / `invalid_open_api_client` | 补齐或核对独立凭据 |
| 401 | `open_api_timestamp_expired` | 校准毫秒时间戳 |
| 401 | `invalid_open_api_nonce` / `open_api_nonce_replayed` | 使用合法且全新的 Nonce |
| 401 | `invalid_open_api_signature` | 核对 pathname、空 GET body 和实际 POST 字节 |
| 400 | `phoneNumber or deviceId is required` | 补齐目标 |
| 404 | `device_not_found` | 核对平台设备 ID |
| 409 | `device_not_published` / `device_not_available` | 设备必须上架且可用 |
| 404 | `sms_request_not_found` | 请求不存在或不属于当前 client |
| 409 | `sms_request_not_cancellable` | 已非 waiting，不要继续取消 |

错误响应形如 `{"error":"invalid_open_api_signature"}`。不要对 401 无限重试；请求超时/5xx 可以有界退避，同一次创建保留幂等键。

## 取消验证码请求

```http
POST /api/v1/open/sms-code-requests/{requestId}/cancel
Content-Type: application/json
X-Client-Id: demo-client
X-Timestamp: ...
X-Nonce: ...
X-Signature: ...

{}
```

成功 HTTP 200：`{"ok":true,"request":{"status":"cancelled",...}}`。仅在放弃等待时取消；不会撤回短信或撤销业务系统已完成的登录。

## 防重放和幂等

- 同一个 `X-Nonce` 在有效窗口内只能使用一次。
- 创建请求建议传 `Idempotency-Key`，重复提交会返回同一个 request。
- 签名失败、时间戳过期、nonce 重放都会返回 401。
- 服务端当前不会对同幂等键的请求体做差异校验：换手机号、换平台或新一次收码必须换键，否则可能拿到旧订单；没有 `idempotency_conflict` 错误。查询和取消也必须使用新 Nonce。

## Node.js 签名调用示例

以下是供接入方自行调用的示例，不会自动发码。Node.js 18+；`PHONE_CLOUD_BASE_URL`、`PHONE_CLOUD_CLIENT_ID`、`PHONE_CLOUD_CLIENT_SECRET` 从自己的私有运行环境读取，不要打印请求头。

```js
import { createHash, createHmac, randomUUID } from "node:crypto";

async function smsRequest(method, pathname, input, idempotencyKey) {
  const base = new URL(process.env.PHONE_CLOUD_BASE_URL);
  if (base.protocol !== "https:" || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Use your assigned HTTPS root URL");
  }
  if (!/^\/api\/v1\/open\/sms-code-requests(?:\/[A-Za-z0-9._:-]+(?:\/cancel)?)?$/.test(pathname)) {
    throw new Error("Invalid SMS API pathname");
  }
  if (!["GET", "POST"].includes(method) || (method === "GET" && input !== undefined)) {
    throw new Error("Invalid method/body");
  }
  const clientId = process.env.PHONE_CLOUD_CLIENT_ID;
  const secret = process.env.PHONE_CLOUD_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error("Missing assigned credentials");
  const raw = method === "GET" ? "" : JSON.stringify(input ?? {});
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const bodyHash = createHash("sha256").update(raw, "utf8").digest("hex");
  const canonical = [method, pathname, timestamp, nonce, bodyHash].join("\n");
  const headers = {
    "Content-Type": "application/json", "X-Client-Id": clientId,
    "X-Timestamp": timestamp, "X-Nonce": nonce,
    "X-Signature": createHmac("sha256", secret).update(canonical, "utf8").digest("hex")
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(new URL(pathname, base), {
    method, headers, ...(method === "POST" ? { body: raw } : {}),
    redirect: "error", signal: AbortSignal.timeout(15000)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`SMS API ${res.status}: ${data.error || "request_failed"}`);
  return data.request;
}

// 单独执行创建，获得 requestId 后再由业务系统触发发码：
// const waiting = await smsRequest("POST", "/api/v1/open/sms-code-requests",
//   { phoneNumber: YOUR_REGISTERED_PHONE, platform: "抖音" }, YOUR_NEW_REQUEST_KEY);
// 每 3–5 秒查询（不要直接无限循环）：
// const result = await smsRequest("GET", `/api/v1/open/sms-code-requests/${waiting.requestId}`);
// 放弃等待才执行：
// await smsRequest("POST", `/api/v1/open/sms-code-requests/${waiting.requestId}/cancel`, {});
```

## 验证与发布边界

本地用纯合成短信运行 `node --test server/sms-platform.test.mjs server/sms-order-matcher.test.mjs server/sms-open-api.test.mjs`。隔离 API 测试只复制代码到临时目录、使用临时凭据/JSON 库并绑定 `127.0.0.1`，不读取项目 `.env`，不连接数据库、Windows 或手机。覆盖抖音建单/别名、Provider/通知/事件入库命中、小红书不串码、跨平台同码不合并、同平台双源补全、普通通知继续等待、定向探针去重、幂等、鉴权、防重放、跨 client 隔离及取消终态。

发布后仍需在一台经授权的空闲手机上验证真实抖音短信模板及端到端耗时；手机/OEM 不暴露正文、通知被清除、发码方未送达等问题不由新增识别规则解决。不宣称所有抖音模板或所有机型均已实测。
