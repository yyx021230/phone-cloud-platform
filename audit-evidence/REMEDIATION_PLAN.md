# Phone Cloud Platform 具体修复方案

这份不是风险列表，而是可执行改造方案。目标是把当前“两台手机可测闭环”推进到“小规模可试运行”，再推进到“公网正式上线”。

## 第一阶段：先把 P0 高危堵住

### 1. 默认账号和默认 Token

问题：现在诊断显示还在使用 `admin/admin123`、`dev-admin-token`、`dev-windows-token`、`dev-device-token`。

具体修改：
- 修改 `.env`，生成真正随机密钥：
  - `ADMIN_API_TOKEN`
  - `WINDOWS_AGENT_TOKEN`
  - `DEVICE_AGENT_TOKEN`
  - `ADMIN_PASSWORD`
- 生产环境设置：
  - `NODE_ENV=production`
  - `STRICT_PRODUCTION_CONFIG=true`
  - `MIN_PASSWORD_LENGTH=12`
- `server/index.mjs` 已有 `enforceStrictProductionConfig()`，但现在本地没开强校验。上线脚本必须强制开启。
- Windows Agent 的 `windows-agent/config.json` 也要同步替换 `agentToken`、`deviceToken`。

建议命令：

```bash
openssl rand -base64 48
openssl rand -base64 48
openssl rand -base64 48
```

验收标准：
- `/api/v1/diagnostics` 里以下项不能再出现：
  - `admin_token_uses_default`
  - `windows_agent_token_uses_default`
  - `device_agent_token_uses_default`
  - `bootstrap_admin_uses_default_password`
- 用 `Bearer dev-admin-token` 请求 `/api/v1/users` 必须返回 401。
- 旧密码 `admin123` 不能登录。

### 2. HTTPS 和可信来源

问题：现在 `PUBLIC_BASE_URL` 未设置，公网 HTTPS 门禁失败。

具体修改：
- 阿里云服务器配置域名，例如：
  - `PUBLIC_BASE_URL=https://phone.yourdomain.com`
  - `TRUSTED_ORIGINS=https://phone.yourdomain.com`
- nginx 使用 `deploy/nginx/phone-cloud.conf.example` 模板。
- 禁止公网直接访问 Node 8787，只允许 nginx 反代。
- 只开放 80/443，8787 只监听内网或本机。

验收标准：
- 浏览器访问必须是 HTTPS。
- `/api/v1/diagnostics` 的 `transport_security` 为 `ok`。
- 从恶意 Origin 发 POST 请求返回 `403 forbidden_origin`。
- HTTP 自动跳转 HTTPS。

### 3. 普通用户短信库越权

问题：普通用户点开设备可以看完整短信库，这不适合多用户平台。

推荐方案：拆成两种权限。

普通用户：
- 只能看自己创建的验证码订单命中的短信。
- 只能看自己占用某台设备期间新增的短信。
- 默认不显示完整短信正文，只显示：
  - 发送方
  - 时间
  - 验证码
  - 平台
  - 脱敏正文

管理员：
- 可以查看完整短信库。
- 访问完整短信库必须写审计日志。

需要新增的数据字段：
- `smsMessages.tenantId`
- `smsMessages.visibleToUserIds`
- `smsOrders.userId`
- `smsOrders.deviceId`
- `smsOrders.startedAt`
- `smsOrders.expiresAt`
- `deviceLeases.userId`
- `deviceLeases.deviceId`
- `deviceLeases.startedAt`
- `deviceLeases.endedAt`

接口调整：
- 保留管理员接口：
  - `GET /api/v1/sms-library`
- 修改普通用户接口：
  - `GET /api/v1/user/devices/:id/sms-library`
  - 只能返回当前用户有权限的数据。
- 新增用户验证码接口：
  - `POST /api/v1/user/sms-code-requests`
  - `GET /api/v1/user/sms-code-requests/:id`
- 第三方接口：
  - `POST /api/v1/third-party/sms-code-requests`
  - `GET /api/v1/third-party/sms-code-requests/:id`

验收标准：
- 用户 A 不能看到用户 B 订单产生的短信。
- 用户 A 不能枚举设备 ID 读取完整短信库。
- 管理员读取短信库时审计日志记录 actor、deviceId、query、时间。

## 第二阶段：把数据层从 demo 级改到可试运行

### 4. JSON 快照迁移到结构化 Postgres

问题：当前 `state.json` 已经 4.8MB。100 台手机每 30 秒同步短信，会越来越慢。

具体方案：

新建表：

