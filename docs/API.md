# Phone Cloud API

当前可交付主功能：

- 短信验证码：第三方平台创建等待订单，平台匹配有效时间内同平台、同设备/安全 SIM 目标的数字验证码；普通短信不消费订单。抖音识别为 2026-09-08 本地候选，尚未部署，见 `OPEN_SMS_API.md`。
- 小红书扫码：用户上传二维码，Windows 管理器通过 Airtest/Poco 执行图库扫码。
- 支付宝查名字：外部系统使用独立 HMAC 客户端创建长会话、逐个提交已获授权的号码、轮询结果，并在人工拼图后恢复同一个号码，见 [OPEN_NAME_LOOKUP_API.md](./OPEN_NAME_LOOKUP_API.md)；不希望自行实现签名和轮询时可使用仓库内 [Node.js/Python 客户端](../sdk/open_name_lookup/README.md)。该接口已随 `20260909-open-name-queue-v2` 部署生产，默认关闭，仅对配置的客户端和精确设备白名单启用。

除登录接口和单独使用 HMAC 的 `/api/v1/open/sms-code-requests`、`/api/v1/open/name-lookups` 系列外，请求使用以下任一认证方式：

```http
Authorization: Bearer <token>
```

或：

```http
x-api-key: <token>
```

普通用户前端使用登录会话 token。第三方系统必须优先使用签名 Open API，不建议用网页登录态或管理员 token 对接。

## 第三方支付宝查名字

外部接入统一从 [OPEN_NAME_LOOKUP_API.md](./OPEN_NAME_LOOKUP_API.md) 开始。标准流程为：查询白名单设备 → 创建长会话 → 连续提交多个号码进入队列 → 平台按入队顺序单机串行查询 → 账号受限时由查询脚本自动切换已保存账号并继续原号码 → 遇拼图才暂停整个队列并由映射的平台用户人工控屏处理 → 对原 `queryId` 调用恢复 → 自动继续后续队列 → 结束会话。接口不设置小时、每日或单会话查询次数配额；外部接口不签发控屏凭据、不自动破解拼图，也不允许跳过 `consentReference`。

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

抖音适配后继续使用上述签名接口，创建时显式传 `platform: "抖音"`（兼容 `douyin`），小红书传 `platform: "小红书"`。查询与取消地址、鉴权和响应包装不变；不是新增抖音扫码能力。当前为本地候选，不代表线上已生效。

### Deprecated: 旧兼容创建订单

旧接口仍保留兼容，但新第三方不要接入：

```http
POST /api/v1/third-party/sms-orders
Content-Type: application/json
```

按手机号创建：

```json
{
  "phoneNumber": "13800000013",
  "platform": "小红书"
}
```

按设备和 SIM 创建：

```json
{
  "deviceId": "adb:TESTDEVICE0003",
  "slotIndex": 0,
  "platform": "第三方平台"
}
```

字段说明：

- `phoneNumber`：目标手机号。可省略国家码，平台会归一化。
- `deviceId`：指定某一台手机。
- `slotIndex`：指定 SIM 卡槽，通常 `0` 为 SIM 1，`1` 为 SIM 2。
- `subscriptionId`：Android 短信库中的 `sub_id`，有些机型可用于更精确区分 SIM。
- `platform`：来源匹配条件，显式传目标平台；`第三方平台` 不是通配符。旧兼容接口也必须经过安全验证码匹配器。

响应：

