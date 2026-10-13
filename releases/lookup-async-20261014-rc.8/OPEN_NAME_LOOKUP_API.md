# 支付宝查名 API：提交号码、获取结果

版本：`lookup-async-20261014-rc.8`。**本地候选，尚未上线**；管理员交付对应环境地址后再联调。本文前六节是新系统接入规范，末尾是旧接口兼容附录。

## 1. 新接入只用两个接口

| 步骤 | 方法与路径 | 用途 |
|---|---|---|
| 提交 | `POST /api/v1/open/name-lookups/tasks` | JSON只传手机号，立即返回`lookupId` |
| 取结果 | `GET /api/v1/open/name-lookups/tasks/{lookupId}` | 按原ID读取状态与姓名 |

调用方保存`lookupId`后，每5秒获取一次结果即可。每个号码独立更新，查到哪个即可读取哪个，不等其余号码完成。设备分配、最多5台并发、切号、冷却和人工处理由平台内部负责；新接入不传设备号、不创建会话、不调用resume/end。目前没有结果Webhook回调。

## 2. 环境与认证

管理员单独交付`BASE_URL`（不含`/api/v1`）、`clientId`、独立`secret`及设备池用途授权；使用交付的HTTP地址。本地候选未发布前，不把原生产地址视为已经开放这两个新接口。凭据只放调用方后端，不写入文档或浏览器。


每次请求携带以下4个头：

| 请求头 | 规则 |
|---|---|
| `X-Client-Id` | 管理员交付的客户端ID，3–80字符`A-Za-z0-9._-` |
| `X-Timestamp` | Unix毫秒字符串；默认允许5分钟时钟偏差 |
| `X-Nonce` | 每次HTTP请求重新生成；8–120字符`A-Za-z0-9._:-` |
| `X-Signature` | HMAC-SHA256小写十六进制 |

签名原文为以下5项用4个换行连接，末尾不追加换行：

```text
UPPERCASE_METHOD
pathname
X-Timestamp
X-Nonce
SHA256(rawBody)
```

`pathname`不含域名、查询串；GET的rawBody为零字节空串；POST必须签实际发送的UTF-8 JSON原文，`{}`也是两个字节。签完不能再格式化JSON。按管理员交付的BASE_URL及协议调用，当前平台使用HTTP；代理保持pathname和请求原文；签名不绑定查询串和`Idempotency-Key`。可直接使用下载包的`sign.mjs`或SDK，两个语言的示例均从服务端环境变量读取凭据。

提交额外携带`Idempotency-Key`，8–160字符`A-Za-z0-9._:-`，在第一次发送前持久保存。它是调用方的业务请求号；`lookupId`是平台返回的稳定任务号。获取结果也需要上述HMAC认证，但不需要幂等键。SDK会封装签名。

## 3. 提交手机号

```http
POST /api/v1/open/name-lookups/tasks
Content-Type: application/json
Idempotency-Key: partner-order-000001
```

以上省略了第2节必需的四个HMAC头。请求体只有业务参数：

```json
{"phoneNumber":"13800000000"}
```

`phoneNumber`为中国大陆11位手机号字符串；示例号码为合成。新受理HTTP202：

```json
{"ok":true,"lookupId":"00000000-0000-4000-8000-000000000001","status":"queued","reused":false}
```

复用已有任务HTTP200，`reused:true`且`lookupId`不变，`status`是该任务当前状态。提交响应不含姓名，继续用获取结果接口。不要根据200判断已经查到姓名。

## 4. 获取结果

```http
GET /api/v1/open/name-lookups/tasks/00000000-0000-4000-8000-000000000001
```

无请求体；HMAC按零字节空串计算。读到记录HTTP200：

```json
{"ok":true,"lookupId":"00000000-0000-4000-8000-000000000001","status":"succeeded","name":"测*","code":""}
```

| status | 含义与处理 |
|---|---|
| `queued` | 排队，继续读取原ID |
| `processing` | 查询、切号、人工等待、恢复或执行状态未知，继续读取原ID |
| `succeeded` | 保存`name`；它是页面实际掩码姓名，不保证完整实名 |
| `not_found` | 本次得到明确无姓名结果；`name`为空，不代表该号码从未实名 |
| `failed` | 本次任务失败，保存`code`；不要当成查到空姓名 |