```sql
users(id, username, display_name, role, enabled, password_hash, created_at, updated_at)
sessions(id, user_id, token_hash, expires_at, revoked_at, ip, user_agent)
windows_agents(id, name, hostname, token_hash, last_seen_at, health_json)
devices(id, adb_serial, agent_id, brand, model, android_version, state, last_seen_at)
device_sims(id, device_id, slot_index, subscription_id, phone_number, carrier_name, enabled)
device_accounts(id, device_id, platform, app_slot, label, account_name, enabled)
sms_messages(id, device_id, message_key, sms_id, box, address, body, code, message_at, slot_index, subscription_id)
sms_orders(id, user_id, device_id, phone_number, status, code, started_at, expires_at, matched_message_id)
xhs_tasks(id, user_id, device_id, app_slot, status, windows_task_id, created_at, completed_at)
windows_tasks(id, agent_id, device_id, adb_serial, type, status, payload_json, result_json)
task_events(id, task_id, source, phase, level, message, created_at)
audit_events(id, actor_id, actor_role, action, detail_json, created_at)
```

关键索引：

```sql
unique(device_id, message_key)
index(sms_messages device_id, message_at desc)
index(sms_orders user_id, created_at desc)
index(xhs_tasks device_id, status)
index(windows_tasks agent_id, status, created_at)
index(audit_events created_at desc)
```

代码改造：
- 不再把整个 state 存成一条 JSONB。
- `server/index.mjs` 拆分：
  - `server/db.mjs`
  - `server/auth.mjs`
  - `server/devices.mjs`
  - `server/sms.mjs`
  - `server/tasks.mjs`
  - `server/audit.mjs`
- 先做 Repository 层，避免业务代码直接拼 SQL。

迁移策略：
- 写迁移脚本：
  - `scripts/migrate-state-json-to-postgres.mjs`
- 先把现有 `state.json` 导入 Postgres。
- 导入后保留备份，不再写 JSON。

验收标准：
- 1 万条短信查询单设备第一页 < 200ms。
- 100 台设备同步时服务不阻塞。
- 重启服务后状态不丢。

### 5. 短信同步改成增量

问题：Windows Agent 现在每次扫整库 `content://sms`，再全部上报，100 台会爆。

具体修改：
- Windows Agent 为每台设备保存游标：
  - `lastSmsId`
  - `lastMessageAt`
- ADB 查询时加条件：
  - 优先按 `_id > lastSmsId`
  - 如果设备 ROM 不稳定，再按 `date > lastMessageAt - 5min` 做补偿。
- 每次只上传新增短信。
- 服务端用唯一键去重。

Windows Agent 本地状态：
- 新增文件：
  - `windows-agent/data/cursors.json`

同步流程：
1. 设备上线。
2. 读取 cursor。
3. 查询新增短信。
4. 上传新增短信。
5. 服务端返回最大 `_id/date`。
6. Agent 更新 cursor。

验收标准：
- 第一次全量同步可以慢。
- 第二次同步只上传新增短信。
- 30 秒周期下，没新短信时不向服务端批量写 1000 条旧数据。

## 第三阶段：任务和设备池稳定性

### 6. 设备占用和扫码并发

当前已有 `DEVICE_MAX_ACTIVE_XHS_TASKS=1`，但还需要更完整的设备锁。

新增表/结构：
- `device_locks`
  - `deviceId`
  - `lockType`
  - `ownerUserId`
  - `taskId`
  - `expiresAt`

扫码任务创建流程：
1. 用户选择设备和账号槽位。
2. 服务端开启事务。
3. 检查该设备是否有未过期锁。
4. 检查该账号槽位是否 busy。
5. 创建 `xhsTask`。
6. 创建 `deviceLock`。
7. 创建 `windowsTask`。
8. 提交事务。

任务结束：
- succeeded/failed/cancelled/expired 都释放锁。

验收标准：
- 两个用户同时提交同一台手机，只能一个成功。
- 失败方返回 409，并显示是谁/哪个任务正在占用。
- 任务超时后锁自动释放。

### 7. Windows Agent 与设备归属

问题：未来多台 Windows 主机时，同一手机可能被两个 Agent 上报。

具体方案：
- 增加 agent 设备租约：
  - `adbSerial`
  - `agentId`
  - `lastSeenAt`
  - `leaseExpiresAt`
- 同一 `adbSerial` 已被 agent A 持有时，agent B 上报进入冲突状态。
- 管理后台显示“设备归属冲突”，由管理员处理。

验收标准：
- 同一 ADB serial 不会被两个 Agent 同时领取任务。
- agent 离线超过 90 秒后释放租约。

## 第四阶段：Windows Agent 安全和可复现

### 8. Appium 自动安装改成锁版本

问题：现在 `appium@latest` 不可控。

具体修改：
- `windows-agent/config.json` 增加：
  - `appiumPackage: "appium@2.19.0"`
  - `appiumDriverName: "uiautomator2"`
  - `appiumDriverVersion: "4.x.x"`
  - `allowOnlineInstall: false`
  - `offlinePackageDir: "./vendor"`
- 提供离线包目录：
  - `windows-agent/vendor/appium`
  - `windows-agent/vendor/uiautomator2-driver`
- 安装前校验 sha256。

验收标准：
- 没网络也能准备 Appium 环境。
- 版本固定，重装结果一致。
- 诊断页显示具体版本。

### 9. Windows Agent 配置权限

