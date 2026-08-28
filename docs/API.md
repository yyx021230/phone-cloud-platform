# Phone Cloud API

当前可交付主功能：

- 短信验证码：第三方平台创建等待订单，平台匹配订单开始后新增的第一条短信。
- 小红书扫码：用户上传二维码，Windows 管理器通过 Airtest/Poco 执行图库扫码。

除登录接口外，请求使用以下任一认证方式：

```http
Authorization: Bearer <token>
```

或：

```http
x-api-key: <token>
```

普通用户前端使用登录会话 token。第三方系统必须优先使用签名 Open API，不建议用网页登录态或管理员 token 对接。

## 登录

```http
POST /api/v1/auth/login
Content-Type: application/json
```

```json
{
  "username": "demo_user",
  "password": "replace-with-user-password"
}
```

响应：

```json
{
  "ok": true,
  "session": {
    "token": "..."
  },
  "user": {
    "userId": "...",
    "username": "demo_user",
    "role": "user"
  }
}
```

## 查询可用手机

普通用户网页使用：

```http
GET /api/v1/user/devices
```

返回设备卡片、SIM、短信数量、小红书账号槽位、自动化状态等信息。设备是否在线以 ADB 状态为主。

## 第三方验证码订单

推荐入口见 [OPEN_SMS_API.md](./OPEN_SMS_API.md)：`POST /api/v1/open/sms-code-requests`。

### Deprecated: 旧兼容创建订单

旧接口仍保留兼容，但新第三方不要接入：

```http
POST /api/v1/third-party/sms-orders
Content-Type: application/json
```

按手机号创建：

```json
{
  "phoneNumber": "17570049665",
  "platform": "小红书"
}
```

按设备和 SIM 创建：

```json
{
  "deviceId": "adb:10AF420R0900B1C",
  "slotIndex": 0,
  "platform": "第三方平台"
}
```

字段说明：

- `phoneNumber`：目标手机号。可省略国家码，平台会归一化。
- `deviceId`：指定某一台手机。
- `slotIndex`：指定 SIM 卡槽，通常 `0` 为 SIM 1，`1` 为 SIM 2。
- `subscriptionId`：Android 短信库中的 `sub_id`，有些机型可用于更精确区分 SIM。
- `platform`：业务来源标签，仅用于展示和部分非 `first_new_sms` 匹配模式。

响应：

```json
{
  "ok": true,
  "order": {
    "orderId": "019...",
    "deviceId": "adb:10AF420R0900B1C",
    "phoneNumber": "17570049665",
    "slotIndex": 0,
    "platform": "小红书",
    "matchMode": "first_new_sms",
    "status": "waiting",
    "code": "",
    "createdAt": "2026-06-24T...",
    "startedAt": "2026-06-24T...",
    "expiresAt": "2026-06-24T..."
  }
}
```

匹配规则：

- 订单创建后进入 `waiting`。
- Windows 管理器默认不轮询全部手机短信。用户打开短信库或主动刷新时，平台向对应设备下发一次增量同步任务。
- 平台只匹配 `startedAt` 到 `expiresAt` 窗口内新增的短信。
- 默认 `matchMode` 为 `first_new_sms`，命中该设备/SIM/手机号下第一条新增短信。
- 如果短信正文能识别验证码，`code` 返回验证码；否则订单仍可能命中短信，`body` 返回原文。

### 查询订单

```http
GET /api/v1/third-party/sms-orders/{orderId}
```

响应状态：

- `waiting`：等待短信。
- `received`：已匹配到短信。
- `cancelled`：用户取消。
- `expired`：等待超时。

收到验证码示例：

```json
{
  "order": {
    "orderId": "019...",
    "status": "received",
    "code": "135452",
    "sender": "10685250260428",
    "body": "【小红书】您的验证码是...",
    "matchedAt": "2026-06-24T..."
  }
}
```

建议第三方轮询间隔：`3-5` 秒。验证码请求会触发目标设备短信同步，不需要第三方高频轮询。

## 用户短信库

```http
GET /api/v1/user/devices/{deviceId}/sms-library?limit=20&offset=0&q=135452&codeOnly=true
```

普通用户可查看已上架手机的完整本机短信库。管理员通过上架/下架控制哪些手机对用户可见；未上架设备不会出现在用户端。

用户侧短信字段：

- `visibility`：`device_sms_library`，表示来自该手机本机短信库。
- `redacted`：`false`，用户端展示完整短信内容。
- `messageAt`、`address`、`phoneNumber`、`body`、`code`：短信时间、发送方、SIM 号码、正文和识别到的验证码。

## 小红书扫码任务

### 创建任务

```http
POST /api/v1/user/xhs/qr-scan-tasks
Content-Type: application/json
```

```json
{
  "deviceId": "adb:10AF420R0900B1C",
  "xhsAppSlot": "app1",
  "qrImageDataUrl": "data:image/png;base64,..."
}
```

字段说明：

- `deviceId`：可选。不传时平台自动选择可用设备。
- `xhsAppSlot`：`app1` 或 `app2`，对应后台给设备配置的小红书账号槽位。
- `qrImageDataUrl`：PNG、JPEG 或 WebP，默认最大 3MB。

响应：

