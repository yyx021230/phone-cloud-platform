# 支付宝查名 API：先准备，再提交号码

版本：`lookup-readiness-20261016-rc.16`。**实际部署与验收范围以同版本发布回执为准。** 管理员确认部署、探测配置和开放范围后再接入。未调用prepare的旧客户端保留原契约；启动模式按本文接入。

## 1. 调用顺序

| 顺序 | 接口 | 用途 |
|---|---|---|
| 1 | `POST /api/v1/open/name-lookups/prepare` | 启动或读取当前准备进度，body 为 `{}` |
| 2 | `POST /api/v1/open/name-lookups/tasks` | 只传 `phoneNumber`，立即返回 `lookupId` |
| 3 | `GET /api/v1/open/name-lookups/tasks/{lookupId}` | 读取该号码结果，完成后取 `name` |

平台内部完成探测和调度，返回`ready:true`且`status:"ready"`后就可以接单；无需获取或判断设备数量。对接方无需传设备号、账号、探测号码或执行切号。

首次调用 prepare 会为**本客户端**启用新结果格式；不要在同一 clientId 下混用未经升级的旧消费者。未调用 prepare 的其他客户端仍使用旧格式。已经保存的任务ID/请求键不会因模式变化丢失。

## 2. 地址、认证和超时

使用管理员单独交付的 HTTP `BASE_URL`（不含 `/api/v1`）、`clientId` 和独立 `secret`。凭据只放调用方后端环境，不放浏览器、文档、数据库示例或日志。

每次请求携带：

| 请求头 | 值 |
|---|---|
| `X-Client-Id` | 客户端ID |
| `X-Timestamp` | Unix 毫秒时间；默认允许5分钟偏差 |
| `X-Nonce` | 每次HTTP请求新建，8–120字符 `A-Za-z0-9._:-` |
| `X-Signature` | HMAC-SHA256 小写十六进制 |

签名原文为以下5项以4个换行连接，末尾无换行：

```text
UPPERCASE_METHOD
pathname
X-Timestamp
X-Nonce
SHA256(rawBody)
```

pathname 不含域名和查询串。GET 签零字节空串；prepare 签实际发送的两个字节 `{}`；提交签实际发送的 UTF-8 JSON，签名后不再格式化。签名不包含 Idempotency-Key。

两个 POST 额外携带 `Idempotency-Key`，8–160字符 `A-Za-z0-9._:-`。在首次请求**之前持久保存**，重试更新 Nonce/签名但复用业务键。准备轮次键与手机号业务键分别保存。SDK 默认单次HTTP超时30秒，POST同次调用遇到网络错误最多自动重试1次；轮询推荐每5秒一次。

## 3. 启动并等待准备就绪

```http
POST /api/v1/open/name-lookups/prepare
Content-Type: application/json
Idempotency-Key: preparation-20261015-0001

{}
```

示例省略了必需的四个HMAC头。HTTP200：

```json
{"ok":true,"preparationId":"00000000-0000-4000-8000-000000000001","status":"preparing","ready":false,"expiresAt":"2026-10-15T04:00:00.000Z"}
```

用**同一个准备键**再次调用读取进度，不重复探测。当前有效轮次换键也复用同一个 preparationId。`ready:true`、`status:"ready"` 时提交正式号码；只根据这个就绪状态决定是否提交；设备数量、内部阈值和调度进度不对外返回。`ok:true`仅表示接口调用成功，不代表已就绪。

本轮没有未完成业务查询，并连续10分钟没有新受理查询时自动结束。排队、执行、人工等待、恢复和未知执行仍属未完成业务，不会因空闲计时中断；最后一条业务结束后重新计10分钟。只启动未提交业务时，从启动开始计时；后台探测不续期。GET、prepare轮询（含换准备键）、同键重试和命中已有任务/缓存的重提均不续期。空闲到期走安全停止：可能短暂expired，随后stopping，收到手机停止确认才stopped；未确认时不释放占用、不启动下一轮。确认stopped后，由调用方用新的准备键显式启动。已完成结果继续保留。每客户端最多保存1000个准备键，正常轮询复用键不会消耗名额。管理员确认手机号探测授权并设置服务端 `LOOKUP_READINESS_PROBE_PHONE`，缺少配置返回503 `lookup_probe_not_configured`。探测号码应是已知能查到姓名的授权号码；空姓名探测不能算通过。

