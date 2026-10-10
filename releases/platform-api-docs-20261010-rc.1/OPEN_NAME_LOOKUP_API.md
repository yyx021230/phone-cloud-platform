# 支付宝查名字 Open API 接入规范

| 项目 | 值 |
|---|---|
| API 版本 | `v1` |
| 文档版本 | `1.1` |
| 更新日期 | 2026-09-10 |
| 数据格式 | UTF-8 JSON |
| 鉴权方式 | HMAC-SHA256 |
| 生产状态 | 已启用，按客户端和设备白名单授权 |

接口已随 `20260909-open-name-queue-v2` 部署生产，并仅为已配置的受控客户端和精确设备白名单启用；未配置环境仍默认关闭。本文是外部接入契约，实际接入地址、`clientId`、密钥和可用设备由平台管理员单独交付，不写入本文或客户端代码。实际可用设备以签名调用设备列表的响应为准。

本接口把一次设备占用建模为长会话。调用方必须确保每个号码均已取得合法授权，并为每次查询提供可审计的 `consentReference`。平台不会自动破解拼图，也不会通过 Open API 下发实时控屏凭据；需要人工时，由管理员为该客户端映射的专用平台用户登录网页控制同一手机。

**2026-10-08 本地候选，未部署**：查询后的拼图仍由任务发起者或管理员人工控屏完成；新版 Agent 只读检测，云端收到两次新鲜的“验证消失且搜索页可用”证据后自动结束对应人工控屏，清空搜索框并重查原号码，沿用原 `queryId/clientReference/consentReference`，完成后继续后续队列。新版无需网页确认按钮，也无需调用方调用 `/resume`，继续轮询原查询即可；读失败、其他应用、设备离线、任务取消或迟到回报均不能触发恢复。检测通道仅限绑定 Windows Agent，不向 HMAC 客户端开放。下文 `/resume` 保留旧版兼容语义，不能与新版自动重查重复提交；本候选不表示生产已支持自动恢复。

**2026-10-10 链路可靠性候选，未部署生产**：首次准备账户遇拼图时保留会话/占用并通知人工；两次只读确认通过后恢复 `start`，不创建虚假号码结果。人工后恢复若发生普通执行故障，原查询返回新增 `needs_recovery`，`humanAction.required=false`、`queueState={status:"paused", reason:"lookup_human_recovery_failed", action:"retry_current_query", queryId:"原查询ID"}`；调用方可以对原 `queryId` 显式调用 `/resume`，沿用该次恢复幂等键，或结束会话。此时重试直接进入搜索路径，不重复核对已验证账户，不发送拼图提醒、不自动派发下一号码。首次账户准备的恢复故障没有查询 ID，由网页“重试账户准备”接续。真实拼图仍自动交接，普通滑块沿用原自动处理；以下新增状态/动作仅适用于本候选，不能假定线上已支持。

不希望自行实现签名和轮询的调用方，可直接使用仓库内无第三方依赖的 [Node.js/Python 客户端](../sdk/open_name_lookup/README.md)。客户端封装 HMAC、幂等键、顺序批量入队以及人工动作/账号耗尽暂停状态。

## 1. 调用路径

`BASE_URL` 是云手机平台 HTTPS 根地址，不包含 `/api/v1`。示例域名只是占位符。

| 顺序 | 用途 | 方法与路径 |
|---|---|---|
| 1 | 查询允许使用的设备 | `GET /api/v1/open/name-lookups/devices` |
| 2 | 创建查名字长会话 | `POST /api/v1/open/name-lookups/sessions` |
| 3 | 查询会话和结果 | `GET /api/v1/open/name-lookups/sessions/{sessionId}` |
| 4 | 连续提交号码进入队列 | `POST /api/v1/open/name-lookups/sessions/{sessionId}/queries` |
| 5 | 按 ID 查询单个号码结果 | `GET /api/v1/open/name-lookups/sessions/{sessionId}/queries/{queryId}` |
| 6 | 人工验证后恢复原号码 | `POST /api/v1/open/name-lookups/sessions/{sessionId}/resume` |
| 7 | 结束并释放设备 | `POST /api/v1/open/name-lookups/sessions/{sessionId}/end` |

