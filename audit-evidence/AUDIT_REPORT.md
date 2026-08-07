# Phone Cloud Platform 上线前审计报告

审计时间：2026-06-24  
审计范围：`phone-cloud-platform` 服务端、前端、Windows 管理器、ADB/Appium 自动化、部署配置、当前本地运行状态。  
证据文件：
- `audit-evidence/01-current-entry.png`：未登录入口截图
- `audit-evidence/02-after-admin-login.png`：管理员登录后截图
- `/api/v1/diagnostics`：当前上线门禁 `blocked`
- `/api/v1/devices`：当前 2 台 ADB 在线设备、短信库 1011 条、Appium 预检 OK

## 1. 项目整体评估

### 当前完成度

项目已经具备“两台手机本地演示闭环”的基础能力：
- Windows 管理器可以扫描 ADB 设备，当前检测到 2 台 `device` 状态手机。
- 短信库可以通过 ADB `content://sms` 同步，当前已同步 1011 条。
- Appium / UiAutomator2 预检已经接入，当前 1 个 Windows 管理器显示可执行自动化。
- 小红书扫码任务已经走 Windows Agent + Appium 主流程，并有设备/槽位并发保护。
- 前端已区分管理员页和用户工作台，设备卡片、详情页、设置弹窗已经有雏形。

但项目还不适合公网正式上线。它现在是“本地/内网联调可用”，不是“可面对真实用户、真实攻击、真实并发”的生产系统。

### 主要优点

- 架构方向正确：把设备在线状态改为 ADB 主导，扫码任务改为 Windows Agent + Appium，避免依赖自研 APK 心跳。
- 已有基础安全头：CSP、`X-Frame-Options`、`nosniff`、`Referrer-Policy`。
- 密码存储使用 `scrypt`，会话只保存 token hash。
- QR 图片校验了 data URL MIME 和 magic bytes，限制 3MB。
- 任务终态有保护：Windows task 迟到回写不会覆盖终态 XHS task。
- 设备扫码并发限制已存在：`DEVICE_MAX_ACTIVE_XHS_TASKS=1`，同设备/同槽位冲突返回 409。
- 诊断页已经把上线门禁显式暴露出来，这是很好的运维基础。

### 主要风险

高危：
- 当前运行仍使用默认 `admin/admin123`、`dev-admin-token`、`dev-windows-token`、`dev-device-token`，任何知道默认值的人都能控制平台和设备。
- 未配置 HTTPS / `PUBLIC_BASE_URL` / 可信 Origin，公网部署时传输和来源边界不完整。
- 普通用户目前能通过设备详情读取整台手机短信库，缺少用户、租户、订单级数据隔离。
- 短信、二维码、任务事件、设备信息保存在本地 JSON 或单条 Postgres JSONB 快照里，不适合作为生产数据模型。
- Windows Agent 可自动 `npm install appium@latest` 和 driver，存在供应链、版本漂移、上线不可复现风险。

重要：
- 服务端单进程内存状态 + 全量快照保存，100 台手机每 30 秒同步短信时会写入风暴。
- Windows Agent 日志显示短信同步按批量连续 POST，每台手机几十到上千条会瞬间打满服务端和状态文件。
- 小红书自动化脚本仍含坐标兜底，跨机型稳定性不足。
- 页面未登录时仍显示“总览 0 数据”，容易让用户误以为设备全部离线。
- 缺少完整第三方 API 鉴权模型、签名、重放保护和配额。

### 最需要优先处理的问题

1. P0：替换所有默认账号和机器 Token，启用生产配置强校验。
2. P0：HTTPS、可信 Origin、反向代理、HSTS、真实公网域名配置。
3. P0：建立用户/租户/设备/SIM/短信数据授权模型，普通用户不能默认看到所有设备短信。
4. P1：把 JSON 快照迁移到结构化数据库表，至少拆分 users/sessions/devices/sms/messages/tasks/audit。
5. P1：Windows Agent 自动安装依赖改为版本锁定、离线包或管理员批准。
6. P1：建立进程守护、健康检查、自动拉起、日志轮转和备份恢复演练。