就绪证明绑定手机、账号、Agent进程、查询会话和本轮准备。掉线、切号、拼图、异常或服务重建后失效；平台重新探测和补位。所有探测均为真实执行，不使用业务结果缓存，也不回填业务数据。每滚动分钟后台最多15次派发、每手机最多2次，相邻至少30秒；失败退避60秒。瞬时预算耗尽时等待下一时隙；无业务空闲10分钟自动结束，后台探测不延长。

确认触限后，先保存8小时冷却并确认旧执行结束，再保留原lookupId把原号码转给另一台已就绪手机。触限手机后台切号、重新探测，通过后才能重新接单；若没有可用手机，原任务在原有期限内排队，不返回假空姓名。切换期间换键重提仍复用原任务；执行是否完成不明时先对账，避免重复执行。已经收到的姓名结果优先保存。

未准备就绪时新的业务提交返回503 `lookup_not_ready`。已经受理的任务继续处理；读取和同号码在途防重仍可用，不用另建业务。准备就绪不保证支付宝之后永不触限或出现新拼图，后续由平台通知、冷却、切号和重新探测。

## 4. 提交号码

每个 `clientId` 默认允许 **20条未完成业务**（平台管理员可调整），可以并发发送10个或20个单号码POST。内部最多5台执行，只有2台就绪时其余请求排队；新手机探测通过后自动接后续任务。排队、执行、等待人工及恢复中的原任务都占名额，后台准备探测不占调用方业务名额。平台按可用手机分配，调用方无需知道手机数量。哪条先完成就先取结果并补下一条，不等整批。

达到配置上限后的新号码返回 HTTP429 `lookup_inflight_limit`，**未创建任务**；等已有任务完成后，保留该号码原业务键重试。相同请求号重试、同号码换请求号的在途合并及有效期内已有结果复用先于名额检查，不会重复查或额外占位。超时不代表任务结束，不要把超时当作名额释放。

```http
POST /api/v1/open/name-lookups/tasks
Content-Type: application/json
Idempotency-Key: partner-business-000001

{"phoneNumber":"13800000001"}
```

示例号码为合成。手机号为中国大陆11位字符串。首次受理HTTP202，复用HTTP200：

```json
{"ok":true,"lookupId":"00000000-0000-4000-8000-000000000002","status":"queued","reused":false}
```

保存 lookupId，再读结果。提交响应不返回姓名。HTTP200也可能只是复用仍在处理的任务，不能当作查名完成。

## 5. 逐条获取结果

```http
GET /api/v1/open/name-lookups/tasks/00000000-0000-4000-8000-000000000002
```

处理过程（HTTP200）：

```json
{"ok":true,"lookupId":"00000000-0000-4000-8000-000000000002","status":"processing"}
```

排队时 status 为 queued。**处理过程中没有 name 字段**，不能填空姓名。拼图/切号/页面恢复等诊断由平台内部处理，不作为第三种姓名结果。

完成且有姓名（HTTP200）：

```json
{"ok":true,"lookupId":"00000000-0000-4000-8000-000000000002","status":"completed","name":"测*"}
```

完成且无姓名，包括未实名（HTTP200）：

```json
{"ok":true,"lookupId":"00000000-0000-4000-8000-000000000002","status":"completed","name":""}
```

只有 completed 才把 name 写入业务系统。姓名为页面实际可见值，可能有掩码，不保证完整实名。空字符串表示本次完成的搜索没有姓名，不证明号码永远未实名。充值入口等空结果需要已探测账号、正确输入、完整稳定结果页、连续两帧一致并排除加载/网络/验证/限制/识别失败才能返回空。

无法完成的服务故障单独返回 `{"ok":false,"lookupId":"…","status":"failed","code":"lookup_processing_timeout"}`，不含 name，不当作空姓名。HTTP200在这里表示成功读到故障记录，不能只看HTTP状态。网络、签名、存储等HTTP错误也不能回填空姓名。

每个号码查完即可取回，不等其他号码。当前无结果Webhook。

## 6. 两分钟超时与重试防重

