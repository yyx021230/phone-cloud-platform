# 实施路线

> **维护说明（2026-08-11）：** 本文保留历史实施过程，其中“已完成”只表示当时的实现判断，不保证仍符合当前生产事实。当前架构、冻结范围、已验证故障、数据一致性结论和后续路线统一以 [`PROJECT_DEVELOPMENT.md`](PROJECT_DEVELOPMENT.md) 为准。尤其是短信数据库幂等性已经发现结构性缺口，不得继续引用本文中的“重复同步不会重复插入”作为现状结论。

## 实时控制并发压测

压测工具不会自动选择在线设备，必须显式传入设备 ID，并通过环境变量提供密码：

```bash
PHONE_CLOUD_PASSWORD='***' npm run load:screen -- \
  --base-url http://47.98.127.132 \
  --devices device-id-1,device-id-2 \
  --duration-ms 60000 \
  --action-interval-ms 5000 \
  --output /tmp/phone-cloud-screen-load.json
```

只有确认所选手机适合滑动时才增加 `--swipe`。脚本会在 `finally` 中释放所有已创建的投屏会话；任一会话执行或释放失败时返回非零退出码。

## 第一阶段：两台手机可见

交付：

- 平台服务可启动。
- 管理页可登录。
- Windows 管理器可心跳。
- Windows 管理器可同步 ADB 手机。
- 页面显示 Windows 管理器、ADB 手机状态。

验收：

- Windows 管理器启动后页面显示在线。
- 两台手机插入后页面显示两台 ADB 在线。
- 拔掉一台手机后页面能看到状态变化。

## 第二阶段：Windows 管理器和设备环境

交付：

- Windows 管理器执行白名单 ADB 命令。
- Windows 管理器扫描并同步 ADB 手机。
- Windows 管理器上报 Airtest、Poco、Yosemite 和手机端 PocoService 状态。
- Airtest/Poco 依赖缺失时，Windows 管理器按配置自动安装或给出明确错误。

## 第三阶段：短信接收

交付：

- Windows 管理器通过 ADB 读取系统短信库并批量同步到平台。
- 管理员在 Web 端按手机、短信类型和关键词查询短信库。
- 第三方平台通过接口创建短信验证码等待订单。
- 平台按设备、SIM、手机号和订单时间窗口匹配验证码；当前默认匹配订单开始后新增的第一条短信。

## 第四阶段：小红书二维码扫码

交付：

- 用户上传二维码。
- 平台创建小红书扫码任务。
- Windows 管理器领取 `xhs_qr_appium` 任务。
- Windows 管理器推送二维码到手机相册，通过 Airtest/Poco 执行小红书图库扫码。
- 失败回传步骤轨迹、错误原因和可选截图。

## 上线原则

- Windows 不开放公网端口。
- Windows 主动访问阿里云 HTTPS。
- 阿里云只开放 `80/443`。
- ADB 只允许白名单任务。

## 当前实现状态

已完成：

