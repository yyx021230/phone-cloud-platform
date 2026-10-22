# 支付宝查名字 HTTP API 开发对接文档

更新日期：2026-10-22。适用线上版本：`lookup-throughput-20261022-deployed.1`（rc.4已上线）。本文供调用方后端开发直接接入；仅包含支付宝查名字，不包含短信、小红书或平台管理接口。

调用方只需要一个固定 **API Key**。启动准备后，逐条提交手机号，按查询编号获取姓名；不需要传手机编号、支付宝账号或分配策略。平台内部负责找可用手机、排队、切号、冷却、人工验证后的接续，以及异常处理。

**业务成功完成只有两种结果：`name` 是姓名字符串，或 `name` 是空字符串。排队、处理中、失败、被取消都不是“没有姓名”。**

## 本次更新，调用方需要改什么

接口地址、四个HTTP接口和原API Key都不变。**“暂无可用手机”的反馈在查询过程中同样适用，不只启动时。**

1. 是否继续传新号码，改看 `acceptingRequests`，不能只看 `ready`。收到 `lookup_no_available_device` 时暂停该Key对应的整个新提交队列。
2. 新号码被拒绝返回HTTP503、`accepted:false`，没有生成 `lookupId`；至少等30秒，用原准备键检查，恢复后用原业务键提交。
3. 已经受理的查询保留原 `lookupId`：排队继续等、执行中安全恢复或跨机接续、完成结果照常读取。不能重复建单、不能写空姓名。详见第6.1节。
4. 首次至少2台通过才开放本轮；之后恢复1台有效手机即可继续接单。健康手机只是忙碌时仍可排队，平台最多5台执行，客户最多20条未完成业务。
5. 轮次改为**无未完成业务且连续空闲15分钟自动结束**，不是固定30分钟租约；手机空闲5分钟优先原机重探。`expiresAt`可能为null。
6. 执行中掉线与主动结束分开处理；持续离线30秒的旧执行安全隔离后，业务原单可跨机接续。结束时不会一直被离线手机卡住，但仍须以 `stopped:true` 为准。

本包Python、Node示例、OpenAPI与校验文件同步更新。客户端多个线程/服务必须共用“暂停新提交”状态，不能只停其中一个线程。

## 1. 对接地址与交付文件