```json
{
  "ok": true,
  "task": {
    "taskId": "019...",
    "platform": "小红书",
    "xhsAppSlot": "app1",
    "xhsAccountLabel": "小红书",
    "xhsAccountName": "全国新车团购",
    "executionMode": "windows_airtest_poco",
    "windowsTaskId": "019...",
    "agentId": "local-mac-windows-agent",
    "adbSerial": "10AF420R0900B1C",
    "status": "queued",
    "summary": {
      "latestEvent": "...",
      "eventCount": 0,
      "screenshotCount": 0
    }
  }
}
```

### 查询任务

```http
GET /api/v1/user/xhs/qr-scan-tasks
```

任务状态：

- `queued`：已创建，等待 Windows 管理器领取。
- `running`：Windows 管理器执行中。
- `stalled`：Windows 管理器离线或任务暂时不可执行，等待恢复。
- `succeeded`：已到达或完成登录确认流程。
- `failed`：执行失败，查看 `result` 和 `summary.latestEvent`。
- `cancelled`：用户取消。
- `expired`：任务超时回收。

常见稳定错误码：

- `device_busy`：该手机已有扫码任务占用。
- `account_slot_busy`：该账号槽位已有扫码任务占用。
- `device_not_published`：设备未上架到用户端。
- `account_not_configured`：设备未配置对应平台账号槽位。
- `device_automation_not_ready`：后台预检未通过。

## 自动化中心：一键发布

创建小红书图文发布任务：

```http
POST /api/v1/user/automation/xhs-publish-tasks
Content-Type: application/json
```

```json
{
  "deviceId": "adb:10AF420R0900B1C",
  "xhsAppSlot": "app1",
  "title": "标题",
  "content": "正文",
  "imageDataUrls": ["data:image/png;base64,..."]
}
```

- `imageDataUrls`：1–5 张 PNG、JPEG 或 WebP；单张默认最大 3MB。
- `xhsAppSlot`：`app1` 或 `app2`，分别对应小红书 I/II。
- 成功终点不是“已进入编辑页”，而是已点击最终发布并确认编辑页关闭或出现成功状态。

查询与取消：

```http
GET  /api/v1/user/automation/xhs-publish-tasks
POST /api/v1/user/automation/xhs-publish-tasks/{jobId}/cancel
```

## 自动化中心：支付宝查名字

开始会话：

```http
POST /api/v1/user/automation/alipay-name-sessions
Content-Type: application/json

{"deviceId":"adb:10AF420R0900B1C"}
```

会话开始后会打开支付宝并停留在全局搜索页。后续查询复用当前页面，不重启支付宝：

```http
POST /api/v1/user/automation/alipay-name-sessions/{sessionId}/queries
Content-Type: application/json

{"phoneNumber":"13800138000"}
```

查询发生 Poco RPC、元素、输入回读或页面状态异常时，才切换 XML UIAutomator 完整重建搜索路径并重放同一号码，最多恢复 2 次。Poco 在稳定搜索页二次提交后仍没有姓名结果时，直接返回 `not_found`，不进入 XML；该号码计入每账号 200 次查询额度。每累计完成 200 个号码，下一次查询前自动切换一个已保存的支付宝账号。

如果支付宝同时出现“为保障您的正常访问请进行验证”和“向右滑动验证”，Poco 会根据真实滑轨元素边界执行最多 3 次有界拖动，验证消失后自动重放当前号码，号码重放最多 2 次。只有元素证据不完整、3 次拖动仍未通过或重放仍失败时，任务才返回 `alipay_human_verification_required`；会话保持 `ready` 并继续占用原手机，用户可人工完成验证后重试同一号码。

`alipay_name_start`、`alipay_name_query` 和 `alipay_name_stop` 不改变设备库存，因此完成后不会强制触发百台设备全量扫描；Agent 的正常周期扫描和其他任务原有的完成后扫描保持不变。

查名字会话使用独立 1 秒状态刷新，不与扫码任务、发布任务接口组成同一个 `Promise.all`；查询中返回服务器阶段与已用时间，完成后返回实际 `durationMs`。

查询会话与结束接口：

```http
GET  /api/v1/user/automation/alipay-name-sessions
POST /api/v1/user/automation/alipay-name-sessions/{sessionId}/end
```

会话状态：`starting`、`ready`、`querying`、`stopping`、`ended`、`failed`、`expired`。只有 `ready` 且没有 `pendingJobId` 时才能提交下一个号码；结束、失败或过期会释放设备锁。

## 管理员运维接口

### 设备锁

```http
GET /api/v1/device-locks
POST /api/v1/device-locks/{lockId}/release
```

用于查看扫码占用锁、归属用户、任务 ID、过期时间。手动释放会取消关联任务，避免异常锁长期阻塞设备。

### 运维指标

```http
GET /api/v1/metrics/operations
```

返回队列状态、活跃锁、失败原因排行、近 10 分钟异常、短信同步停滞设备和 Agent 在线状态。

### 取消任务

```http
POST /api/v1/user/xhs/qr-scan-tasks/{taskId}/cancel
```

取消后，关联 Windows task 会同步取消；设备端迟到的成功或失败状态不会覆盖终态。

## 运维接口

健康检查：

```http
GET /healthz
GET /readyz
```

管理员诊断：

```http
GET /api/v1/diagnostics
```

管理员手动清理：

```http
POST /api/v1/maintenance/prune
Content-Type: application/json
```

```json
{
  "dryRun": true
}
```