```json
{
  "ok": true,
  "order": {
    "orderId": "019...",
    "deviceId": "adb:TESTDEVICE0003",
    "phoneNumber": "13800000013",
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
- 等待订单为绑定设备调度轻量 `sms_code_probe`；同时保留既有 Provider 增量同步和默认短信应用通知补全。用户主动刷新是全量对账，不改变后台增量游标语义。
- 平台只匹配 `startedAt` 到 `expiresAt` 窗口内新增的短信。
- `matchMode` 虽保留 `first_new_sms` 兼容值，但不能绕过平台与验证码校验；只消费符合来源、设备、号码、安全 SIM 规则及时间窗的有效 4–8 位数字验证码。
- 普通提醒、营销通知、来源不明、其他平台验证码和掩码/无效验证码保持未匹配，订单继续等待。Open API 返回最外层 `request`；本节旧兼容接口返回 `order`。

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
  "deviceId": "adb:TESTDEVICE0003",
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
    "adbSerial": "TESTDEVICE0003",
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
  "deviceId": "adb:TESTDEVICE0003",
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

{"deviceId":"adb:TESTDEVICE0003"}
```

会话开始后会打开支付宝并停留在全局搜索页。后续查询复用当前页面，不重启支付宝：

```http
POST /api/v1/user/automation/alipay-name-sessions/{sessionId}/queries
Content-Type: application/json

{"phoneNumber":"13800000008"}
```

查询发生 Poco RPC、元素、输入回读或页面状态异常时，才切换 XML UIAutomator 完整重建搜索路径并重放同一号码，最多恢复 2 次。Poco 在稳定搜索页没有姓名结果时直接返回 `not_found`，不进入 XML。平台不再按成功次数自动切换支付宝账号。

当号码查询后精确出现“访问被拒绝”“拼图限制”“设备风险”或“操作频繁/访问异常”时，任务返回 `limit_reached`，会话保持 `ready`，并设置 `requiresAccountSwitch=true` 与具体 `limitReason`。查询开始前已经存在的风险页不会被误判为该号码触发的上限；未覆盖页面按普通失败保留诊断，不冒充查询上限。

手动切换到下一个已保存账号：

```http
POST /api/v1/user/automation/alipay-name-sessions/{sessionId}/switch-account
Content-Type: application/json

{}
```

切号脚本通过账号列表的精确账号元素和“当前”标记识别当前账号，按稳定轮转顺序选择下一账号；切换后重新打开账号列表复核“当前”标记，再回到搜索页。结果返回脱敏的 `currentAccount` 及本次 `fromAccount/toAccount` 诊断。账号只有一个、元素不唯一或复核不一致时任务失败，不盲点坐标。

如果支付宝同时出现“为保障您的正常访问请进行验证”和“向右滑动验证”，Poco 会根据真实滑轨元素边界执行最多 3 次有界拖动，验证消失后自动重放当前号码，号码重放最多 2 次。只有元素证据不完整、3 次拖动仍未通过或重放仍失败时，任务才返回 `alipay_human_verification_required`；会话保持 `ready` 并继续占用原手机，用户可人工完成验证后重试同一号码。

`alipay_name_start`、`alipay_name_query`、`alipay_name_switch` 和 `alipay_name_stop` 不改变设备库存，因此完成后不会强制触发百台设备全量扫描；Agent 的正常周期扫描和其他任务原有的完成后扫描保持不变。

查名字会话使用独立 1 秒状态刷新，不与扫码任务、发布任务接口组成同一个 `Promise.all`；查询中返回服务器阶段与已用时间，完成后返回实际 `durationMs`。

查询会话与结束接口：

```http
GET  /api/v1/user/automation/alipay-name-sessions
POST /api/v1/user/automation/alipay-name-sessions/{sessionId}/end
```

会话状态：`starting`、`ready`、`querying`、`switching`、`stopping`、`ended`、`failed`、`expired`。只有 `ready` 且没有 `pendingJobId` 时才能查询或手动切号；结束、失败或过期会释放设备锁。

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

### 投屏媒体热策略

```http
GET /api/v1/admin/screen-transport-policy
PUT /api/v1/admin/screen-transport-policy
Content-Type: application/json
```

该接口同时管理投屏源端编码与 RTP 传输参数。`GET` 返回当前 `policy`、最近 20 个历史版本、可写字段 `fields` 和 `appliesTo=new_screen_sessions`。`PUT` 必须带当前 `expectedRevision`；版本不一致返回 `409 screen_transport_policy_revision_conflict`。策略只在创建新投屏会话时下发，已经运行的投屏不会中途重建编码器。