## 2. 从不同角色视角的使用分析

### 新用户

发现的问题：
- 没有注册、找回密码、首次引导、服务说明和权限说明。
- 未登录页面仍显示平台总览 0 数据，左侧还有登录框，用户容易误解“系统没有设备”。
- 登录失败使用 `alert`，体验粗糙，且浏览器自动化截图曾被弹窗阻断。

影响：
- 新用户不知道自己要找谁开账号，也不知道设备池和短信库的边界。
- 把“未登录无数据”误判成“设备离线”。

严重级别：P2。

修复建议：
- 未登录时只显示登录页，不展示业务数据壳。
- 增加“联系管理员开通账号”的提示。
- 登录错误改为页面内错误提示，禁止 `alert`。
- 如果这是内部 B2B 工具，可以不做注册，但要明确“管理员创建账号”。

### 普通用户

发现的问题：
- 普通用户可以看到设备库存、点开手机详情、查看整台手机短信库。
- 短信库是完整短信内容，不只验证码窗口内的新短信。
- 扫码任务只支持小红书，但 UI 提到未来平台槽位，抖音等未完成流程需要隐藏或标注不可用。
- 自动化环境状态对普通用户展示了 Appium、UiAutomator2 等技术细节，不利于理解。

影响：
- 数据合规风险高，用户 A 可能看到用户 B 的短信、历史验证码、银行/运营商短信。
- 用户会把“平台未配置账号槽位”和“手机不可用”混淆。

严重级别：短信权限 P0；体验说明 P2。

修复建议：
- 普通用户短信库默认只展示“与自己订单关联的短信”或“当前设备被自己占用期间新增的短信”。
- 如果确实要开放完整短信库，必须有租户隔离、用户授权、审计、脱敏、保留期限和隐私协议。
- 自动化环境状态用业务语言：可用、准备中、需管理员处理。

### 管理员

发现的问题：
- 管理员可以做很多操作，但缺少危险操作二次确认和详细审计差异。
- 重置密码使用 `prompt("输入新密码，至少 6 位")`，但后端本地默认最小 8 位，生产建议 12 位；前后端文案不一致。
- APK 发布页还保留旧 Agent 路径，容易误导当前主路径。
- 审计日志达到 5000 上限后直接截断，当前已满 5000 条。

影响：
- 管理员误操作难追责。
- 审计证据会丢失。
- 旧 Agent 和新 Appium 路径边界不清，排障时容易走错。

严重级别：P1/P2。

修复建议：
- 管理端危险操作全部改为确认弹窗 + 操作理由 + 审计 detail。
- 密码策略统一为后端返回配置，前端不要写死 6。
- 将旧 Agent 调试工具折叠到“兼容/调试”区。
- 审计日志落库并支持分页、导出、保留策略。

### 恶意用户

优先攻击路径：
1. 尝试默认账号 `admin/admin123` 或默认静态 Token。
2. 盗取浏览器 localStorage 的 session token。
3. 调用 `/api/v1/user/devices/:id/sms-library` 枚举所有设备短信。
4. 构造大量 QR 图片或短信订单压垮 JSON 状态文件。
5. 如果拿到 Windows Agent Token，可伪造设备同步、写入短信库、污染设备状态。
6. 如果拿到管理员 Token，可下发 Windows 任务，间接控制 ADB 设备。

严重级别：P0/P1。

修复建议：
- 默认密钥禁止启动生产；静态 Token 改为每个 Agent 独立密钥，支持轮换和吊销。
- Session token 优先使用 `HttpOnly; Secure; SameSite=Strict` Cookie。
- 普通用户接口强制资源归属校验。
- 所有写接口增加速率限制、幂等键、请求大小、行为审计。

### 异常环境用户