推荐顺序：列设备 → 创建会话 → 连续提交多个号码 → 平台按入队顺序单机串行执行 → 轮询会话与结果 → 无论成功或异常都结束会话。

同一会话同一时刻只执行一个查询，但接口允许在 `starting`、`ready`、`querying`、`choosing_account` 和人工处理中继续提交后续号码。新号码立即获得稳定 `queryId` 和 `queuePosition`，不需要等待前一个号码完成。`stopping` 或终态会话不再接收查询。

### 1.1 调用方最小状态机

| 服务端状态 | 调用方动作 |
|---|---|
| `starting` / `ready` / `querying` / `choosing_account` | 可以继续入队并轮询 |
| `humanAction.required=true` | 暂停等待人工拼图；人工结束控屏后按 `resumeAllowed` 决定是否调用 `/resume` |
| `queueState.action=retry_current_query`（候选） | 普通恢复失败；重试返回的原 `queryId` 或结束会话，不把它当作拼图或账号耗尽 |
| `queueState.action=end_session_and_select_another_device` | 当前手机的可用账号耗尽；结束会话并选择另一台可用设备 |
| 查询为 `succeeded` / `not_found` | 保存该 `queryId` 的正常业务终态 |
| 查询为 `failed` / `limit_reached` / `cancelled` | 保存失败终态，按错误策略处置，不把它当成姓名结果 |
| 会话为 `ended` / `failed` / `expired` | 不再提交；需要继续时重新创建会话 |

调用方应以 `queryId` 作为结果主键，以 `clientReference` 关联自身业务单。不得依赖 `results` 数组位置判断号码对应关系。

## 2. 服务端配置

接口默认关闭。管理员先创建一个非管理员专用用户，再在 `.env` 配置：

```env
OPEN_NAME_LOOKUP_API_ENABLED=true
OPEN_NAME_LOOKUP_CLIENTS_JSON=[{"clientId":"partner-a","secret":"replace-with-at-least-32-random-characters","username":"external_lookup","deviceIds":["adb:SERIAL-ONE"]}]
```

每个客户端配置包括：

- `clientId`：3–80 位，只允许字母、数字、`.`、`_`、`-`。
- `secret`：至少 32 个字符的独立随机密钥，不得放在浏览器前端、仓库或日志中。
- `username`：已存在且启用的专用平台普通用户，设备锁归属于该用户；不同 `clientId` 不允许共用同一用户名。该用户本人或平台管理员可在空闲/人工拼图状态进入控屏，管理员不能越过正在查询、自动切号、其他业务锁或已有控屏会话。
- `deviceIds`：精确设备白名单，不能使用通配符。

查名字 Open API 不设置每小时、每日或单会话查询次数配额。调用方可以持续入队；实际执行速度由一台手机一次只运行一个查询的串行模型、每次输入前 3–10 秒随机节流以及上游页面响应共同决定。没有 API 次数配额不代表绕过支付宝自身的账号或设备风控。

生产启用前必须确认 `/readyz` 中 `open_name_lookup_api` 为 `ok`。配置变化需要按现有发布流程加载服务，不允许把真实密钥提交到仓库。

## 3. HMAC 鉴权

每个请求都必须携带：

```text
X-Client-Id: partner-a
X-Timestamp: 1788940800000
X-Nonce: 550e8400-e29b-41d4-a716-446655440000
X-Signature: <lowercase hex HMAC-SHA256>
```

时间戳单位为毫秒，默认允许 5 分钟误差。Nonce 长度 8–120，只允许 `A-Z a-z 0-9 . _ : -`，每次请求都必须重新生成；重复使用返回 `401 open_api_nonce_replayed`。

签名原文：

```text
METHOD + "\n" +
PATH + "\n" +
TIMESTAMP + "\n" +
NONCE + "\n" +
SHA256(rawBody)
```

`METHOD` 必须大写；`PATH` 只含 pathname，不含域名和查询串。GET 的 `rawBody` 是零字节空串。POST 必须对最终发送的 UTF-8 JSON 原文签名，签名后不能再次格式化。

Node.js 签名示例：