五种状态均使用`{ok,lookupId,status,name,code}`。`ok:true`仅表示记录读取成功；HTTP认证、网络、存储错误不等于任务`failed`或`not_found`。GET只读原结果，不执行查名、不延长期限；结果回填失败也只重读原ID。

## 5. 两分钟超时与重复提交

调用方等2分钟还没拿到姓名，可以继续读原`lookupId`；如果提交响应丢失，使用原幂等键重新提交。同次SDK提交最多自动重试1次网络错误，业务键不变，每次更新Nonce/签名。

即使对方2分钟后换了请求号，同一`clientId`、同一规范化手机号仍在处理或尚未确认停止，平台也返回原`lookupId`，不重新入队、不把原号码交给另一台重复查。不同客户不会共享结果。

任务已完成为`succeeded/not_found`时，新键在完成后固定10分钟内复用结果；读取和重提不延长窗口。原幂等键和已关联的所有别名仍指向原任务。10分钟后，只有确认原尝试已结束的新键才可新建业务；每任务最多50个提交别名。结果/键至少保留7天，本版不自动清理。**失败且确认停止后，新键也可能新建查询；同一业务永久防重须持续复用已保存原键，不能只依赖10分钟缓存。**

每次HTTP调用默认30秒，两接口即时返回当前状态；此超时不取消平台任务。平台默认未开始排队30分钟、首次受理起总体预算60分钟、人工等待30分钟、账号冷却8小时。预算到期后先停止未完成执行，未确认停止时仍保留原任务，不承诺离线手机硬截止释放。已收到原查询的成功/明确无姓名结果会优先保存，可立即读取；后续停止处理不会覆盖它。已确认无结果并结束的失败历史不自动改写。

## 6. 错误与SDK

HTTP错误体为`{"ok":false,"code":"错误码"}`，完整逐接口错误见OpenAPI。常见处理：

| HTTP | 场景 | 处理 |
|---|---|---|
| 400 | 手机号、幂等键格式错误 | 修正输入 |
| 401/403 | 签名、客户端或用途授权失败 | 核对凭据/权限，保留原业务身份 |
| 404 | 候选接口未启用，或任务不存在/不属于本客户端 | 核对环境、lookupId和clientId |
| 409 | 同一个幂等键对应不同号码 | 修正业务键映射，不覆盖原任务 |
| 429 | 队列或提交别名达上限 | 按Retry-After退避；已有ID继续读结果 |
| 503/断网 | 存储/服务异常或本次响应未知 | 有界退避，提交复用原键，获取复用原ID |

```js
const accepted = await client.submitLookup("13800000000", {idempotencyKey: savedBusinessKey});
// 持久保存accepted.lookupId，下轮定时任务读取
const result = await client.getLookupResult(accepted.lookupId);
if (result.status === "succeeded") console.log(result.name);
```

SDK与可运行的独立提交/结果任务见接入包`README.md`、`PARTNER_HANDOFF.md`和`partner_example.py`。Node/Python默认HTTP实现的每次超时覆盖完整响应体，构造器配置和单次覆盖均有效；提交最多2次HTTP尝试，各有自己的超时预算。GET失败交给下轮读取，503不自动转成新查询。429退避秒数见Node `retryAfterSeconds` / Python `retry_after_seconds`；无有效头为null/None。无效JSON/非对象成功正文抛`invalid_response`，保留原业务键/ID，不回填空姓名。签名及下载哈希随接入包交付。

本候选新增别名表和近期结果索引，发布须先原两表迁移再执行`deploy/sql/20261013-managed-lookup-async.sql`。本地HTTP/数据库/模拟Agent验证不等于生产或五台真机验收；上线和真机测试另行记录。

## 兼容附录A：原同步query

`POST /api/v1/open/name-lookups/query`和SDK `lookupName/lookup_name`保留原同步语义，默认等待120秒、SDK190秒；不提供异步不同键在途合并的承诺。已有异步别名键重放同步入口仍关联原结果。**新接入使用前六节的异步提交＋获取结果。**

## 兼容附录B：原7个会话接口（历史契约）

以下仅供维护已有会话模式集成：`deviceId/sessionId/queryId/clientReference/consentReference`、恢复/结束动作、旧状态和旧错误体都属于该模式，不是新异步接口的参数或处理步骤。历史实测与发布说明保留其原日期，不作为当前候选上线证据。