发现的问题：
- 断网/服务停止时前端大量并发请求失败，容易出现空数据或 alert。
- Windows Agent/平台没有统一启动脚本和进程守护，用户多次遇到 `127.0.0.1 拒绝连接`。
- 弱网下 Appium 任务可能过期，任务状态和事件提示不一定足够可操作。
- 手机断开再插入后依赖 10 秒扫描、90 秒在线窗口，前端没有明确倒计时或最近同步时间。

影响：
- 用户不知道是服务挂了、Windows 管理器离线、ADB 未授权，还是设备真的离线。

严重级别：P1/P2。

修复建议：
- 前端增加全局离线/接口失败横幅。
- 本地开发提供一键启动脚本；生产使用 systemd/pm2/docker compose restart policy。
- 设备卡片显示“最近 ADB 同步时间”和“下次扫描预计”。

## 3. 按模块/页面/接口逐项审查

### 登录与会话

发现的问题：
- 当前诊断显示默认管理员、默认静态 Token 仍在使用。
- Session token 存在 localStorage。
- 登录限流仅内存 Map，进程重启即清空，不支持多实例。
- 无 MFA、无密码找回、无登录设备管理。

风险说明：
- XSS 或浏览器扩展可直接读 localStorage token。
- 默认 Token 泄露后可绕过登录。

严重级别：P0。

修复建议：
- 生产强制 `STRICT_PRODUCTION_CONFIG=true`。
- Token 长度 >= 32 字节随机值，禁止 `dev-*`。
- 改用 HttpOnly Cookie 或至少短 TTL + refresh/rotate。
- 登录限流落 Redis/Postgres，按 IP、账号、设备指纹限流。

### 用户工作台

发现的问题：
- 用户设备库存已接近目标，但未登录时显示 0 数据。
- 设备详情里普通用户可见完整短信库。
- 扫码任务目标仅支持小红书，未来平台槽位需要后台明确绑定。
- “自动化环境状态”技术词过多。

风险说明：
- 数据泄露和误操作风险。

严重级别：短信库 P0，体验 P2。

修复建议：
- 普通用户默认只能看自己占用/订单相关短信。
- 设备详情的短信库加分页已经有基础，但要做服务器端严格 `limit <= 100`，不要允许 2000。
- 平台槽位用通用结构：`platform: xhs/douyin`、`slot`、`accountName`、`enabled`、`automationType`。

### 管理后台

发现的问题：
- 后台页面很多 CRUD 入口没有完整空状态/失败状态。
- 用户重置密码用浏览器 prompt。
- APK 发布仍作为主导航，和当前“不依赖 APK”主路径冲突。
- 诊断页很好，但当前只是提示，未阻止危险上线。

风险说明：
- 管理员易误操作，旧路径误导排障。

严重级别：P1/P2。

修复建议：
- 管理页按“设备池、用户、任务、诊断、兼容工具”重组。
- 旧 APK 功能标记为兼容调试。
- 生产启动时直接 fail fast，而不是只在诊断页提示。

### 设备管理与 ADB 同步

发现的问题：
- 在线状态依赖 Windows Agent 10 秒扫描 + 90 秒窗口，模型合理，但前端没解释刷新节奏。
- 设备缺失时保留历史设备，若用户只看前端会误解。
- 设备命名已改为品牌 + ADB 序列号，方向正确。

风险说明：
- 多 Windows 管理器同时上报同一设备时，当前设备归属可能被后写覆盖。

严重级别：P1/P2。

修复建议：
- 加设备租约：同一 `adbSerial` 同时只能被一个 agent 持有，冲突时进入异常状态。
- 设备状态显示：`online/offline/missing/unauthorized/recovering`。

### 短信库与验证码订单

发现的问题：
- Windows Agent 每次通过 `content query content://sms` 扫全量短信，再按 50 条批量 POST。
- 服务端 `upsertSmsLibraryMessages` 对每条消息用数组 `find` 查重，数据量上升后是 O(n*m)。
- 普通用户能请求某设备短信库，`limit` 最大到 2000。
- 第三方短信订单接口复用普通用户/管理员 auth，没有独立第三方应用密钥、签名和回调。