```js
import crypto from "node:crypto";

export function sign({ secret, method, path, rawBody = "" }) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const canonical = [method.toUpperCase(), path, timestamp, nonce, bodyHash].join("\n");
  const signature = crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  return { timestamp, nonce, signature };
}
```

创建会话、提交查询和恢复请求还必须带 `Idempotency-Key`。长度与字符集应采用稳定的 UUID 或业务唯一键；网络重试沿用原幂等键，但必须生成新的时间戳、Nonce 和签名。相同幂等键与相同参数返回原对象；参数不同返回 `409 idempotency_conflict`。

所有成功响应和错误响应均为 JSON。POST 请求必须发送 `Content-Type: application/json`；即使请求体为 `{}`，也必须把这两个字节作为签名中的 `rawBody`。客户端时钟应通过 NTP 保持同步。

## 4. 查询设备

```http
GET /api/v1/open/name-lookups/devices
```

```json
{
  "devices": [{
    "deviceId": "adb:SERIAL-ONE",
    "deviceName": "测试手机",
    "available": true,
    "listed": true,
    "adbOnline": true
  }]
}
```

只返回客户端白名单中仍存在的设备。`available=true` 表示当前已上架、ADB 在线且没有冲突锁；最终创建时仍会再次校验。

## 5. 创建会话

```http
POST /api/v1/open/name-lookups/sessions
Idempotency-Key: session-order-000001
Content-Type: application/json

{"deviceId":"adb:SERIAL-ONE"}
```

首次成功返回 `201`，幂等重放返回 `200`。初始 `session.status` 通常是 `starting`；此时即可连续提交号码进入队列，平台会等会话真正 `ready` 后再派发队首查询。

## 6. 提交查询

```http
POST /api/v1/open/name-lookups/sessions/{sessionId}/queries
Idempotency-Key: query-order-000001
Content-Type: application/json

{
  "phoneNumber": "13800000000",
  "clientReference": "order-000001",
  "consentReference": "consent-000001"
}
```

- `phoneNumber`：本次已获授权的中国大陆手机号。
- `clientReference`：调用方业务唯一引用，8–160 位，只允许字母、数字、`.`、`_`、`:`、`-`。
- `consentReference`：调用方保存的授权/同意记录引用，规则同上；平台审计记录该引用但不回传它。

成功入队返回 `202` 和稳定的 `queryId`。调用方可以并发或连续提交，平台按服务端 `queueSequence` 串行派发；不要因为网络超时更换幂等键重复提交同一个号码。

示例：

```json
{
  "ok": true,
  "queryId": "...",
  "session": {
    "status": "querying",
    "pending": true,
    "queuedCount": 2,
    "results": [
      { "queryId": "query-3", "status": "queued", "queuePosition": 2 },
      { "queryId": "query-2", "status": "queued", "queuePosition": 1 },
      { "queryId": "query-1", "status": "running", "queuePosition": null }
    ]
  }
}
```

## 7. 查询会话与结果

```http
GET /api/v1/open/name-lookups/sessions/{sessionId}
```

```json
{
  "session": {
    "sessionId": "...",
    "deviceId": "adb:SERIAL-ONE",
    "status": "ready",
    "pending": false,
    "queuedCount": 0,
    "resultCount": 1,
    "resultsTruncated": false,
    "successfulCount": 1,
    "currentAccount": "132******14",
    "results": [{
      "queryId": "...",
      "clientReference": "order-000001",
      "queuePosition": null,
      "phoneNumber": "138****0000",
      "status": "succeeded",
      "stage": "查询完成",
      "maskedName": "宇轩(**轩)",
      "nameTailCharacter": "轩",
      "accountSwitched": true,
      "accountSwitchReason": "frequent_or_abnormal_access",
      "accountSwitchCount": 1,
      "reason": "",
      "error": "",
      "createdAt": "2026-09-09T...Z",
      "updatedAt": "2026-09-09T...Z"
    }],
    "humanAction": { "required": false },
    "error": "",
    "createdAt": "2026-09-09T...Z",
    "updatedAt": "2026-09-09T...Z",
    "endedAt": null
  }
}
```