文档版本：`platform-api-integration-20261012-rc.3`，更新于2026-10-12。业务基线：`platform-api-entry-20261012-deployed.1`。这是2026-10-12的旧会话接口记录，不是当前异步候选的发布回执；新增合作方凭据及联调须另行交付。本说明只描述已有能力，不新增权限。

### 1. 选用正确接口

| 场景 | 路径 | 身份 |
|---|---|---|
| 其他系统接入查名字 | `/api/v1/open/name-lookups/*` | 独立HMAC-SHA256客户端 |
| 平台网页/运营操作 | `/api/v1/user/automation/alipay-name-sessions*` | 平台用户Bearer |

第三方应使用第一行：支持顺序排队、稳定`queryId`、业务引用和幂等重放。平台操作接口返回`jobId/resultId`，只在ready且无在途任务时提交，不能和开放协议混用。HMAC不使用网页登录Token，也不下发控屏凭据。其他业务模块继续使用各自文档中的Bearer身份。

### 2. 管理员交付内容

- 测试/生产根地址`BASE_URL`，当前为`http://47.98.127.132`，不含`/api/v1`。
- `clientId`、至少32字符的独立随机`secret`、精确`deviceId`白名单。
- 客户端映射的已启用普通平台专用用户；不同客户端不能共用该用户名。
- 人工拼图使用的平台操作账号、手机编号映射和飞书通知安排。

新合作方配置不会因本次文档更新自动建立。密钥只留在调用方后端，单独交付，不写入文档、前端或日志。管理员按既有发布流程配置`OPEN_NAME_LOOKUP_API_ENABLED`与`OPEN_NAME_LOOKUP_CLIENTS_JSON`；接口默认关闭，不通过公开HTTP接口分发密钥。接口已存在或未签名请求返回401，不代表新客户端签名、用户映射及白名单已经验收。

### 3. 请求签名

每次请求携带以下4个头：

| 请求头 | 规则 |
|---|---|
| `X-Client-Id` | 管理员交付的客户端ID，3–80字符`A-Za-z0-9._-` |
| `X-Timestamp` | Unix毫秒字符串；默认允许5分钟时钟偏差 |
| `X-Nonce` | 每次HTTP请求重新生成；8–120字符`A-Za-z0-9._:-` |
| `X-Signature` | HMAC-SHA256小写十六进制 |

签名原文为以下5项用4个换行连接，末尾不追加换行：

```text
UPPERCASE_METHOD
pathname
X-Timestamp
X-Nonce
SHA256(rawBody)
```

`pathname`不含域名、查询串；GET的rawBody为零字节空串；POST必须签实际发送的UTF-8 JSON原文，`{}`也是两个字节。签完不能再格式化JSON。按管理员交付的BASE_URL及协议调用，当前平台使用HTTP；代理保持pathname和请求原文；签名不绑定查询串和`Idempotency-Key`。可直接使用下载包的`sign.mjs`或SDK，两个语言的示例均从服务端环境变量读取凭据。

### 4. 幂等与关联

创建会话、提交号码、显式恢复要求`Idempotency-Key`：8–160字符`A-Za-z0-9._:-`。调用前持久保存键与参数；网络重试沿用同键同参数，但重新生成时间戳/Nonce/签名。相同业务重放返回原对象，参数冲突为409。创建键按客户端隔离，查询/恢复按客户端+会话隔离；不同操作使用不同业务键。

提交查询的三个必填字段：

| 字段 | 类型/规则 |
|---|---|
| `phoneNumber` | string；去除非数字后为1开头11位大陆号码 |
| `clientReference` | string；8–160字符`A-Za-z0-9._:-`，关联调用方业务单 |
| `consentReference` | string；同上，关联调用方已有授权记录；公开结果不回传，调用方自行保存 |

`sessionId`标识设备占用会话，`queryId`标识号码结果。恢复始终沿用原queryId，不按数组位置关联号码，不通过重查同一号码验证结果是否已完成。

### 5. 七个开放接口