风险说明：
- 100 台手机、每台上千短信、30 秒同步一次，会造成服务端 CPU、磁盘和状态文件写入压力。
- 第三方接口容易被重放和滥用。

严重级别：性能 P1，权限 P0。

修复建议：
- 用 `_id/date` 增量同步，不要全量扫。
- 服务端用数据库唯一键 `(device_id, message_key)`。
- 普通用户短信权限改为订单级授权。
- 第三方 API 增加 `appId + HMAC 签名 + timestamp + nonce + idempotencyKey + IP 白名单 + 配额`。

### 小红书扫码任务

发现的问题：
- 任务创建有并发保护，这是优点。
- QR 图片完整 base64 保存在 `xhsQrTasks` 和 `windowsTasks.payload`，状态文件膨胀且含敏感登录二维码。
- Windows Agent 推送图片到手机后本地临时文件会删，但手机相册图片先保留。
- 自动化脚本仍使用坐标：进入“我”、扫码图标、相册第一张等步骤。

风险说明：
- 二维码可能是登录凭证，泄露会导致账号风险。
- 坐标脚本跨分辨率/版本容易失败。

严重级别：P1。

修复建议：
- QR 图片改为短期文件/对象存储，任务只保存引用和 hash，任务结束立即删除服务端和手机端图片。
- 坐标兜底改为元素定位优先，坐标只作为机型策略文件中显式配置。
- 每个任务记录截图、XML 摘要、当前 package/activity，但注意敏感脱敏。

### Windows 管理器

发现的问题：
- 自动安装 Appium 使用 `appium@latest`，driver 也是动态安装。
- `appiumCommand`、`npmCommand`、`adbPath` 来自本地配置，配置被篡改时可执行任意命令。
- 任务轮询 2 秒一次，100 台/多 agent 时会有无效轮询。
- 没有本地队列持久化，Agent 重启后正在跑的任务依赖服务端 TTL 兜底。

风险说明：
- 供应链和运维不可复现风险高。
- 配置权限不严时等同本机 RCE。

严重级别：P1。

修复建议：
- 锁定 Appium 和 driver 版本，提供离线安装包。
- Windows Agent config 权限限制为管理员可写，启动时检查权限。
- 任务领取改成长轮询/WebSocket，或至少指数退避。
- 本地写任务执行状态和最后步骤，重启后上报恢复/失败。

### 部署与运维

发现的问题：
- 本地服务多次出现拒绝连接，说明启动/守护机制不稳定。
- 当前 `NODE_ENV=development`，`PUBLIC_BASE_URL` 空，JSON 存储，状态文件 4.8MB。
- `.env.example` 仍包含 `change-me` 和 `dev-*`，如果误用会高危。
- 审计日志已满 5000 条。

风险说明：
- 生产无法靠手动 `node server/index.mjs` 运行。
- JSON 状态快照在并发和数据量大时不可靠。

严重级别：P0/P1。

修复建议：
- 使用 Docker Compose/systemd，启用 restart、healthcheck、日志轮转。
- 生产只允许 Postgres。
- `.env.example` 保留占位但 preflight 必须阻止默认值。
- 审计、短信、任务拆表。

### 前端可访问性与兼容性

发现的问题：
- 深色小字较多，设备卡片内文字可能在小屏/缩放下拥挤。
- 多处按钮文案不够明确，表单错误使用 alert。
- 弹窗焦点管理不完整，关闭后焦点不一定回到触发按钮。
- 部分动态卡片虽然可点击，但需要统一 `button` 或 `role=button/tabindex`。

风险说明：
- 移动端、小屏、键盘用户体验差。

严重级别：P2/P3。

修复建议：
- 全部可点击卡片用真实 `button` 或补齐 ARIA/focus。
- 表单错误统一 inline toast/banner。
- 设置弹窗增加 focus trap。

## 4. 安全问题专项审查

### 高危：默认管理员和默认机器 Token