- 独立项目目录。
- Node 平台服务。
- 静态管理页。
- Windows 管理器心跳。
- ADB 设备扫描同步。
- Windows 运维任务创建、领取、执行状态回传。
- 短信订单和短信事件接口。
- 小红书扫码任务接口。
- Docker、Nginx、systemd、备份脚本样例。
- APK 发布和下载接口保留为旧 Agent 调试能力。
- Windows 管理器保留安装/授权/启动旧 Agent 的兼容任务。
- Android Agent 已复制到新项目并适配新平台基础接口，作为兼容通道。
- 诊断检查 API 和管理页。
- JSON 状态备份、恢复脚本。
- 平台冒烟检查脚本。
- 账号登录、会话、普通用户和管理员权限隔离。
- 用户工作台：普通用户创建自己的短信订单和小红书扫码任务。
- 管理员账号管理页。
- 登录失败限流、用户改密、管理员停用/启用和重置密码。
- 短信号码等待期占用和用户取消短信/扫码任务。
- 短信按订单时间窗口匹配，重复短信事件按设备和 fingerprint 幂等去重。
- 手机短信库批量同步、幂等入库和后台查询接口。
- Windows 管理器会扫描 `content://sms`，用短信 `_id` 作为稳定键批量同步短信库；重复同步会更新同一条记录，不会重复插入。
- 短信库默认不按 30 天保留期删除，仅受 `MAX_SMS_MESSAGES` 容量上限保护。
- 小红书 `app1/app2` 账号槽位启停和任务槽位下发，支持双开手机定向扫码。
- 用户级短信/扫码并发限制和设备级扫码并发限制。
- 小红书扫码二维码图片前后端校验，空图和无效图片不会进入设备队列。
- 小红书扫码任务执行轨迹摘要，用户和管理员可查看最新动作、失败原因、轨迹数量和截图数量。
- 小红书扫码任务默认下发 `engineVersion=2` 的 workflowScript，脚本步骤包含启动、选择双开入口、进入“我”、打开扫码、选择相册首图和确认登录；后续维护优先改 JSON 步骤，不改 Java 主流程。
- Windows ADB 任务和小红书扫码任务终态保护，取消/完成/失败/过期后迟到状态回传不会覆盖结果。
- Windows 管理器小红书自动化执行期间会查询任务状态，发现用户取消或平台回收后停止流程并释放设备 worker。
- Windows ADB 任务和小红书扫码任务超时回收。
- HTTP 安全响应头、请求 ID、访问日志、Docker 健康检查和进程优雅退出。
- 数据保留策略、自动清理和管理员手动维护清理接口。
- Windows 管理器配置、ADB、日志目录和缓存目录健康上报。
- Postgres JSONB 快照存储、Docker Compose Postgres 服务、Postgres 备份/恢复脚本。
- Docker Compose 容器日志轮转配置。
- 当前存储模式自动备份脚本和 systemd 每日备份 timer 样例。
- 阿里云 Docker 部署脚本、Nginx 配置渲染脚本和部署清单。

待完成：

- Postgres 状态逐表关系化和更细粒度查询优化。
- 阿里云实机部署和两台真实手机联调。

## 下一轮开发重点

1. 按 `docs/ALIYUN_DEPLOYMENT.md` 在阿里云部署平台并配置 HTTPS。
2. 用 `deploy/scripts/generate-production-env.sh` 生成生产 `.env` 并通过预检。
3. 打开“诊断检查”页，确认管理员账号、Token、公网地址、数据目录、APK 发布状态。
4. Windows 管理器同步两台手机短信库。
5. 在“手机设备”页给两台手机绑定 SIM 手机号和小红书账号备注。
6. 创建普通用户账号，并用第三方验证码接口或普通用户接口完成短信订单到验证码匹配闭环。
7. 用普通用户创建小红书扫码任务并观察 Windows 管理器执行轨迹。

## 两台手机联调步骤

1. 启动平台：

```bash
npm start
```

2. Windows 启动管理器：

```powershell
cd phone-cloud-platform\windows-agent
copy config.example.json config.json
node src\index.mjs
```

3. 手机准备：

- 开启 USB 调试。
- 插入 Windows 主机。
- 确认 `adb devices -l` 状态为 `device`。

4. 管理页操作：

- 先打开“诊断检查”，确认平台配置不是失败状态。
- 打开“用户账号”，创建一个普通测试用户。
- 打开 Windows 管理器页。
- 确认 Windows 管理器在线，两台手机 ADB 状态为 `device`。
- 确认 Airtest、Poco、Yosemite 和手机端 PocoService 就绪。
- 打开“手机设备”，给手机绑定 SIM 手机号。
- 给手机配置小红书 `app1/app2` 账号槽位，只启用真实可用的账号。
- 在手机上提前登录对应小红书账号。

5. 验收：

- 两台手机 ADB 在线。
- Web “短信库”能看到对应手机同步的短信记录。
- 普通用户能看到可用号码。
- 第三方验证码接口或普通用户接口能完成一次短信验证码接收。
- 普通用户创建短信订单后，该手机号在等待期间不会继续分配；取消后会释放。
- 普通用户超过短信等待上限时不能继续创建短信订单。
- 普通用户能完成一次小红书二维码扫码任务。
- 普通用户能取消排队或执行中的小红书扫码任务。
- 普通用户或单台手机超过扫码并发上限时不能继续创建扫码任务。
- Windows ADB 任务超时后自动标记失败。
- 小红书扫码任务超时后自动标记过期。
- 普通用户不能访问 Windows 管理器、设备、APK 发布、诊断、审计页面。
- 普通用户能修改自己的密码，新密码可登录。
- 管理员停用用户后，该用户旧会话不能继续访问用户接口。