以下路径均相对BASE_URL；所有请求均需HMAC，POST均发`Content-Type: application/json`。

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /api/v1/open/name-lookups/devices` | 无请求体 | 200 `{devices: LookupDevice[]}` |
| `POST /api/v1/open/name-lookups/sessions` | `{deviceId}`＋创建幂等键 | 新建201、重放200 `{ok, session, idempotent?}` |
| `GET /api/v1/open/name-lookups/sessions/{sessionId}` | 无请求体 | 200 `{session: OpenLookupSession}` |
| `POST /api/v1/open/name-lookups/sessions/{sessionId}/queries` | 三个必填查询字段＋查询幂等键 | 入队202、重放200 `{ok, queryId, session, idempotent?}` |
| `GET /api/v1/open/name-lookups/sessions/{sessionId}/queries/{queryId}` | 无请求体 | 200 `{query: OpenLookupResult}` |
| `POST /api/v1/open/name-lookups/sessions/{sessionId}/resume` | `{queryId}`＋恢复幂等键 | 202、重放200 `{ok, queryId, session, idempotent?}` |
| `POST /api/v1/open/name-lookups/sessions/{sessionId}/end` | `{}`；不要求幂等键 | 停止受理202、已终态200 `{ok, session}` |

设备列表只返回客户端白名单中的已存在设备。`available=true`是瞬时信息，不预留设备，创建仍可能409。`deviceId`为稳定接口标识，页面118这样的编号只用于人工定位。

平台单机串行执行，开放接口可在`starting/ready/querying/switching/choosing_account/needs_human_verification`入队；停止/终态及账户耗尽等阻塞以409和queueState为准。没有API每小时/每日查询配额不代表实际执行无限并发，也不代表绕过上游限制。

创建、入队只表示受理。每2–5秒轮询会话及单结果；目前没有结果Webhook回调。GET会话会在可执行时推进排队查询，不应将它当作完全无业务作用的健康检查。`/end`取消排队项并停止当前项；202后轮询终态，stopping期间不反复POST。结束、失败、过期均不再接收查询。

### 6. 返回字段与结果

完整字段类型和每个接口的参数、响应、错误见接入包`openapi.json`及平台文档的公共模型。

| 模型 | 关键字段 |
|---|---|
| `LookupDevice` | `deviceId/deviceName/available/listed/adbOnline` |
| `OpenLookupSession` | `sessionId/deviceId/status/pending/queuedCount/resultCount/resultsTruncated/successfulCount/currentAccount/results/queueState/humanAction/error/createdAt/updatedAt/endedAt` |
| `OpenLookupResult` | `queryId/clientReference/queuePosition/phoneNumber/status/stage/maskedName/nameTailCharacter/accountSwitched/accountSwitchReason/accountSwitchCount/reason/error/createdAt/updatedAt` |

`phoneNumber`始终脱敏，例如`138****0000`；`maskedName`是页面已有的掩码名，`nameTailCharacter`是可提取的末字，不保证完整实名。`not_found`表示本次未提取到姓名，不能认定号码没有实名。

`successfulCount`包含`succeeded`和`not_found`，不是有姓名条数。`pending`仅表示当前作业存在，还需检查排队数及所有已保存queryId。会话`results`仅最新500条，超出时`resultsTruncated=true`；调用方保存queryId并通过单结果接口补取历史，不能假定平台永久归档。`currentAccount`是当前设备内的脱敏账户展示标识，不是跨设备唯一账号ID。

查询状态：

| 状态 | 调用方动作 |
|---|---|
| `queued/running/cancelling` | 继续轮询原queryId |
| `succeeded` | 保存掩码名、末字及业务关联 |
| `not_found` | 保存本次无姓名结果 |
| `needs_human_verification` | 等人工完成，继续轮询原ID；自动接续优先 |
| `needs_recovery` | 按queueState恢复原查询或结束 |
| `limit_reached/failed/cancelled` | 异常/取消终态，保存原因，不当作姓名结果 |

会话可出现`starting/ready/querying/switching/choosing_account/needs_human_verification/stopping/ended/failed/expired`。不能仅凭ready判断任务全部完成，还要检查humanAction、queueState和原结果状态。

### 7. 拼图、普通恢复、切号与冷却

**真实拼图**：`humanAction.required=true`，type为`manual_jigsaw_verification`。平台按已配置的飞书通知发送“具体手机编号出现拼图，请人工介入到云手机平台实时控制完成拼图”。操作员进入同一手机完成验证；两次新鲜只读证据确认验证消失且搜索页可用后，平台自动结束对应人工控屏并继续原查询和队列。调用方继续轮询，不新建queryId。通知配置与投递故障仍须按平台日志排查。

`humanAction.queryId`为空表示首次账户准备，开放`/resume`不适用；等待自动恢复，准备故障由网页重试账户准备或结束会话。`resumeAllowed=true`仅表示存在可显式恢复的原查询，不是要求立即调用；实际状态可能已自动恢复。显式恢复时活动控屏会409，先重新轮询。

**普通恢复失败**：`humanAction.required=false`且`queueState={status:"paused",action:"retry_current_query",queryId:"原ID",reason:"lookup_human_recovery_failed"}`。对原queryId调用`/resume`并使用恢复专用幂等键；同次HTTP重试沿用该键。一次恢复已结束而再次选择新恢复尝试，应另存新尝试键。恢复不重复识别已验证账户，直接进入搜索路径，不作为拼图提醒。

**账户限制**：只有已确认的`access_denied/device_risk/frequent_or_abnormal_access`触发账户冷却和自动切号，沿用原queryId继续号码。冷却自首次限制时间起8小时，重复回报或新建会话不重置。平台操作视图字段为`limitedAt/cooldownUntil/remainingMs/cooling`；开放会话当前不提供accountCooldowns明细。

**可用账户耗尽**：`queueState.status=paused`且action为`end_session_and_select_another_device`，humanAction.required=false；结束本会话，按自身业务策略选择另一台可用设备。拼图、普通恢复、账户耗尽是三个不同动作，第三方不驱动平台账户切换。

### 8. 错误与超时

错误通常为JSON`{"error":"..."}`，可以附session/detail等字段；没有统一数字业务码。

| HTTP | 典型error | 处理 |
|---|---|---|
| 400 | `invalid_json/invalid_phone_number/invalid_client_reference/invalid_consent_reference/idempotency_key_required/invalid_idempotency_key` | 修正格式或参数 |
| 401 | `open_api_auth_required/invalid_open_api_client/open_api_timestamp_expired/invalid_open_api_nonce/open_api_nonce_replayed/invalid_open_api_signature` | 核对客户端、时钟及原文签名，HTTP重试使用新Nonce |
| 403 | `open_name_lookup_user_not_available/open_name_lookup_device_not_allowed` | 核对专用用户及白名单 |
| 404 | `open_name_lookup_api_not_enabled/lookup_session_not_found/lookup_query_not_found` | 核对环境、资源和所属clientId |
| 409 | `device_busy/device_not_available/lookup_session_already_active/idempotency_conflict` | 读取原状态，修正占用或业务参数 |
| 409 | `lookup_session_not_accepting_queries/lookup_queue_paused_account_switch_required/lookup_screen_control_active/lookup_human_verification_not_resumable/lookup_human_verification_query_mismatch/lookup_startup_human_resume_automatic` | 依会话、队列和人工状态处理，不能盲目换键或重提号码 |
| 5xx/断网 | 服务端或网关错误/结果未知 | 有界退避；先对账，幂等写重试保留原键 |

建议HTTP超时10–30秒，整批业务与人工等待另设总期限。取消/放弃时结束会话并确认释放；记录sessionId/queryId、时间、HTTP/error与服务端响应X-Request-Id用于排障，不记录密钥或完整个人数据。开放查名当前不是一套承诺统一429配额的接口；其他业务的429按其retryAfterSeconds处理。

### 9. SDK使用与交接验收

下载包提供无第三方依赖的Node.js18+、Python3.9+ SDK。它们封装签名、HTTP请求、顺序入队和轮询，不替调用方持久化业务键，不自动保证网络重试或会话清理。`queue_paused`需进一步看action，可能是普通恢复失败，也可能是账号耗尽。`human_action_required`返回后应等待人工/自动接续，不能套用旧版“立即resume”的示例。详见包内README。

双方联调应覆盖：有效/错误签名和Nonce重放；创建及提交同键重放/参数冲突；单号码及顺序队列；超时原ID对账；拼图自动恢复、普通恢复、账户耗尽；停止释放及跨客户端隔离。没有合作方凭据、授权设备和测试号码前不执行真实业务。

**实际验证边界**：118号曾通过57条平台Bearer真实查询，覆盖自然触限切号、冷却继承和真实拼图接续。本轮现有授权HMAC客户端在177/161号完成4条公网HTTP真实查询，验证幂等、队列、原queryId拼图自动接续、飞书提醒及结束释放；不等于新合作方独立凭据/隔离已经验收。正向显式resume、177/161自然触限切号、自然8小时到期、全部账户冷却、长时/OEM仍待验。177首次实名认证弹窗兼容仅为本地候选，未上线。本次不修改业务代码或设备白名单。