风险等级：P0  
可能出现的位置：`.env`、运行配置、`server/index.mjs` 默认值。  
利用方式：攻击者使用 `admin/admin123` 登录，或使用 `Bearer dev-admin-token` 调用所有管理接口。  
影响范围：用户、设备、短信库、任务、APK 发布、Windows Agent 任务。  
修复建议：
- 生产启动时强制 `STRICT_PRODUCTION_CONFIG=true`。
- 所有 Token 用 32 字节以上随机值。
- 初次启动必须强制改密。

### 高危：普通用户短信库越权

风险等级：P0  
可能出现的位置：`GET /api/v1/user/devices/:id/sms-library`。  
利用方式：普通用户拿到设备 ID 后读取整台手机所有短信。  
影响范围：手机号、验证码、运营商短信、银行短信、隐私内容。  
修复建议：
- 引入 `tenantId/userId/deviceLeaseId/orderId` 授权。
- 用户只能读取自己订单命中的短信或自己租用期间产生的短信。
- 默认脱敏短信正文，仅验证码场景返回 code 和必要元数据。

### 高危：HTTP/公网传输未就绪

风险等级：P0  
可能出现的位置：当前诊断 `PUBLIC_BASE_URL` 未设置，HTTPS gate fail。  
利用方式：公网 HTTP 下 token 可被中间人或代理日志捕获。  
影响范围：全部 API。  
修复建议：
- 只允许 HTTPS。
- 配置 `PUBLIC_BASE_URL=https://...`、`TRUSTED_ORIGINS=https://...`。
- 反代启用 HSTS。

### 高危：机器 Token 权限过大

风险等级：P0/P1  
可能出现的位置：`WINDOWS_AGENT_TOKEN`、`DEVICE_AGENT_TOKEN` 是全局静态值。  
利用方式：任一 Agent 配置泄露后可伪造所有 Windows Agent 或设备上报。  
影响范围：设备状态、短信库、任务执行状态、审计污染。  
修复建议：
- 每个 Windows Agent 独立 token + agentId 绑定。
- 每台设备/每个 agent 支持吊销。
- 对状态回写校验 task.agentId 和 token 绑定关系。

### XSS 与 Token 窃取

风险等级：P1  
可能出现的位置：前端 localStorage token、动态 innerHTML。  
利用方式：如果某个字段未正确 escape 或第三方脚本注入，直接读取 localStorage token。  
影响范围：当前用户权限。  
修复建议：
- 改用 HttpOnly Cookie。
- 保持 CSP，禁止 inline。
- 对所有 innerHTML 渲染继续统一 `escapeHtml`，新增 lint/测试。

### CSRF

风险等级：P2  
可能出现的位置：所有 POST/PUT。  
利用方式：当前用 Bearer token，CSRF 风险低；但如果改 Cookie，需要 CSRF token。  
影响范围：写接口。  
修复建议：
- 如果改 Cookie，使用 SameSite=Strict + CSRF token。
- Origin 检查继续保留。

### SQL 注入

风险等级：P2  
可能出现的位置：当前只有 Postgres snapshot 查询，使用参数化。  
利用方式：现阶段未发现直接 SQL 拼接注入。  
影响范围：低。  
修复建议：
- 后续拆表时所有查询必须参数化。

### 命令注入 / 本机命令执行

风险等级：P1  
可能出现的位置：Windows Agent 的 `adbPath`、`npmCommand`、`appiumCommand`、`execFile/spawn`。  
利用方式：攻击者改本地 config，Agent 启动后执行恶意命令。远程管理员目前不能直接传命令，但能下发任务触发本地命令。  
影响范围：Windows 主机、ADB 设备。  
修复建议：
- 配置文件权限检查。
- 命令路径白名单。
- 生产禁用远程配置命令路径。

### 文件上传漏洞