| 项目 | 内容 |
|---|---|
| 服务地址 | `http://47.98.127.132` |
| API 前缀 | `/api/v1/open/name-lookups` |
| 请求与响应 | JSON，UTF-8 |
| 认证方式 | 请求头 `X-API-Key: 你收到的API Key` |
| 平台登录 | 调用这四个接口不需要先登录平台 |
| Client ID、Client Secret、签名 | 新接入不需要 |
| 当前传输协议 | HTTP；不要擅自改成未提供的 HTTPS 地址 |
| 在线接口文档 | [查名接口说明](http://47.98.127.132/api-docs.html#post-api-v1-open-name-lookups-prepare) |
| 查名 OpenAPI | [下载接口定义](http://47.98.127.132/downloads/name-lookup-openapi.json) |

API Key 由平台方单独交付，本文和代码包不包含真实密钥。不要用平台账号密码代替 Key；同一个 Key 用于全部四个接口。Key 只放请求头，保存在后端配置中，不放浏览器前端、URL、日志或代码仓库。当前地址为 HTTP，传输本身不加密。

代码包内容：

- `http_flow.py`：四个接口的普通 Python requests 完整示例，自动保存请求键、轮次编号和查询编号，支持退出后继续。
- `lookup.py`：线上已有的单号码查询完整示例，使用 SQLite 保存业务进度。
- `stop_lookup.py`：线上已实测的独立停止示例，输入 preparationId 结束该轮。
- `lookup.mjs`：Node.js 普通 HTTP 查询示例。
- `openapi.json`：仅这四个查名接口的接口定义。
- `SHA256SUMS.json`：交付文件校验清单。

## 2. 先看完整调用顺序

```text
生成并保存一个准备请求键
        ↓
POST /prepare，正文 {}
        ↓
preparing：用相同准备键继续读取；暂不接单时每30秒检查
        ↓
ready:true 且 acceptingRequests:true：保存 preparationId，开始提交业务
        ↓
每个业务生成并保存一个提交请求键
        ↓
POST /tasks，正文只有 phoneNumber
        ↓
保存返回的 lookupId
        ↓
GET /tasks/{lookupId}，每5秒读取原编号
        ├─ queued / processing：继续等待原请求；无可用反馈时暂停新提交
        ├─ completed：读取 name，保存最终结果
        └─ failed：读取 code，按异常处理，不能写成空姓名

本轮业务结束或需要中止时：
停止调用方自己的新提交 → POST /stop，传 preparationId
        ↓
stopping：每5秒重复原停止请求
        ↓
stopped:true：本轮结束
        ↓
下次需要查询：用新的准备请求键 POST /prepare
```

准备是**同一客户共享的一轮任务**，不是每个手机号单独启动一次。本轮还有效时，即便误换准备键也不会得到第二套独立手机池；换键可能触发额外重探，所以正常轮询必须用原键。一个轮次可以提交多个手机号，每条结果独立返回；不等整批完成。

结束接口也是结束**该客户本轮全部查名任务**，不是取消单个 lookupId。多个后端进程共用同一个 API Key 时，应由一个协调者统一管理准备和结束，避免其中一个进程把其他进程还需要的同轮查询结束。

## 3. 需要保存的编号

| 名称 | 谁生成 | 用途与保存规则 |
|---|---|---|
| API Key | 平台方 | 固定认证凭据；四个接口共用 |
| 准备请求键 | 调用方 | 放在 prepare 的 Idempotency-Key；首次发送前保存，同一轮轮询不更换 |
| preparationId | 平台方 | prepare 返回的轮次编号；结束时原样传入 stop |
| 业务编号 | 调用方 | 调用方自己的订单/记录编号；用于关联本地数据，不放入接口正文 |
| 提交请求键 | 调用方 | 放在 tasks 的 Idempotency-Key；一笔业务一个键，重试保持不变 |
| lookupId | 平台方 | 单条查询编号；后续获取结果始终使用此编号 |
| 停止请求键 | 调用方 | 建议固定为 `stop-` 加 preparationId；停止轮询和超时重试保持不变 |

三个 POST 均要求 `Idempotency-Key`。格式为 **8–160个字符**，仅支持字母、数字、点、下划线、冒号、短横线。推荐使用带用途前缀的 UUID，例如 `prepare-<UUID>`、`query-<UUID>`。准备键、提交键、停止键分开，不要混用。

GET 获取结果不需要 `Idempotency-Key`。请求键不是密钥，不替代 `X-API-Key`。

## 4. 接口一 启动准备并读取就绪状态

### 请求

```http
POST /api/v1/open/name-lookups/prepare HTTP/1.1
Host: 47.98.127.132
X-API-Key: <API_KEY>
Idempotency-Key: prepare-11111111-1111-4111-8111-111111111111
Content-Type: application/json

{}
```

请求体必须是空对象 `{}`，不要传手机号或设备列表。准备请求返回较快，**不是一直阻塞到手机全部准备好才返回**。

### 准备中 HTTP 200

```json
{
  "ok": true,
  "preparationId": "11111111-1111-4111-8111-111111111111",
  "status": "preparing",
  "ready": false,
  "acceptingRequests": false,
  "expiresAt": "2026-10-22T04:15:00.000Z"
}
```

重复相同 POST，正文仍为 `{}`，准备请求键保持不变。`acceptingRequests:false` 时暂停新提交，约每30秒检查；若有 `retryAfterSeconds`，按该间隔等待。不要每次轮询生成新键。准备中零台有效可查时，也可能附带 `code:lookup_no_available_device` 和 `retryAfterSeconds:30`。

### 准备就绪 HTTP 200

```json
{
  "ok": true,
  "preparationId": "11111111-1111-4111-8111-111111111111",
  "status": "ready",
  "ready": true,
  "acceptingRequests": true,
  "expiresAt": "2026-10-22T04:15:00.000Z"
}
```

只有 `status == "ready"`、`ready == true` 且 **`acceptingRequests == true`** 才提交新的手机号。首次内部至少2台探测通过才开放；本轮已开放后，1台有效手机即可接单，其他手机继续准备，最多5台执行。**外部不返回 readyCount 或具体手机数量。**

`ready:true` 是“本轮已通过首次门槛”，不等于现在有可用容量。可能同时返回 `ready:true`、`acceptingRequests:false`，这时必须暂停新号码，旧查询继续获取结果。

| 字段 | 类型 | 含义 |
|---|---|---|
| ok | boolean | 本次请求成功 |
| preparationId | string | 本轮编号，保存后用于结束接口 |
| status | string | preparing / ready / expired / stopping / stopped |
| ready | boolean | 本轮是否已通过首次准备门槛且仍有效；不代表当前可接新号码 |
| acceptingRequests | boolean | 当前是否接收新号码；false时暂停新提交 |
| code | string，可选 | 零有效能力时为lookup_no_available_device，不是查询终态失败 |
| retryAfterSeconds | number，可选 | 建议下次检查间隔，当前无可用时30秒；不承诺30秒恢复 |
| expiresAt | string或null | 当前空闲截止时间（UTC ISO 8601）；有未完成业务时为null，表示空闲计时暂停 |

| status | 调用方处理 |
|---|---|
| preparing | 相同准备键继续读取，尚不提交新号码 |
| ready | 还需acceptingRequests:true才提交新号码；false时保留原轮次检查恢复 |
| expired | 空闲到期，进入安全结束；继续原prepare/stop核对至stopped，不立刻换键开轮 |
| stopping | 本轮正在结束；继续原 stop 请求等待确认，不重新开轮 |
| stopped | 本轮已经结束；确实要开始下一轮时才生成新准备键 |

当前不是固定30分钟租约：**没有未完成业务，并连续15分钟没有新受理业务，才自动结束本轮**。排队、执行、人工等待、恢复等未完成业务会暂停空闲计时；最后一条业务结束后重新计15分钟。只启动而未提交业务时，从启动开始计时。

GET、prepare轮询（包括换准备键）、后台探测、同键重试及复用在途/近期结果，都不续空闲时间；因无可用手机拒绝的新提交也不续期。`expiresAt:null` 不能当作已经过期。

空闲到期可能短暂expired，再进入stopping，最后stopped。对旧准备键也可能收到409 `lookup_preparation_expired`：保留旧业务与轮次，由统一协调者核对；有旧preparationId时可用原stop请求确认结束，确认stopped后再显式创建下一轮。不要让每个查询线程自行换键。

相同准备键在本轮停止后仍返回 stopping/stopped，不会自动重开。停止尚未确认时用新准备键启动，会返回409 `lookup_round_stopping`。

## 5. 接口二 提交一个手机号

### 请求

```http
POST /api/v1/open/name-lookups/tasks HTTP/1.1
Host: 47.98.127.132
X-API-Key: <API_KEY>
Idempotency-Key: query-22222222-2222-4222-8222-222222222222
Content-Type: application/json

{"phoneNumber":"<已授权的11位手机号>"}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| phoneNumber | string | 是 | 11位手机号字符串，示例程序要求13–19开头；不带空格或+86 |

一个请求提交一个号码。不要传数组、手机编号、支付宝账号、轮询超时时间或内部调度参数。`preparationId` 只在结束接口使用，提交接口不需要传。

### 新请求受理 HTTP 202

```json
{
  "ok": true,
  "lookupId": "22222222-2222-4222-8222-222222222222",
  "status": "queued",
  "reused": false
}
```

收到响应后立即保存 `lookupId`，然后调用结果接口。受理不等于查到姓名。

### 复用原任务 HTTP 200

```json
{
  "ok": true,
  "lookupId": "22222222-2222-4222-8222-222222222222",
  "status": "processing",
  "reused": true
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| ok | boolean | 提交/复用请求已受理，不代表业务已成功完成 |
| lookupId | string | 保存并用于获取结果 |
| status | string | 可能为 queued、processing、completed、failed；仍应 GET 获取完整结果 |
| reused | boolean | 是否复用了原任务或近期成功结果；true 不代表失败 |

提交响应**不返回 name**。即使 status 已是 completed，也继续 GET 原 lookupId 获取姓名。

同一提交键换成另一个手机号，返回409 `idempotency_conflict`。不要删除原记录或反复换键重试。

### 无可用手机，新号码未受理 HTTP 503

响应头：`Retry-After: 30`。

```json
{"ok":false,"code":"lookup_no_available_device","accepted":false,"retryAfterSeconds":30}
```

这次没有创建查询，也没有lookupId。暂停整个新提交队列；30秒后先用原准备键POST /prepare，`acceptingRequests:true`才用原手机号/原业务键提交。不要循环POST号码探活。

防重检查先于新单容量检查：同键、同号码在途或有效近期结果仍可能HTTP200复用原lookupId；即使复用响应附带无可用提示，也必须保存返回的lookupId，后续只GET它。初次准备还没通过时，提交仍可能返回503 `lookup_not_ready`。

## 6. 接口三 获取单条查询结果

### 请求

```http
GET /api/v1/open/name-lookups/tasks/22222222-2222-4222-8222-222222222222 HTTP/1.1
Host: 47.98.127.132
X-API-Key: <API_KEY>
```

无请求体，不需要提交请求键。建议每5秒查一次；每个 lookupId 独立轮询、独立落库。

### 排队或处理中 HTTP 200

```json
{"ok":true,"lookupId":"22222222-2222-4222-8222-222222222222","status":"queued"}
```

```json
{"ok":true,"lookupId":"22222222-2222-4222-8222-222222222222","status":"processing"}
```

这两种状态**没有 name 字段**。processing 可能包含手机正在查询、异常恢复、切号、等待人工验证或跨机接续。继续获取原 lookupId，不要自行重建同号码任务。

### 已完成并有姓名 HTTP 200

```json
{"ok":true,"lookupId":"22222222-2222-4222-8222-222222222222","status":"completed","name":"张*"}
```

name 是平台实际获取到的姓名字符串，可能含星号等脱敏字符；不要假设一定是完整姓名、固定长度或只有汉字。

### 已完成但没有姓名 HTTP 200

```json
{"ok":true,"lookupId":"22222222-2222-4222-8222-222222222222","status":"completed","name":""}
```

没有姓名、未实名均归为这一种空字符串结果，不另外返回“未实名姓名”。

### 失败或主动取消 HTTP 200

```json
{"ok":false,"lookupId":"22222222-2222-4222-8222-222222222222","status":"failed","code":"lookup_round_stopped"}
```

**HTTP200不保证业务成功。** 需要检查 `status` 和 `ok`。失败没有 name 字段，不能用 `result.get("name", "")` 把失败填成空姓名。

| 判定 | 处理 |
|---|---|
| completed 且 name 为非空字符串 | 保存该姓名，结束这条轮询 |
| completed 且 name 为 `""` | 保存“没有姓名”，结束这条轮询 |
| queued / processing | 保留查询编号，继续等待 |
| failed | 保存 code，结束这条轮询并按错误处理 |
| 请求超时、非JSON、缺字段、未知状态 | 结果未确认，保留原编号，不写空姓名 |

已完成结果在结束本轮后仍可通过原 lookupId 读取。调用方应自行保存最终结果，不把平台查询接口当作永久业务数据库。

## 6.1 查询过程中全部手机不可用怎么办

**不只启动时检查。** 假设已经提交了一批号码，之后全部手机离线、账号不能用、等待人工或重新探测，处理如下。

| 手里的业务 | 平台返回与处理 | 调用方要做什么 |
|---|---|---|
| 还没受理的新号码 | POST返回503、lookup_no_available_device、accepted:false，无lookupId | 停止新提交，保留业务与原提交键，等待恢复 |
| 已受理、还在排队 | GET仍HTTP200/queued，附无可用反馈，原ID保留 | 按retryAfterSeconds约30秒GET原lookupId，不重建任务 |
| 已经在查或正在恢复 | GET仍processing；安全停止确认/离线隔离后才能跨机接续 | 继续GET原lookupId；processing不保证附带无可用字段，不能因此推断可以传新号码 |
| 已查完 | GET仍completed并返回name | 正常保存姓名或明确的空字符串，不受容量不足影响 |
| 原任务总期限耗尽 | GET为failed及对应超时代码 | 记失败并停止该条轮询，不能当作空姓名；不会无限排队 |

重新检查本轮（POST /prepare，同一个准备键），可能返回：

```json
{
  "ok":true,
  "preparationId":"11111111-1111-4111-8111-111111111111",
  "status":"ready",
  "ready":true,
  "acceptingRequests":false,
  "expiresAt":null,
  "code":"lookup_no_available_device",
  "retryAfterSeconds":30
}
```

这里本轮已经开放过，所以ready仍为true；有未完成业务，expiresAt为null；当前没有可查能力，所以acceptingRequests为false。**不能只判断ready就继续传号。**

排队原查询的GET示例（HTTP200）：

```json
{
  "ok":true,
  "lookupId":"22222222-2222-4222-8222-222222222222",
  "status":"queued",
  "acceptingRequests":false,
  "code":"lookup_no_available_device",
  "retryAfterSeconds":30
}
```

这个code是等待原因，**不是终态失败**。不要因为存在code就将原查询标failed，更不能写name为空字符串。

调用方统一处理顺序：

1. prepare返回acceptingRequests:false，或POST/GET出现lookup_no_available_device时，暂停该API Key的新提交队列（所有线程/实例共享）。
2. 已有lookupId继续读原结果；排队无可用提示按30秒，正常queued/processing约5秒。没有lookupId且明确accepted:false的业务暂存本地。
3. 由一个协调者约每30秒使用原准备键检查；轮次仍有效且acceptingRequests:true后恢复新提交。ready:true不单独解除暂停。
4. 已开放的同一轮恢复1台有效手机即可继续，旧队列由平台分配。手机健康但正在忙时允许排队，不必等它空闲才传号。
5. 不因为暂时无可用手机自动调用stop或重新启动；如果原轮确实已结束，确认stopped后显式新开一轮。任何恢复/切号/跨机都不重置原查询总期限。

单个账号触限由平台记录冷却，并尝试本机其他可用账号、重新探测；原查询按安全接续规则交给可用手机。账号掉线或设备故障与触限分类不同，对接方不需要自行切号、选手机或重复提交。

## 7. 接口四 结束本轮任务

调用前，先停止调用方自身的新提交线程/定时提交，避免结束过程中仍有请求发出。

### 请求

```http
POST /api/v1/open/name-lookups/stop HTTP/1.1
Host: 47.98.127.132
X-API-Key: <API_KEY>
Idempotency-Key: stop-11111111-1111-4111-8111-111111111111
Content-Type: application/json

{"preparationId":"11111111-1111-4111-8111-111111111111"}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| preparationId | string | 是 | prepare 返回的本轮编号；不能填 lookupId |

正文只允许这个字段。停止键建议就是 `stop-` 加 preparationId，无需为每次轮询重新生成。

### 正在安全停止 HTTP 202

```json
{"ok":true,"preparationId":"11111111-1111-4111-8111-111111111111","status":"stopping","stopped":false}
```

这时已经禁止该客户本轮新的探测与分配，排队请求被取消；正在执行的查询和探测需要等待手机确认停止。每5秒重复相同停止请求读取进度。

### 停止已确认 HTTP 200

```json
{"ok":true,"preparationId":"11111111-1111-4111-8111-111111111111","status":"stopped","stopped":true}
```

只有 `stopped:true` 才能当作本轮已经结束。HTTP202表示已受理停止，不表示手机已经停止。

结束行为如下：

- 停止本轮探测及后续分配。
- 排队的业务取消；GET 原 lookupId 返回 failed / lookup_round_stopped。
- 正在执行的业务安全停止，收到确认后再取消并释放手机。
- 已完成的结果保留。停止与结果恰好同时发生时，已经收到的完整结果优先保留。
- 在线或执行状态未知的手机继续等待安全停止；本轮已经请求结束时，持续离线30秒的手机在旧工作撤销持久化后单独隔离，不再无限拖住整轮。隔离不等于旧手机物理执行已停止，重连后仍先确认旧会话清理。调用方继续原stop轮询，最终以stopped:true为准。
- 下次开始必须使用新的准备键，重新等ready:true且acceptingRequests:true。
- 迟到的旧停止请求只对应旧 preparationId，不会停止已开始的新一轮。

**停止范围是同一客户本轮全部任务，包括仍未完成的原查询；不是针对一个号码。** 不影响其他客户或非查名任务。不要在每次 GET 超时、页面关闭或单条查询结束时自动调用 stop。

## 8. 10条 20条与5台并发如何配合

当前线上配置如下；配置以后调整时，以平台方交付的新约定和实际429响应为准。

| 项目 | 当前值 | 调用方怎么做 |
|---|---|---|
| 单次提交 | 1个手机号 | 每个号码分别 POST /tasks |
| 同一客户未完成业务 | 最多20条 | 包含排队和处理中；满额后等已有任务完成再补新任务 |
| 平台内部执行并发 | 最多5台手机 | 调用方不用选手机，也无需把HTTP调用限制成5条 |
| 首次准备门槛 | 至少2台通过 | 首次通过后不再要求始终两台；新号码看acceptingRequests |
| 推荐轮询 | 每个未完成任务约5秒一次 | 完成一条立即保存，不等待整批 |
| 近期同号码结果复用 | 10分钟 | 新请求键可能复用近期完成结果，不等于强制重新查手机 |
| 首次排队期限 | 自受理起30分钟 | 首次未分配超过期限明确失败；已执行后跨机重排沿用原总期限 |
| 任务总期限 | 自受理起60分钟 | 包含排队/执行；恢复或转交不重置总期限 |
| 本轮空闲结束 | 15分钟 | 有未完成业务时暂停空闲计时；轮询、探测和防重复用不续期 |
| 手机空闲重探 | 5分钟 | 健康手机优先原机重探；无需调用方换手机 |
| 全部暂不可用 | 新号码503；旧单保留 | 暂停新提交，约30秒检查；恢复一台有效手机即可继续 |

例如20个号码进入平台，当前只有2台就绪，就由这2台处理，其他号码留在公共队列；新的手机就绪后自动接后续任务，最多5台同时执行。号码不会提前永久绑定到某台手机。

如果总共有50条，调用方在自己数据库里保留待提交列表，维持最多20条已受理未完成任务；完成一条就补一条。遇到429等待 `Retry-After` 指定时间，没有该头时等5秒，用原提交键重试。

## 9. 两分钟超时与重复提交

调用方设置120秒，只决定调用方等待多久，**不会取消服务器任务**。

### 已收到 lookupId

原请求仍是 queued/processing 时，下一次直接 GET 原 lookupId。不要重新准备整轮，不要再创建一笔业务，不要先调用 stop。

### POST提交响应丢失 没拿到 lookupId

用**相同手机号、相同提交请求键**重新 POST /tasks，平台返回原 lookupId。请求键应在首次发送前就保存，不能在重试函数里重新生成。

### 两分钟后误用了新提交请求键

同一客户、同一个手机号仍在处理中，平台会合并到原 lookupId，不重复发起查询。不过正确实现仍应保留原键，不能把这一层防重当作不保存状态的理由。

### 原任务已经完成

相同原提交键继续返回原业务；新提交键可能复用10分钟内的同号码完成结果。换请求键或换准备轮次都不能保证强制重新执行手机查询。接口没有 force 参数。

### 原任务已失败或被取消

先保存并处理原失败结果。明确要重新做一笔查询时，在允许接单的轮次使用新的业务编号和提交键。反复使用旧业务键只会读取旧失败/取消结果。

### 停止请求超时

仍使用原 preparationId 和原停止键重试 POST /stop。不要把“客户端没收到响应”当作“服务器没处理”，也不要直接创建新轮次。

## 10. 错误码与处理方式

接口层错误通常是非2xx HTTP响应：

```json
{"ok":false,"code":"lookup_inflight_limit"}
```

业务层失败通过 GET 返回HTTP200、status:failed和code。两种层次都要处理。

| HTTP或业务状态 | code | 处理 |
|---|---|---|
| 400 | idempotency_key_required / invalid_idempotency_key | POST缺少请求键或格式错误；修正参数，不盲重试 |
| 400 | invalid_lookup_phone | 修正手机号字符串 |
| 400 | prepare_body_must_be_empty | prepare正文改为 `{}` |
| 400 | stop_body_requires_preparation_id / invalid_preparation_id | stop只传原preparationId，不能传lookupId或多余字段 |
| 401 | invalid_lookup_api_key / open_api_auth_required | 检查Key与请求头；不要用平台密码代替 |
| 401 | mixed_lookup_auth | 只保留X-API-Key，删除旧签名认证头 |
| 401 | lookup_api_key_scope_denied | Key只用于本文四个接口，检查路径和HTTP方法 |
| 403 | managed_lookup_not_authorized | 联系平台检查客户开通/授权；不要循环提交 |
| 404 | managed_lookup_not_enabled | 联系平台检查功能启用或服务地址 |
| 404 | lookup_task_not_found | 核对原lookupId及所属Key，不填空姓名 |
| 404 | lookup_preparation_not_found | 核对preparationId及所属Key，不拿新轮编号代替旧停止目标 |
| 409 | idempotency_conflict | 同一个请求键被用于不同参数；对账原业务 |
| 409 | lookup_preparation_expired | 由协调者核对并明确创建新的准备键；已有lookupId保留 |
| 409 | lookup_round_stopping | 原轮还未确认结束，继续原stop请求 |
| 429 | lookup_inflight_limit / lookup_queue_full | 等已有任务完成，按Retry-After或5秒退避，原键重试 |
| 429 | lookup_duplicate_limit | 不要持续换新键重复提交同一任务；用原键/lookupId继续 |
| 429 | lookup_preparation_key_limit / lookup_stop_key_limit | 不再生成新键，联系平台处理幂等记录额度；原停止键仍应保留 |
| 503 | lookup_not_ready | 本轮尚未开放或已结束；检查prepare状态；已受理任务继续GET |
| 503 | lookup_no_available_device | 新号码未受理，accepted:false，无lookupId；暂停新提交，按Retry-After/30秒检查原prepare |
| 200 / queued | lookup_no_available_device | 原查询仍排队，不是failed；原lookupId继续GET，暂停新提交 |
| 503 | lookup_pool_disabled / lookup_probe_not_configured / lookup_preparation_capacity | 联系平台检查服务准备配置 |
| 503 | lookup_storage_unavailable / lookup_outcome_unknown | 暂时状态未知，保留原键和编号，退避后重试，不制造新业务 |
| failed | lookup_round_stopped | 主动结束本轮导致取消，不代表没有姓名 |
| failed | lookup_queue_timeout / lookup_processing_timeout | 任务排队/处理期限到达；记录失败后按业务规则决定是否新建 |
| failed | 其他code | 保存lookupId、时间、code供平台排查；不能当作空姓名 |
| 网络超时 / 502 / 非JSON | 无可靠code | 按请求结果未知处理；保存原键/ID，退避重试 |

不要将所有400/401/403/404当作可以无限重试的临时故障。提交响应为200/202后仍要读 GET 业务状态。

## 11. Python 从启动到结束完整操作

Python 3.9+，安装唯一依赖：

```bash
python -m pip install requests
```

解压代码包，在同一个目录依次执行。API Key 会交互输入且不回显；也可以通过后端进程环境变量 `API_KEY` 配置。不要把真实Key写进代码。

### 第一步 启动准备

```bash
python http_flow.py prepare
```

返回ready:true且acceptingRequests:true后进行下一步。若出现 `localWaitTimedOut:true`，这是**示例程序自己的等待超时标记，不是服务器API状态**；再次运行同一个命令即可继续，不删除状态文件。

### 第二步 提交一条授权号码

```bash
python http_flow.py submit "你的已授权11位手机号" "order-001"
```

将占位文字换成实际号码。`order-001` 是调用方业务编号。程序会先保存提交键，再发送POST，然后保存lookupId。命令因网络问题退出时，继续用同一手机号、同一业务编号重新运行。若输出accepted:false/lookup_no_available_device，先暂停提交、按retryAfterSeconds等待，再运行prepare检查恢复；不要换业务编号。示例会保存同一状态文件内的发送暂停时间。

每条新业务使用不同业务编号。重复运行已经拿到lookupId的同一业务，只读取原结果，不重新提交。

### 第三步 获取结果

```bash
python http_flow.py result "order-001"
```

最多等待约120秒。返回 completed 后读取name；返回failed处理code；本地等待超时则稍后再次运行原result命令，服务器仍会继续执行。

### 第四步 结束本轮

确认本轮不再提交新业务后：

```bash
python http_flow.py stop
```

程序从状态文件读取preparationId，使用同一个Key调用结束接口，直到stopped或本地等待超时。超时后重复stop命令，不创建新轮次。

### 第五步 明确开始下一轮

```bash
python http_flow.py prepare --new-round
python http_flow.py submit "另一条已授权手机号" "order-002"
python http_flow.py result "order-002"
python http_flow.py stop
```

只有上一轮确认stopped时，演示程序允许 `--new-round`。空闲到期先等待安全结束，不跳过stopping。正常准备中或正在查时，不应每个号码都重新启动一轮。

### 示例状态文件与使用范围

`http_flow.py` 默认生成 `lookup-http-state.json`，保存准备键、preparationId、业务提交键、lookupId和结果；不保存API Key。它用于恢复进度，**不要在超时后删除，也不要提交到Git仓库**。更换Key或地址时程序会拒绝混用旧文件，避免读错客户数据。

`localSubmissionPaused:true`也是示例本地标记，表示这次没有发新号码，不是服务器增加的状态字段。退出码3表示暂停新提交，退出码2表示本地等待超时或业务失败；保留状态文件继续处理。

示例按单进程使用设计；暂停信息只在同一个状态文件内共享，不能代替多实例协调。多进程/多服务部署时，将这些字段存入业务数据库，用事务和唯一约束保证“同客户同业务编号只有一个提交键”，并由统一协调者控制prepare/stop；不要让多个进程同时写这个JSON文件。

完整可运行代码见同目录 `http_flow.py`；其中四个HTTP动作就是：

```python
# 以下展示接口调用本身；api_key、prepare_key、submit_key、preparation_id
# 和lookup_id由前文流程生成/保存，phone_number由你的业务提供。
import requests

base = "http://47.98.127.132/api/v1/open/name-lookups"
auth = {"X-API-Key": api_key}

prepare_response = requests.post(
    base + "/prepare", headers={**auth, "Idempotency-Key": prepare_key},
    json={}, timeout=30, allow_redirects=False)
# 保存preparationId；等status=ready、ready=true且acceptingRequests=true。

submit_response = requests.post(
    base + "/tasks", headers={**auth, "Idempotency-Key": submit_key},
    json={"phoneNumber": phone_number}, timeout=30, allow_redirects=False)
# 保存lookupId；200/202受理并不是已查到名字。

result_response = requests.get(
    base + "/tasks/" + lookup_id, headers=auth,
    timeout=30, allow_redirects=False)
# 只在status=completed时读取name；failed处理code。

stop_response = requests.post(
    base + "/stop",
    headers={**auth, "Idempotency-Key": "stop-" + preparation_id},
    json={"preparationId": preparation_id}, timeout=30, allow_redirects=False)
# stopping继续原请求；stopped=true后才开始新轮次。
```

上面片段用于理解HTTP方法与参数，不能不检查状态就顺序执行。`http_flow.py` 已包含状态检查、请求键落盘、轮询和结束逻辑，无需SDK初始化。

## 12. 调用方推荐落库结构

| 数据范围 | 字段 |
|---|---|
| 客户配置 | 平台地址、凭据引用、所有实例共享的发送暂停状态及下次检查时间 |
| 当前准备轮次 | 准备键、preparationId、status、ready、acceptingRequests、expiresAt（可为null）、停止键 |
| 每笔查询 | 你方业务编号、手机号、提交键、lookupId、状态、name、code、提交/完成时间 |

业务编号唯一键建议包含调用方客户标识；同一API Key共用轮次但不同业务记录独立。先提交本地事务保存请求键，再发HTTP；收到lookupId后立即保存。调用方120秒超时只更新“待继续查询”的显示，不应把服务器业务标成已取消或没有姓名。

终态后停止轮询。结果回写要幂等，同一个lookupId再次返回completed时不重复触发你方业务副作用。可用lookupId作为结果去重键。

## 13. 对接联调检查表

- 用同一个Key完成prepare → ready且acceptingRequests → submit → GET completed。
- 已开放轮次全部不可用时，新号码503且无新lookupId；原queued/processing查询保留，已完成结果仍可读。
- ready:true但acceptingRequests:false时不再传新号码；恢复后按原键提交；多线程共享暂停。
- queued带lookup_no_available_device时不记失败、不写空姓名；processing不保证附带该提示。
- 15分钟无业务自然结束与5分钟原机重探；expiresAt:null不当作过期。
- 姓名非空和空字符串分别按实际响应保存；失败不填空姓名。
- 保存prepare键/preparationId/提交键/lookupId；进程退出后能继续原业务。
- 提交响应丢失后原键重试得到同一个lookupId。
- 等待120秒未完成后继续GET，不重新创建业务或自动stop。
- 10条/20条分别提交，逐条取结果；429按退避和原键重试。
- 存在排队及处理中任务时结束，先stopping后stopped；被取消的查询状态明确。
- 已完成结果在stop之后仍能GET；新一轮使用新准备键并重新等ready。
- 旧stop请求重试不会结束新一轮；多个工作进程不会擅自结束共享轮次。

历史2026-10-16版本已完成停止主链路的外部真机验证：7条排队取消、3条在查和2条探测停止、既有姓名结果保留、新一轮成功查询，以及旧停止请求隔离。停止中断线和服务重启场景在隔离HTTP/PostgreSQL环境验证，未在生产注入故障；这不是全部设备和外部环境永不异常的承诺。



2026-10-22当前版已上线，完成本地1053项回归、JSON/隔离PostgreSQL各50条模拟HTTP、零可用30并发拒绝和121秒换键防重验证；生产版本/健康/公开资源已核对。本次文档同步未发起新的真实号码查询；新版本完整真机业务效果继续以实际联调记录为准。