问题：如果 `config.json` 被普通用户修改，可能改 `npmCommand/appiumCommand/adbPath` 执行任意命令。

具体修改：
- Windows Agent 启动时检查：
  - config 文件 owner
  - ACL 权限
  - 是否 everyone 可写
- 不安全则拒绝启动。
- `adbPath/appiumCommand/npmCommand` 只允许绝对路径或白名单。

验收标准：
- 普通用户可写 config 时，Agent 拒绝启动并提示。
- 配置命令不是白名单时，Agent 拒绝启动。

## 第五阶段：第三方验证码接口

### 10. 独立第三方认证

问题：第三方接口现在复用用户/管理员登录态，不适合开放给外部平台。

具体方案：
- 新增 `api_clients` 表：
  - `clientId`
  - `secretHash`
  - `enabled`
  - `allowedIps`
  - `rateLimit`
  - `tenantId`
- 请求头：
  - `X-Client-Id`
  - `X-Timestamp`
  - `X-Nonce`
  - `X-Signature`
  - `Idempotency-Key`

签名规则：

```text
HMAC_SHA256(secret, method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256(body))
```

接口：
- `POST /api/v1/open/sms-code-requests`
- `GET /api/v1/open/sms-code-requests/:requestId`
- `POST /api/v1/open/sms-code-requests/:requestId/cancel`

返回：
- waiting
- received
- expired
- cancelled
- failed

验收标准：
- 篡改 body 后签名失败。
- 重复 nonce 失败。
- 超过 5 分钟 timestamp 失败。
- 重复 `Idempotency-Key` 返回同一个 request。

## 第六阶段：前端和产品体验

### 11. 未登录页重做

问题：未登录显示总览 0 数据，会误导。

具体修改：
- 未登录只显示登录面板。
- 不请求业务接口。
- 登录成功后根据角色进入：
  - admin -> 总览
  - user -> 用户工作台

验收标准：
- 未登录看不到 0 数据总览。
- token 过期后显示登录过期提示，不展示旧数据。

### 12. 错误提示替换 alert

问题：大量 `alert(error.message)` 阻断页面。

具体修改：
- 增加全局 toast/banner：
  - 网络失败
  - 权限不足
  - 设备占用
  - 自动化未就绪
- 登录错误、任务错误都显示在表单内。

验收标准：
- 页面无 `alert()`。
- 弱网/断网时显示清楚的错误横幅。

### 13. 普通用户设备详情简化

具体设计：
- 顶部：设备状态、手机号、平台账号槽位。
- 中间：短信验证码记录，只显示当前用户权限范围。
- 右侧：扫码任务，默认使用当前设备，只选账号槽位。
- 环境状态用业务文案：
  - 可执行
  - 准备中
  - 需要管理员处理
  - 离线

验收标准：
- 用户不需要理解 Appium/UiAutomator2。
- 无账号槽位时明确显示“该手机未配置小红书账号”。

## 第七阶段：部署和运维

### 14. 生产启动方式

具体方案：
- 阿里云服务器：
  - Docker Compose 或 systemd 启动平台。
  - nginx 反代 HTTPS。
  - Postgres 独立数据卷。
- Windows 主机：
  - Windows Service 启动 Agent。
  - 崩溃自动重启。
  - 日志滚动。

验收标准：
- 重启服务器后平台自动恢复。
- 重启 Windows 后 Agent 自动上线。
- `/readyz` 可被监控。

### 15. 备份和恢复

具体方案：
- Postgres 每日备份。
- 保留 7 天日备、4 周周备。
- 每周做一次恢复演练。

验收标准：
- 能从备份恢复用户、设备、短信、任务、审计。
- 恢复后 Windows Agent 可重新上线。

## 推荐施工顺序

### 第 1 天：堵高危

1. 替换默认账号和 token。
2. 开启 `STRICT_PRODUCTION_CONFIG=true`。
3. HTTPS 和 `PUBLIC_BASE_URL` 配好。
4. 普通用户短信库先临时关闭完整正文，只返回自己订单相关短信。

### 第 2-3 天：数据和权限

1. Postgres 拆表。
2. 短信订单和短信库权限绑定。
3. 第三方 API 签名。
4. 审计日志落库。

### 第 4-5 天：Windows Agent

1. Appium 锁版本。
2. 增量短信同步。
3. Agent 配置权限检查。
4. 设备租约。

### 第 6-7 天：产品和稳定性

1. 未登录页。
2. 全局错误提示。
3. 设备详情优化。
4. 进程守护、备份、监控。

## 最小可上线标准

上线前必须同时满足：

- 诊断页 `launchReadiness.status` 不是 `blocked`。
- 默认账号和 token 全部替换。
- HTTPS 正常。
- 普通用户不能读取完整短信库。
- 第三方接口有签名和重放保护。
- 平台和 Windows Agent 都有进程守护。
- 数据不再依赖本地 JSON 文件。
- 100 台设备短信同步压测通过。

