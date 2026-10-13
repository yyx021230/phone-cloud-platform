# 支付宝查名：异步提交与获取结果（本地候选）

版本lookup-async-20261013-rc.1，新增两接口未上线。POST /api/v1/open/name-lookups/tasks，body仅phoneNumber，HMAC/Idempotency-Key在头，立即返回202 {ok:true,lookupId,status:"queued",reused:false}。同键重放、同客户同号码在途或固定完成后10分钟的succeeded/not_found复用200且lookupId不变；新提交键持久关联原业务。GET /api/v1/open/name-lookups/tasks/{lookupId}按客户端隔离只读结果，不再操作手机。

GET成功读取HTTP200 {ok:true,lookupId,status,name,code}。status为queued/processing/succeeded/not_found/failed；ok:true不等于查到姓名，只有succeeded携带页面实际掩码姓名。人工/切号/恢复/未知仍processing，不把空name都当无姓名。HTTP错误体{ok:false,code}，400输入/缺键、401认证、403授权、404不存在或他人任务、409同键异号、429容量/别名限制、503存储/池停用；读取失败不改变任务结果。旧同步与7个会话接口保留。

对方等结果2分钟后重新提交（即使新请求号），平台按同clientId/规范化号码的在途身份返回原lookupId，不重复入队；原task/query/attempt保留。完成和提交竞态在PG短事务中串行处理，近期结果固定从completedAt算10分钟，GET/提交不滑动延长。原键及所有提交别名在幂等保留期内仍指原结果；10分钟结束只允许已确认原尝试结束后的新键新业务。不同客户结果不共享。SDK签名、同次调用网络错误最多重试1次；跨定时轮次推荐首次前持久保存业务键。

两个HTTP调用默认30秒，均即时返回状态；建议5秒轮询并按429 Retry-After退避，提交任务和获取结果定时任务各跑一轮结束。候选默认未开始排队30分钟、首次受理起总体执行预算60分钟，人工作业等待30分钟；到预算先请求停止，确认前保留预约/processing，离线未知不承诺硬截止放锁。每原业务最多50提交别名；结果/键至少7天，本版不自动清理。冷却保持8小时，GET/重提不延长或重置。两分钟是调用方等待预算，不能将其当平台任务作废。

新模式仍内部49登记编号/最多5自动执行；需管理员显式用途授权与逐台稳定设备映射。异步aliases新增表和近期结果索引见deploy/sql/20261013-managed-lookup-async.sql，先原两表迁移再新增迁移，仅在隔离PG验证。本轮不连接生产、不调用真机或飞书。旧rc.4的真机/Windows依赖/五机/自然切号到期缺口保持。

## 同步query（兼容）

POST /api/v1/open/name-lookups/query仍保持原120秒默认等待、SDK190秒及成功{name}/明确not_found/非200错误语义；它不套用新异步“不同键合并”的接入规则。新模式的别名键若重放同步入口，仍关联原canonical结果，不能变成新查号。下方原7接口文档是历史契约，不能当异步状态字段说明。

## 原7接口会话模式（兼容）

以下保留原模式契约和历史验收记录；不代表新设备池模式已经上线。新接入优先使用上面的同步接口和接入包README。

# 支付宝查名字：第三方 Open API 接入规范

文档版本：`platform-api-integration-20261012-rc.3`，更新于2026-10-12。业务基线：`platform-api-entry-20261012-deployed.1`。业务已上线，本文按当前接口与实测证据更新；新增合作方凭据及联调须另行交付。本说明只描述已有能力，不新增权限。

## 1. 选用正确接口

| 场景 | 路径 | 身份 |
|---|---|---|
| 其他系统接入查名字 | `/api/v1/open/name-lookups/*` | 独立HMAC-SHA256客户端 |
| 平台网页/运营操作 | `/api/v1/user/automation/alipay-name-sessions*` | 平台用户Bearer |

第三方应使用第一行：支持顺序排队、稳定`queryId`、业务引用和幂等重放。平台操作接口返回`jobId/resultId`，只在ready且无在途任务时提交，不能和开放协议混用。HMAC不使用网页登录Token，也不下发控屏凭据。其他业务模块继续使用各自文档中的Bearer身份。

## 2. 管理员交付内容

- 测试/生产根地址`BASE_URL`，当前为`http://47.98.127.132`，不含`/api/v1`。
- `clientId`、至少32字符的独立随机`secret`、精确`deviceId`白名单。
- 客户端映射的已启用普通平台专用用户；不同客户端不能共用该用户名。
- 人工拼图使用的平台操作账号、手机编号映射和飞书通知安排。

