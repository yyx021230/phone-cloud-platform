# 支付宝查名字 · 三个接入接口

文档版本：lookup-public-docs-20261016-rc.1。基础地址由平台提供，当前使用 HTTP。
业务参数只需手机号。设备、账号、排队和人工验证由平台内部处理。

| 顺序 | 方法和路径 | 参数 |
|---|---|---|
| 1. 启动准备 | POST /api/v1/open/name-lookups/prepare | `{}` |
| 2. 提交手机号 | POST /api/v1/open/name-lookups/tasks | `{"phoneNumber":"13800000000"}` |
| 3. 获取结果 | GET /api/v1/open/name-lookups/tasks/{lookupId} | 提交返回的 lookupId |

## 1. 启动准备

首次调用前保存准备键（Idempotency-Key），请求体为 `{}`。每5秒用同一准备键读取，直到 `ready:true`。

```json
{"ok":true,"preparationId":"00000000-0000-4000-8000-000000000001","status":"ready","ready":true,"expiresAt":"2026-10-16T04:30:00.000Z"}
```

`preparing` 表示准备中；`ready` 且 `ready:true` 才可提交手机号。每轮固定30分钟，轮询不延长；`expired` 后保存新准备键再调用。准备状态可能因设备不可用而降级，已有查询仍按原 ID 获取结果。

## 2. 提交手机号

请求体只含 `phoneNumber`。首次提交前保存独立的业务键（Idempotency-Key），与准备键分开。

```json
{"phoneNumber":"13800000000"}
```

HTTP 200 或 202：

```json
{"ok":true,"lookupId":"00000000-0000-4000-8000-000000000002","status":"queued","reused":false}
```

保存 lookupId。`reused:true` 表示复用原任务，并未新增一次查询。默认最多20条未完成请求，可并发提交10个或20个单号码请求；平台自动排队。超过额度返回429且不创建任务，保留原业务键稍后重试。

## 3. 获取结果

每5秒 GET 原 lookupId。每条完成立即返回，不等待整批。

```json
{"ok":true,"lookupId":"00000000-0000-4000-8000-000000000002","status":"completed","name":"**某"}
```

没名字或未实名：

```json
{"ok":true,"lookupId":"00000000-0000-4000-8000-000000000002","status":"completed","name":""}
```

姓名是页面实际显示值，可能带掩码。只有 completed 才保存 name。

| status | 处理 |
|---|---|
| queued / processing | 继续读取；没有 name，不能先填空 |
| completed | 保存 name，可能为空字符串 |
| failed | 执行异常，返回 ok:false 和 code，没有 name；保留原 ID 排查 |

## 超时、重试与重复请求

- 等待2分钟超时不会取消原任务。继续按原 lookupId 获取结果。
- 没收到提交响应时，使用原业务键重试；每次请求更新 Nonce/签名。
- 同一客户同一手机号仍在处理中，换业务键重提也会返回原 lookupId。
- 完成结果可复用10分钟；此后新业务键可能发起新查询，所以已有结果应继续 GET 原 ID。
- 429 lookup_inflight_limit：等待已有任务完成，再用原业务键重试。
- 503 lookup_not_ready：重新读取 prepare，ready 后用原业务键提交；已受理任务照常按原 ID 获取。
- HTTP错误和网络超时不是“没有名字”。不要据此写入空字符串。

## 认证

平台单独提供 BASE_URL、clientId、secret。只放在调用方后端环境变量，推荐直接使用包内 SDK。
所有请求携带 X-Client-Id、X-Timestamp（Unix毫秒）、X-Nonce、X-Signature。
签名原文为以下5行，末尾没有换行：

```text
UPPERCASE_METHOD
pathname
X-Timestamp
X-Nonce
SHA256(rawBody)
```

用 secret 对原文计算 HMAC-SHA256，小写十六进制作为 X-Signature。pathname 不含域名或查询串；GET 的 rawBody 为零字节；POST 对实际发送的 UTF-8 JSON 签名，签名后不要改格式。X-Nonce 每次更新（8–120字符，字母/数字/点/下划线/冒号/短横线）；两个 POST 的 Idempotency-Key 为8–160个同类字符，首次发送前持久保存，重试复用。时间戳默认允许5分钟偏差。

SDK 的请求超时默认30秒；POST网络失败最多自动再试1次且保留原键。SDK不会代替业务系统持久保存请求ID，也不会把HTTP成功当成查询完成。

## Node.js 示例

```js
import { OpenNameLookupClient } from './node_client.mjs';
const client = new OpenNameLookupClient({
  baseUrl: process.env.BASE_URL,
  clientId: process.env.CLIENT_ID,
  secret: process.env.CLIENT_SECRET
});
// 准备任务：使用已保存的准备键，每5秒读取，直到ready:true。
const ready = await client.prepareLookup({ idempotencyKey: savedPreparationKey });
// 提交任务：确认ready后只发送手机号。业务键已提前保存。
if (ready.ready) {
  const accepted = await client.submitLookup('13800000000', { idempotencyKey: savedBusinessKey });
  persistLookupId(accepted.lookupId);
}
// 结果任务：独立执行，每5秒按保存的ID读取。
const result = await client.getLookupResult(savedLookupId);
if (result.status === 'completed') saveName(result.name);
```

## Python 示例

```python
from python_client import OpenNameLookupClient
client = OpenNameLookupClient(base_url=base_url, client_id=client_id, secret=secret)
ready = client.prepare_lookup(idempotency_key=saved_preparation_key)
if ready['ready']:
    accepted = client.submit_lookup('13800000000', idempotency_key=saved_business_key)
    persist_lookup_id(accepted['lookupId'])
# 另一个定时任务读取已保存ID。
result = client.get_lookup_result(saved_lookup_id)
if result['status'] == 'completed':
    save_name(result['name'])
```

示例中的保存函数由接入系统实现。数据库回填失败时继续按原 ID 获取，不再提交手机号。