- 等2分钟没有结果：继续读取原 lookupId；响应丢失时重提**原业务键**。
- 换了请求号但同 clientId、同手机号仍在途或执行未确认结束：复用原 lookupId，不重新排队、不交给另一台重复查询。
- 已完成的有/无姓名结果固定10分钟复用；GET和换键不延长窗口。准备探测结果不参与业务缓存。
- 已保存原键及别名仍指向原业务；任务确认停止后，完成缓存到期或明确失败时，新键可能新建查询。长期同一业务防重仍需保存并复用原键。
- 每任务最多50个新提交别名，结果与键至少保留7天，目前不自动清理。排队默认30分钟，总执行预算60分钟，人工等待30分钟，账号冷却8小时。
- 任务停止尚未确认时保留身份与占用；不把断线当作可重复查询。正常恢复和必要的内部探测由平台控制，对接方不调用 resume/end。

## 7. 常见错误

| HTTP / code | 处理 |
|---|---|
| 400 参数/键格式错误，prepare_body_must_be_empty | 修正参数；prepare只传 `{}` |
| 401/403 认证或用途授权失败 | 核对后端凭据、时钟、签名和授权 |
| 404 任务不存在或不属于该客户端 | 核对客户端和原lookupId |
| 409 idempotency_conflict | 同一业务键不可换号码 |
| 409 lookup_preparation_expired | 保存新准备键启动新轮次 |
| 429 队列/别名/准备键上限 | 有界退避；已有任务继续读取 |
| 503 lookup_not_ready | 调用prepare读取准备进度，暂缓新号码；已有任务保留 |
| 429 lookup_inflight_limit | 已达配置的未完成任务上限（默认20条）；先读取原任务，完成后用原业务键重试新号码 |
| 503 lookup_probe_not_configured / lookup_preparation_capacity | 联系平台检查探测配置与可用容量 |
| 503 lookup_pool_disabled | 管理员尚未开放或暂时关闭设备池 |
| 503 存储异常/断网 | 保留原业务键和lookupId，不能回填空姓名 |

SDK对非2xx抛 OpenNameLookupApiError；GET返回的业务/服务状态由调用方检查。旧客户端未启动prepare时仍返回原 succeeded/not_found/failed；本版SDK和持久示例兼容两种格式。

## 8. SDK示例与部署边界

```js
const prep = await client.prepareLookup({idempotencyKey: savedPreparationKey});
if (prep.ready) {
  const accepted = await client.submitLookup(phone, {idempotencyKey: savedBusinessKey});
  // 保存accepted.lookupId，下轮定时任务读取
}
const result = await client.getLookupResult(savedLookupId);
if (result.ok && result.status === "completed") saveName(result.name);
```

Python对应 `prepare_lookup(idempotency_key=...)`、`submit_lookup(...)`、`get_lookup_result(...)`。下载包含Node/Python SDK、签名、OpenAPI以及SQLite持久示例partner_example.py；示例的prepare、submit、poll是独立执行步骤。回填失败只重读，不重提新业务。

本候选无数据库结构迁移，新增准备信息存入现有受控调度状态。生效需要云端、Windows Agent及执行器成套加载，新增环境配置由平台负责。尚未发布，5模拟设备不等于5真机验收；不把本地测试当作生产可用承诺。原同步query和7个会话接口保留兼容，不用于本流程。

就绪状态会随手机当前情况变化；长时间无查询后平台会要求重新探测。若新提交返回503 lookup_not_ready，保留原业务键，用原准备键读取prepare直至ready后重试；已受理任务继续按原lookupId读取，不能把准备降级当作无姓名。本轮没有未完成业务查询，并连续10分钟没有新受理查询时自动结束。排队、执行、人工等待、恢复和未知执行仍属未完成业务，不会因空闲计时中断；最后一条业务结束后重新计10分钟。只启动未提交业务时，从启动开始计时；后台探测不续期。GET、prepare轮询（含换准备键）、同键重试和命中已有任务/缓存的重提均不续期。空闲到期走安全停止：可能短暂expired，随后stopping，收到手机停止确认才stopped；未确认时不释放占用、不启动下一轮。确认stopped后，由调用方用新的准备键显式启动。已完成结果继续保留。


空闲截止字段：当前空闲截止时间（UTC ISO 8601）；有未完成业务时为null，表示空闲计时暂停。以status和ready判断状态，不把null当已过期。