新合作方配置不会因本次文档更新自动建立。密钥只留在调用方后端，单独交付，不写入文档、前端或日志。管理员按既有发布流程配置`OPEN_NAME_LOOKUP_API_ENABLED`与`OPEN_NAME_LOOKUP_CLIENTS_JSON`；接口默认关闭，不通过公开HTTP接口分发密钥。接口已存在或未签名请求返回401，不代表新客户端签名、用户映射及白名单已经验收。

## 3. 请求签名

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

## 4. 幂等与关联

创建会话、提交号码、显式恢复要求`Idempotency-Key`：8–160字符`A-Za-z0-9._:-`。调用前持久保存键与参数；网络重试沿用同键同参数，但重新生成时间戳/Nonce/签名。相同业务重放返回原对象，参数冲突为409。创建键按客户端隔离，查询/恢复按客户端+会话隔离；不同操作使用不同业务键。

提交查询的三个必填字段：

| 字段 | 类型/规则 |
|---|---|
| `phoneNumber` | string；去除非数字后为1开头11位大陆号码 |
| `clientReference` | string；8–160字符`A-Za-z0-9._:-`，关联调用方业务单 |
| `consentReference` | string；同上，关联调用方已有授权记录；公开结果不回传，调用方自行保存 |

`sessionId`标识设备占用会话，`queryId`标识号码结果。恢复始终沿用原queryId，不按数组位置关联号码，不通过重查同一号码验证结果是否已完成。

## 5. 七个开放接口

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

## 6. 返回字段与结果

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

## 7. 拼图、普通恢复、切号与冷却

**真实拼图**：`humanAction.required=true`，type为`manual_jigsaw_verification`。平台按已配置的飞书通知发送“具体手机编号出现拼图，请人工介入到云手机平台实时控制完成拼图”。操作员进入同一手机完成验证；两次新鲜只读证据确认验证消失且搜索页可用后，平台自动结束对应人工控屏并继续原查询和队列。调用方继续轮询，不新建queryId。通知配置与投递故障仍须按平台日志排查。

`humanAction.queryId`为空表示首次账户准备，开放`/resume`不适用；等待自动恢复，准备故障由网页重试账户准备或结束会话。`resumeAllowed=true`仅表示存在可显式恢复的原查询，不是要求立即调用；实际状态可能已自动恢复。显式恢复时活动控屏会409，先重新轮询。

**普通恢复失败**：`humanAction.required=false`且`queueState={status:"paused",action:"retry_current_query",queryId:"原ID",reason:"lookup_human_recovery_failed"}`。对原queryId调用`/resume`并使用恢复专用幂等键；同次HTTP重试沿用该键。一次恢复已结束而再次选择新恢复尝试，应另存新尝试键。恢复不重复识别已验证账户，直接进入搜索路径，不作为拼图提醒。

**账户限制**：只有已确认的`access_denied/device_risk/frequent_or_abnormal_access`触发账户冷却和自动切号，沿用原queryId继续号码。冷却自首次限制时间起8小时，重复回报或新建会话不重置。平台操作视图字段为`limitedAt/cooldownUntil/remainingMs/cooling`；开放会话当前不提供accountCooldowns明细。

**可用账户耗尽**：`queueState.status=paused`且action为`end_session_and_select_another_device`，humanAction.required=false；结束本会话，按自身业务策略选择另一台可用设备。拼图、普通恢复、账户耗尽是三个不同动作，第三方不驱动平台账户切换。

## 8. 错误与超时

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

## 9. SDK使用与交接验收

下载包提供无第三方依赖的Node.js18+、Python3.9+ SDK。它们封装签名、HTTP请求、顺序入队和轮询，不替调用方持久化业务键，不自动保证网络重试或会话清理。`queue_paused`需进一步看action，可能是普通恢复失败，也可能是账号耗尽。`human_action_required`返回后应等待人工/自动接续，不能套用旧版“立即resume”的示例。详见包内README。

双方联调应覆盖：有效/错误签名和Nonce重放；创建及提交同键重放/参数冲突；单号码及顺序队列；超时原ID对账；拼图自动恢复、普通恢复、账户耗尽；停止释放及跨客户端隔离。没有合作方凭据、授权设备和测试号码前不执行真实业务。

**实际验证边界**：118号曾通过57条平台Bearer真实查询，覆盖自然触限切号、冷却继承和真实拼图接续。本轮现有授权HMAC客户端在177/161号完成4条公网HTTP真实查询，验证幂等、队列、原queryId拼图自动接续、飞书提醒及结束释放；不等于新合作方独立凭据/隔离已经验收。正向显式resume、177/161自然触限切号、自然8小时到期、全部账户冷却、长时/OEM仍待验。177首次实名认证弹窗兼容仅为本地候选，未上线。本次不修改业务代码或设备白名单。