结果状态：`queued`、`running`、`cancelling`、`succeeded`、`not_found`、`needs_human_verification`、`needs_recovery`（候选）、`limit_reached`、`failed`、`cancelled`。`queuePosition` 从 1 开始，正在执行或已完成时为 `null`；`queuedCount` 是当前等待派发数。`accountSwitched/accountSwitchReason/accountSwitchCount` 只用于说明脚本是否在该查询内部完成了自动切号，调用方不据此发起切号。调用方只能把 `succeeded` 和 `not_found` 当作正常完成；其余状态应按 `humanAction`、`queueState` 或错误策略处理。号码始终脱敏，姓名字段只返回上游页面已有的掩码名和实名尾字。

会话响应的 `results` 返回最新 500 条，`resultCount` 是会话累计结果数，超过 500 时 `resultsTruncated=true`。调用方应保存每次提交返回的 `queryId`；无论该结果是否还在最新列表，都可单独查询：

```http
GET /api/v1/open/name-lookups/sessions/{sessionId}/queries/{queryId}
```

```json
{"query":{"queryId":"...","clientReference":"order-000001","phoneNumber":"138****0000","status":"succeeded","queuePosition":null}}
```

## 8. 拼图与人工控屏恢复

出现人工动作时，会话响应包含：

```json
{
  "humanAction": {
    "required": true,
    "type": "manual_jigsaw_verification",
    "reason": "alipay_human_verification_required",
    "queryId": "...",
    "resumeAllowed": true
  }
}
```

处理规则：

1. `queryId` 为空、`resumeAllowed=false`：拼图出现在提交号码之前。专用用户进入网页实时控屏，人工完成拼图并结束控屏；继续轮询到 `ready` 后正常提交号码，不调用 `/resume`。
2. `queryId` 非空、`resumeAllowed=true`：拼图出现在该号码查询之后。人工完成并结束控屏，然后对返回的同一个 `queryId` 调用 `/resume`。
账号查询受限不进入人工流程。只有精确的 `access_denied`、`device_risk`、`frequent_or_abnormal_access` 三类限制触发自动切号；拼图不属于账号上限，绝不触发切号。当前查询任务内部会自动读取已保存账号、排除已尝试账号、切换到下一个账号并继续查询同一个号码；切号和重查都沿用原 `queryId`，调用方看不到也不需要驱动中间步骤。只有所有已保存账号均受限或自动切号无法完成时，当前结果才返回 `limit_reached`，并显示：

```json
{
  "queueState": {
    "status": "paused",
    "reason": "alipay_all_saved_accounts_restricted",
    "action": "end_session_and_select_another_device"
  },
  "humanAction": { "required": false }
}
```

这不是要求用户或平台运营人工切换账号，而是表示该手机的自动可用账号已经耗尽。调用方应结束当前会话并选择其他可用设备重新建会话。队首号码进入真正的人工拼图处理后，整个队列同样暂停；后续号码可以继续入队，但不会被 Windows Agent 领取，原号码恢复后才继续。

```http
POST /api/v1/open/name-lookups/sessions/{sessionId}/resume
Idempotency-Key: resume-order-000001
Content-Type: application/json

{"queryId":"original-query-id"}
```

恢复接口只接受当前最新、确实处于人工验证状态的原 `queryId`。它绑定原手机号和原结果，不重新输入号码；结果仍写回同一个 `queryId`。控屏仍活动、验证未消失、页面与原号码不匹配或 `queryId` 错误时返回冲突/失败，调用方不得跳到下一个号码。

## 9. 结束会话

```http
POST /api/v1/open/name-lookups/sessions/{sessionId}/end
Content-Type: application/json

{}
```

返回 `202` 表示停止任务已受理。继续轮询到 `ended`。已终止会话重复调用返回 `200`，不会创建第二个停止任务。调用方应在正常完成、不可恢复失败以及自身超时清理中都调用结束接口。

`/end` 会取消尚未执行的排队项，并有界停止当前项；排队项最终显示为 `cancelled`，执行中的项目可能短暂显示为 `cancelling`。结束接口本身不要求 `Idempotency-Key`，重复调用天然幂等。

## 10. 错误和重试

错误统一为 JSON：

```json
{"error":"lookup_session_not_ready"}
```

