# 第三方验证码接口

本接口用于第三方平台请求验证码，不使用网页登录态。调用方必须配置独立的 `clientId/secret` 并对每个请求签名。

旧 `/api/v1/third-party/sms-orders` 仅作为兼容接口保留。新平台、新客户、新渠道一律接入本签名接口。

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
X-Nonce: nonce-随机字符串
X-Signature: hex(hmac_sha256)
Idempotency-Key: 可选，创建请求时建议传
```

`X-Timestamp` 是毫秒时间戳。默认允许 5 分钟误差。

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
  "phoneNumber": "17570049665",
  "platform": "小红书"
}
```

返回：

```json
{
  "ok": true,
  "request": {
    "requestId": "uuid",
    "status": "waiting",
    "code": "",
    "phoneNumber": "175****9665",
    "expiresAt": "..."
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

## 可见范围

- 普通用户和第三方调用方只能读取自己请求命中的验证码短信。
- 返回正文默认脱敏，只保留验证码、发送方、命中时间和请求状态。
- 管理员完整查询短信库会写审计日志。

## 稳定错误码

- `unauthorized`：签名错误、时间戳过期或 nonce 重放。
- `phone_not_available`：目标号码当前不可用或设备未上架。
- `device_not_published`：指定设备未发布到用户端。
- `sms_order_not_found`：请求不存在或不属于当前 client。
- `idempotency_conflict`：幂等键重复但请求参数不一致。

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

## 防重放和幂等

- 同一个 `X-Nonce` 在有效窗口内只能使用一次。
- 创建请求建议传 `Idempotency-Key`，重复提交会返回同一个 request。
- 签名失败、时间戳过期、nonce 重放都会返回 401。