风险等级：P1/P2  
可能出现的位置：APK 上传、QR 图片上传。  
利用方式：管理员上传任意 APK，或用户上传大量 QR 图片填满状态。  
影响范围：设备、磁盘、状态文件。  
修复建议：
- APK 校验签名、包名、版本、sha256。
- QR 图片落短期文件，不写入状态大 JSON。
- 添加用户级上传频率限制。

### 路径穿越

风险等级：P2  
可能出现的位置：静态文件服务、APK 下载。  
当前状态：静态服务已使用 `path.relative` 检查，APK 文件使用 `path.basename`，基础防护有效。  
修复建议：
- 保持测试覆盖：`/%2e%2e/`、双编码、Windows 路径分隔。

### SSRF

风险等级：P2  
可能出现的位置：Windows Agent 下载 APK `downloadUrl`。  
利用方式：管理员可配置任意 URL，Agent 会请求。  
影响范围：Windows 主机内网探测。  
修复建议：
- 下载 URL 只允许平台同源或白名单域名。

### 重放攻击

风险等级：P1  
可能出现的位置：第三方短信订单、Windows/Device 上报。  
利用方式：截获或拿到 token 后重复提交旧请求。  
影响范围：重复订单、状态污染、短信库污染。  
修复建议：
- 第三方 API 加 timestamp + nonce + HMAC。
- Windows task event/status 校验状态版本号和幂等键。

### 敏感日志泄露

风险等级：P1  
可能出现的位置：access log 记录完整 URL；Windows task events 可能含 XML、短信/二维码任务细节。  
利用方式：日志被读取后获取搜索词、设备 ID、手机号、UI 页面信息。  
影响范围：隐私与账号安全。  
修复建议：
- 日志脱敏手机号、短信正文、二维码、Authorization。
- 不记录完整 query，或对 `q` 等参数脱敏。

### 依赖供应链风险

风险等级：P1  
可能出现的位置：`appium@latest`、driver 动态安装。  
利用方式：版本漂移、依赖被污染、不可复现。  
影响范围：Windows 主机和设备自动化链路。  
修复建议：
- 锁定版本、离线 npm cache、校验 lockfile。

## 5. 测试清单

### 功能测试

- 登录成功、失败、禁用用户登录、过期 session。
- 管理员创建用户、停用用户、重置密码、普通用户改密。
- Windows Agent 上报：device/unauthorized/offline/missing。
- 设备插拔：10 秒内上线，90 秒后离线，重新插入恢复。
- 短信库：分页、搜索、SIM 筛选、仅验证码、复制验证码。
- 第三方短信订单：按 deviceId、phoneNumber、slotIndex 创建，超时、取消、命中第一条新增短信。
- 小红书扫码：可用设备创建任务、同设备并发冲突、同槽位冲突、用户取消、Windows 迟到回写。
- 诊断页：默认 token、HTTPS、Appium、ADB、备份、存储门禁显示正确。

### 边界测试

- QR 图片空、超 3MB、MIME 伪造、非图片 base64。
- 短信正文超长、手机号为空、SIM 缺失、sub_id 缺失。
- 设备 ID 含特殊字符。
- 分页 limit 超大、offset 超大、负数。
- 同一短信重复上报。
- 同一设备被两个 Windows Agent 同时上报。
- 状态文件接近 50MB、短信 10 万条。

### 异常测试

- 服务端重启时 Windows task running。
- Windows Agent 重启时 Appium session 未释放。
- Appium 不存在、driver 缺失、手机拒绝安装 helpers。
- ADB unauthorized、offline、device missing。
- 手机锁屏、相册权限弹窗、XHS 未登录、XHS 未安装。
- 网络断开、接口超时、返回 500。

### 安全测试

- 默认账号/默认 Token 是否能访问管理接口。
- 普通用户是否能读其他用户订单、设备短信、任务。
- Origin 伪造 POST 是否被拒绝。
- localStorage token 被盗后接口权限范围。
- XSS payload 注入设备名、短信正文、账号名、任务事件。
- QR 上传恶意文件。
- APK 上传非 APK 或签名不匹配 APK。
- 第三方 API 重放、篡改参数、暴力创建订单。
- 路径穿越静态文件和 APK 下载。

