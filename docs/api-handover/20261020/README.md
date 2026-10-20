# 支付宝查名字 HTTP API 开发对接文档

候选日期：2026-10-20。适用版本：`lookup-idle-refresh-20261020-rc.1`，**本地测试版，尚未上线**。本文供调用方后端开发直接接入；仅包含支付宝查名字，不包含短信、小红书或平台管理接口。

调用方只需要一个固定 **API Key**。启动准备后，逐条提交手机号，按查询编号获取姓名；不需要传手机编号、支付宝账号或分配策略。平台内部负责找可用手机、排队、切号、冷却、人工验证后的接续，以及异常处理。

**业务成功完成只有两种结果：`name` 是姓名字符串，或 `name` 是空字符串。排队、处理中、失败、被取消都不是“没有姓名”。**

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
preparing：每5秒用相同准备键继续读取
        ↓
ready:true：保存 preparationId，开始提交业务
        ↓
每个业务生成并保存一个提交请求键
        ↓
POST /tasks，正文只有 phoneNumber
        ↓
保存返回的 lookupId
        ↓
GET /tasks/{lookupId}，每5秒读取原编号
        ├─ queued / processing：继续等待原请求
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

准备是**同一客户共享的一轮任务**，不是每个手机号单独启动一次。一个轮次可以提交多个手机号，每条结果独立返回；不等整批完成。

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
  "expiresAt": "2026-10-16T09:30:00.000Z"
}
```

每5秒重复相同 POST，正文仍为 `{}`，准备请求键保持不变。不要每次轮询生成新键。

### 准备就绪 HTTP 200

```json
{
  "ok": true,
  "preparationId": "11111111-1111-4111-8111-111111111111",
  "status": "ready",
  "ready": true,
  "expiresAt": "2026-10-16T09:30:00.000Z"
}
```

只有 `status == "ready"` 且 `ready == true` 才提交新的手机号。内部至少2台可查才对外就绪；其他手机继续准备，目标补到5台。**外部不返回 readyCount 或具体手机数量，不要依赖这些字段。**

| 字段 | 类型 | 含义 |
|---|---|---|
| ok | boolean | 本次请求成功 |
| preparationId | string | 本轮编号，保存后用于结束接口 |
| status | string | preparing / ready / expired / stopping / stopped |
| ready | boolean | 当前能否接受新的查询；不要缓存为永远就绪 |
| expiresAt | string 或 null | 空闲截止时间，ISO 8601 UTC；有未完成业务时为 null，空闲计时暂停 |

| status | 调用方处理 |
|---|---|
| preparing | 相同准备键继续读取，尚不提交新号码 |
| ready | ready:true 后可以提交新号码 |
| expired | 空闲已到期；等自动停止确认后再开启新轮，已有 lookupId 继续读取 |
| stopping | 本轮正在结束；继续原 stop 请求等待确认，不重新开轮 |
| stopped | 本轮已经结束；确实要开始下一轮时才生成新准备键 |

本轮没有未完成业务，并连续15分钟没有新受理查询时自动结束。排队、执行、人工等待、恢复和未知执行不会按空闲关闭；最后一条结束后重新计15分钟。只启动未提交业务时从启动计时；探测、GET、prepare轮询及重复/缓存命中不续期。空闲到期可能短暂expired，随后stopping，等待手机停止确认才stopped；之后才能用新准备键明确启动。对旧轮次的准备键，也可能收到409 `lookup_preparation_expired`；调用方应核对当前共享轮次，再由协调者明确创建下一轮。不要让每个查询线程自行刷新准备键。

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
- 手机离线或执行状态未知时，可能保持 stopping；不会仅凭客户端超时假装已停止，也不要强行新开一轮。
- 下次开始必须使用新的准备键，重新等 ready:true。
- 迟到的旧停止请求只对应旧 preparationId，不会停止已开始的新一轮。

**停止范围是同一客户本轮全部任务，包括仍未完成的旧租约任务；不是针对一个号码。** 不影响其他客户或非查名任务。不要在每次 GET 超时、页面关闭或单条查询结束时自动调用 stop。

## 8. 10条 20条与5台并发如何配合

当前线上配置如下；配置以后调整时，以平台方交付的新约定和实际429响应为准。

| 项目 | 当前值 | 调用方怎么做 |
|---|---|---|
| 单次提交 | 1个手机号 | 每个号码分别 POST /tasks |
| 同一客户未完成业务 | 最多20条 | 包含排队和处理中；满额后等已有任务完成再补新任务 |
| 平台内部执行并发 | 最多5台手机 | 调用方不用选手机，也无需把HTTP调用限制成5条 |
| 对外就绪门槛 | 至少2台内部可用 | 只看 ready:true，不关心具体台数 |
| 推荐轮询 | 每个未完成任务约5秒一次 | 完成一条立即保存，不等待整批 |
| 近期同号码结果复用 | 10分钟 | 新请求键可能复用近期完成结果，不等于强制重新查手机 |
| 排队期限 | 自受理起30分钟 | 超时明确失败，不会无限排队 |
| 任务总期限 | 自受理起60分钟 | 包含排队/执行；恢复或转交不重置总期限 |
| 本轮空闲期限 | 连续空闲15分钟 | 有未完成业务时暂停；最后一条结束后重新计时，停止等待手机确认 |

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
| 503 | lookup_not_ready | 暂停新提交，用同一准备键检查；已受理任务继续GET |
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

返回 ready:true 后进行下一步。若出现 `localWaitTimedOut:true`，这是**示例程序自己的等待超时标记，不是服务器API状态**；再次运行同一个命令即可继续，不删除状态文件。

### 第二步 提交一条授权号码

```bash
python http_flow.py submit "你的已授权11位手机号" "order-001"
```

将占位文字换成实际号码。`order-001` 是调用方业务编号。程序会先保存提交键，再发送POST，然后保存lookupId。命令因网络问题退出时，继续用同一手机号、同一业务编号重新运行。

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

只有上一轮已结束或自然过期时，演示程序允许 `--new-round`。正常准备中或正在查时，不应每个号码都重新启动一轮。

### 示例状态文件与使用范围

`http_flow.py` 默认生成 `lookup-http-state.json`，保存准备键、preparationId、业务提交键、lookupId和结果；不保存API Key。它用于恢复进度，**不要在超时后删除，也不要提交到Git仓库**。更换Key或地址时程序会拒绝混用旧文件，避免读错客户数据。

示例按单进程使用设计。多进程/多服务部署时，将这些字段存入业务数据库，用事务和唯一约束保证“同客户同业务编号只有一个提交键”，并由统一协调者控制prepare/stop；不要让多个进程同时写这个JSON文件。

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
# 保存preparationId；等status=ready且ready=true。

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
| 客户配置 | 平台地址、凭据引用、当前是否允许新提交 |
| 当前准备轮次 | 准备键、preparationId、status、expiresAt、停止键 |
| 每笔查询 | 你方业务编号、手机号、提交键、lookupId、状态、name、code、提交/完成时间 |

业务编号唯一键建议包含调用方客户标识；同一API Key共用轮次但不同业务记录独立。先提交本地事务保存请求键，再发HTTP；收到lookupId后立即保存。调用方120秒超时只更新“待继续查询”的显示，不应把服务器业务标成已取消或没有姓名。

终态后停止轮询。结果回写要幂等，同一个lookupId再次返回completed时不重复触发你方业务副作用。可用lookupId作为结果去重键。

## 13. 对接联调检查表

- 用同一个Key完成prepare → ready → submit → GET completed。
- 姓名非空和空字符串分别按实际响应保存；失败不填空姓名。
- 保存prepare键/preparationId/提交键/lookupId；进程退出后能继续原业务。
- 提交响应丢失后原键重试得到同一个lookupId。
- 等待120秒未完成后继续GET，不重新创建业务或自动stop。
- 10条/20条分别提交，逐条取结果；429按退避和原键重试。
- 存在排队及处理中任务时结束，先stopping后stopped；被取消的查询状态明确。
- 已完成结果在stop之后仍能GET；新一轮使用新准备键并重新等ready。
- 旧stop请求重试不会结束新一轮；多个工作进程不会擅自结束共享轮次。

平台侧本版本已经完成上述停止主链路的外部真机验证：7条排队取消、3条在查和2条探测停止、既有姓名结果保留、新一轮成功查询，以及旧停止请求隔离。停止中断线和服务重启场景在隔离HTTP/PostgreSQL环境验证，未在生产注入故障；这不是全部设备和外部环境永不异常的承诺。

## 14. 遇到问题发给平台哪些信息

提供：发生时间与时区、HTTP方法和路径、HTTP状态码、code、preparationId或lookupId、是否超时/重试，以及你方业务编号。必要时附脱敏响应。不要发送API Key、平台密码或完整敏感日志。

当前没有对调用方开放结果回调、批量号码数组提交或单条取消接口。结果通过GET获取，结束通过本轮stop；需要其他能力时由双方另行确认接口版本。


手机连续空闲满5分钟后暂停接收业务，优先保留原健康会话重新探测，通过后再接单；原手机异常、账户掉线、冷却、被控屏占用或需人工处理时，使用其他可用候补。后台重新探测不延长整轮15分钟空闲期限；有排队、执行或异常接续中的业务时不按空闲关闭。