| HTTP | 典型错误 | 调用方动作 |
|---|---|---|
| 400 | `idempotency_key_required`、`invalid_client_reference`、`invalid_consent_reference` | 修正请求，不重试原错误参数 |
| 401 | `open_api_auth_required`、`invalid_open_api_signature`、`open_api_nonce_replayed` | 修正签名；重试时换时间戳和 Nonce |
| 403 | `open_name_lookup_user_not_available`、`open_name_lookup_device_not_allowed` | 联系管理员修正映射或白名单 |
| 404 | `open_name_lookup_api_not_enabled`、`lookup_session_not_found` | 确认环境、开关和 client 租户 |
| 409 | `device_busy`、`lookup_session_not_ready`、`lookup_screen_control_active`、`lookup_queue_paused_account_switch_required`、`idempotency_conflict`、`lookup_human_verification_not_resumable` | 按状态轮询或人工处理，不盲目换键重放；队列已因全部账号受限暂停时结束会话并改用其他设备 |
| 5xx | `internal_error` 或网关错误 | 指数退避后重试；有幂等键的写请求必须沿用原键 |

网络错误可使用指数退避；状态轮询固定在 2–5 秒，不要使用紧密循环。`5xx` 可重试原业务请求，但必须保留原 `Idempotency-Key` 并生成新的签名材料。

## 11. 接入边界

- 客户端之间按 `clientId` 隔离，不能读取或恢复其他客户端会话。
- HMAC 客户端只访问自身查名字会话；不获得管理员 Token、网页登录态或投屏令牌。
- 审计保存客户端、设备、会话、业务引用和授权引用；不会把完整手机号写入 Open API 审计详情。
- 接口不设置查询次数配额，但外部系统仍须保证每个号码都有独立授权引用，并遵循合法用途和账户规则。
- 当前候选没有修改 scrcpy、编码、WebRTC、点击滑动映射或投屏重连逻辑；人工控屏沿用 D-060 已有同发起者兼容边界。

## 12. 推荐轮询与故障恢复算法

1. 保存创建会话返回的 `sessionId`，随后每个号码保存 `queryId + clientReference + idempotencyKey`。
2. 入队请求网络超时时，使用原 `Idempotency-Key`、新时间戳和新 Nonce 重试；不要创建第二个业务引用。
3. 每 2–5 秒轮询会话。正常业务终态写入本地结果表；不要通过再次查询同一手机号来确认结果。
4. `humanAction.required=true` 时通知人工。`resumeAllowed=true` 只恢复返回的原 `queryId`；恢复请求网络超时也沿用原恢复幂等键。
5. `queueState.status=paused` 时先检查 `action`：候选的 `retry_current_query` 表示重试该原查询或结束会话；`end_session_and_select_another_device` 才表示结束并选择另一台 `available=true` 设备。账号切换由平台自动完成，调用方不调用账号接口。
6. 调用方退出、整体超时或业务取消时调用 `/end`，再轮询至会话终态；本地保留每个已接收 `queryId` 的最终状态。

建议调用方为单次 HTTP 请求设置 10–30 秒超时，为整批任务设置自己的业务截止时间；HTTP 超时与查询业务终态是两件事，HTTP 超时后先按幂等规则重试或读取状态。

## 13. 交付与联调清单

平台管理员单独交付：

- 生产/测试 `BASE_URL`；
- `clientId` 与至少 32 字符的独立密钥；
- 精确设备白名单；
- 人工拼图时使用的平台操作账号及通知方式。

调用方上线前确认：

- 密钥仅保存在服务端密钥管理器，浏览器、移动端和日志中均不存在；
- 系统时间同步，签名使用最终发送的 UTF-8 原文；
- 创建、入队和恢复均持久化幂等键；
- 结果按 `queryId` 对账，支持超过 500 条时逐个查询历史结果；
- 已实现人工拼图、全账号受限换设备、网络重试和最终 `/end` 清理；
- 每个号码都有合法授权和唯一 `consentReference`。

推荐直接采用仓库中的 [Node.js/Python SDK 与示例](../sdk/open_name_lookup/README.md)，并运行 `npm run test:sdk` 验证本地运行环境。