### 性能测试

- 100 台设备，每台 1000/5000/10000 条短信，30 秒同步一次。
- 100 个用户同时刷新设备列表和短信库。
- 50 个扫码任务排队/冲突。
- JSON 存储与 Postgres 存储对比响应时间。
- Windows Agent 轮询对服务端 QPS 的影响。
- 状态保存耗时、事件日志增长、审计满额行为。

### 回归测试

- 两台真机 ADB 在线不依赖 APK。
- 短信库分页不再一次性加载所有。
- 小红书扫码任务不再要求用户选择手机，只选择账号槽位。
- 同手机并发扫码返回 409，不创建重复任务。
- 取消任务后迟到成功/失败不覆盖终态。
- Appium/driver/helpers 在设备上线时预检并上报。
- 未登录页面不显示 0 数据误导。

## 6. 修复优先级路线图

### 第一阶段：P0 上线阻塞

1. 强制生产配置：
   - `NODE_ENV=production`
   - `STRICT_PRODUCTION_CONFIG=true`
   - 替换全部默认账号和 token
   - `PUBLIC_BASE_URL=https://真实域名`
   - `TRUSTED_ORIGINS=https://真实域名`

2. 权限模型：
   - 增加 `tenantId`
   - 设备/SIM/短信/任务绑定租户和用户
   - 普通用户短信只返回自己的订单相关数据

3. 第三方 API 安全：
   - 独立 app key/secret
   - HMAC 签名、timestamp、nonce、idempotency key
   - 配额和 IP 白名单

4. 进程守护：
   - 平台和 Windows Agent 都必须 systemd/pm2/service 化
   - 健康检查失败自动重启

### 第二阶段：P1 稳定性与数据模型

1. 拆分数据库表：
   - users、sessions、agents、devices、sims、sms_messages、sms_orders、xhs_tasks、windows_tasks、audit_events。
2. 短信增量同步：
   - 按 `_id/date` 游标同步。
   - 每台设备只推新增/变更。
3. QR 图片生命周期：
   - 文件短期存储，任务完成清理服务端和手机端。
4. Appium 环境固定：
   - 锁版本、离线包、校验。
5. 设备归属与租约：
   - 防止两个 Windows 管理器抢同一台 ADB 设备。

### 第三阶段：P2 体验与运维

1. 未登录页重做，只显示登录和说明。
2. 前端全局错误横幅替代 alert。
3. 设备卡片显示最近同步时间、预检状态。
4. 设置弹窗补焦点管理。
5. 诊断页增加“修复指引”和“一键复制排障信息”。

### 第四阶段：P3 优化

1. 可访问性细节。
2. 视觉一致性。
3. 管理端信息架构整理。
4. 自动化脚本策略库按机型沉淀。

### 最小可行修复方案

如果只为小范围试运行，最低要求：
- 禁止默认账号和 token。
- 开 HTTPS。
- 普通用户不能读完整短信库。
- 平台和 Windows Agent 使用守护进程。
- JSON 存储只允许短期试运行，并每天备份。
- 第三方短信接口必须有签名和幂等。

## 7. 最终结论

项目当前不适合公网正式上线。

核心阻塞点：
1. 默认管理员和默认机器 Token 仍在使用。
2. HTTPS 和公网生产配置未完成。
3. 普通用户短信库权限模型不满足隐私和多用户隔离要求。
4. 数据层仍以 JSON/单快照为主，不适合 100 台设备长期运行。
5. Windows Agent 自动安装 Appium 依赖未锁版本，供应链和稳定性风险高。
6. 进程守护和故障恢复不完整，用户已经多次遇到本地服务拒绝连接。

可以继续作为两台手机闭环测试平台使用，但下一步不应该继续堆功能，而应该先补安全、权限、数据模型、部署和可观测性。这个阶段过了，再继续打磨扫码流程和第三方接口，才不会在上线前把风险越堆越高。