```json
{
  "expectedRevision": 7,
  "policy": {
    "defaults": {
      "mediaTransport": "webrtc",
      "maxSize": 960,
      "maxFps": 40,
      "videoBitRate": 1500000,
      "encoderBitrateMode": 2,
      "iFrameIntervalSeconds": 1,
      "realtimeQueueLatencyMs": 400,
      "transportPacingBitRate": 10000000,
      "transportPacketsPerBurst": 2
    },
    "devices": {
      "ADB_SERIAL": {
        "mediaTransport": "direct_webrtc",
        "videoEncoder": "c2.android.avc.encoder",
        "sourceRecoveryEnabled": true,
        "sourceRecoveryMaxAttempts": 4,
        "sourceRecoveryWindowSeconds": 45,
        "viewerKeyframeResetEnabled": true,
        "keyframeRecoveryCooldownMs": 2000
      }
    }
  }
}
```

`mediaTransport` 只允许 `webrtc` 或 `direct_webrtc`。后者绕过 MediaMTX 的第二跳，让浏览器的 NACK/PLI 直接到 Windows Pion 发布器并使用 RTX 修复丢包；生产环境必须先配置可用 TURN 和短期凭证，不能只依赖 STUN。服务端没有生成任何 ICE 中继凭证时会拒绝直连会话，不会把设备静默切到一个不可达的媒体路径。建议只按 ADB 序列号灰度，确认浏览器指标中的 `rtcNegotiatedNack=true`、`rtcNegotiatedRtx=true` 以及期望的 ICE candidate 类型后再扩大。

可写字段及范围：

| 分组 | 字段 | 范围/含义 |
|---|---|---|
| 源画面 | `maxSize` | 480–2160，长边上限 |
| 源画面 | `maxFps` | 5–60 |
| 源画面 | `videoBitRate` | 500000–12000000 bit/s |
| 编码器 | `videoEncoder` | 1–128 位 MediaCodec 名称，只允许字母、数字、点、下划线和短横线；应先按单机灰度 |
| 编码器 | `encoderBitrateMode` | 1=VBR，2=CBR；热策略不开放 CQ |
| 编码器 | `iFrameIntervalSeconds` | 1–10 秒 |
| 实时队列 | `realtimeQueueLatencyMs` | 100–1500 ms；超过时间预算仍按完整依赖链丢弃，不能无限积压 |
| 源恢复 | `sourceRecoveryEnabled` | 是否在媒体会话保活时重建短暂中断的 scrcpy 视频源 |
| 源恢复 | `sourceRecoveryMaxAttempts` | 1–8 次 |
| 源恢复 | `sourceRecoveryWindowSeconds` | 10–300 秒统计窗口 |
| 关键帧 | `viewerKeyframeResetEnabled` | 新 WHEP 阅读器连通后是否请求一次源端 ResetVideo |
| 关键帧 | `keyframeRecoveryCooldownMs` | 500–10000 ms，发布器过载恢复日志/请求冷却 |
| RTP | `transportPacingBitRate` | 2000000–48000000 bit/s |
| RTP | `transportPacketsPerBurst` | 1–8 包/组 |
| RTP | `transportAdaptivePacing` | 兼容旧灰度开关，默认关闭 |
| RTP | `transportReceiverFeedback` | 浏览器反馈驱动 2→1 包微突发平滑开关 |
| RTP | `transportReceiverStableHoldMs` | 5000–60000 ms |

覆盖顺序是 ADB 序列号 > 设备 ID > 全局热策略 > Windows 设备 profile > Windows 全局默认；但 `maxSize`、`maxFps` 和 `videoBitRate` 最终仍受 Windows Agent 全局能力硬上限约束。删除某个覆盖字段即可回到下一层配置，不使用 `null` 清除。

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