## 上线前检查

1. `.env` 里的管理员账号密码和三个机器 token 都不能使用默认值。
2. `STRICT_PRODUCTION_CONFIG=true`。
3. 推荐用 `deploy/scripts/generate-production-env.sh` 生成生产 `.env`。
4. 生产推荐 `STORAGE_BACKEND=postgres` 并配置 `DATABASE_URL`；两台手机试运行使用 JSON 存储时，必须设置 `ALLOW_JSON_STORAGE_IN_PRODUCTION=true`。
5. `PUBLIC_BASE_URL` 必须是 HTTPS 公网地址。
6. `deploy/scripts/preflight-production.sh` 执行成功。
7. `docs/ALIYUN_DEPLOYMENT.md` 中服务器、Nginx、HTTPS、备份、Windows 回连步骤已逐项执行。
8. `package-lock.json` 存在，Dockerfile 使用 `npm ci --omit=dev`。
9. `docker-compose.yml` 配置容器日志轮转，避免云盘被日志打满。
10. Nginx `client_max_body_size` 至少能覆盖 APK 大小，并配置 HSTS、`X-Forwarded-Proto`、关闭代理请求缓冲。
11. `deploy/scripts/smoke-test-platform.sh` 执行成功。
12. 使用 Postgres 时，`deploy/scripts/smoke-test-postgres.sh` 执行成功，确认数据库快照和重启持久化。
13. “诊断检查”页面没有失败项。
14. 运行 `deploy/scripts/backup-current-storage.sh` 并确认备份文件生成；上线后启用 `phone-cloud-backup.timer`。
15. 至少创建一个普通用户，并验证普通用户只能访问“用户工作台”。
16. 验证登录失败限流、用户改密、停用用户会话失效。
17. 验证短信号码占用、取消释放和扫码任务取消。
18. 验证旧短信不会匹配新订单，重复短信事件不会重复入库。
19. 验证短信库批量同步幂等：同一 `messageKey` 重复上报只更新一条记录。
20. 验证维护清理不会因为 30 天保留期删除短信库历史记录。
21. 验证只启用小红书 `app2` 时，用户扫码任务和设备命令 payload 都使用 `xhsAppSlot=app2`。
22. 验证扫码设备命令包含 `workflowScript.engineVersion=2`，且默认脚本版本为 `xhs-qr-login-v15`。
23. 验证默认 workflowScript 的 `launchApp` 步骤会继承目标 `xhsAppSlot`。
24. 验证用户级和设备级并发限制。
25. 验证小红书扫码空图、非图片和超大图片会被拒绝，真实 PNG、JPEG 或 WebP 能正常创建任务。
26. 验证 Windows 管理器上报扫码事件后，用户和管理员都能看到任务轨迹摘要和失败原因。
27. 用短 TTL 验证 Windows 任务和扫码任务超时回收。
28. 验证 `/healthz`、`/readyz`、`x-request-id`、安全响应头和 Docker `HEALTHCHECK`。
25. 验证数据保留配置、自动清理和 `POST /api/v1/maintenance/prune`。
26. 验证 Windows 管理器健康上报能显示 ADB 不可用、默认 token、目录不可写等告警。

## 常见故障定位

- Windows 管理器不在线：检查 `serverBaseUrl`、`agentToken`、Windows 出站网络。
- ADB 手机不显示：检查 USB 调试授权、数据线、Hub 供电、`adb devices -l`。
- APK 安装失败：检查“APK 发布”是否有本地 APK，或 Windows `apkPath` 是否正确。
- 旧手机 Agent 不在线：当前主流程不依赖；仅调试兼容通道时检查是否已启动 App、权限是否授权、电池优化是否关闭。
- 短信收不到：检查手机 SIM 绑定手机号是否和短信订单一致。
- 小红书扫码失败：先看扫码任务事件、Windows 管理器日志、失败截图和元素树，再确认小红书登录态、Airtest/Poco 环境和手机相册权限。
- 普通用户看不到号码：确认手机满足 ADB 在线、Windows 管理器在线、SIM 手机号已绑定且未被等待订单占用。
