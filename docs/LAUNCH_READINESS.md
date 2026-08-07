# Phone Cloud 上线打磨清单

这份清单定义“可以上公网给真实用户使用”的最低标准。当前主链路是 Windows 管理器 + ADB + Airtest/Poco，短信按需同步，小红书任务由服务端下发脚本配置。

## 上线门禁

后台诊断接口会返回 `launchReadiness`：

- `blocked`：不能上线，存在安全、存储、连接或自动化阻塞项。
- `review`：可以小范围灰度试运行，但仍有必须人工确认的风险项。
- `ready`：达到基础上线门槛，可以进入受控上线。

后台“诊断检查”页会把门禁项显示在普通诊断项前面。

## P0：不上线就必须解决

1. 生产安全配置
   - `NODE_ENV=production`
   - `STRICT_PRODUCTION_CONFIG=true`
   - `PUBLIC_BASE_URL=https://你的域名`
   - `TRUSTED_ORIGINS` 包含 `PUBLIC_BASE_URL`
   - 管理员密码不使用默认值，长度至少 12 位
   - `ADMIN_API_TOKEN`、`WINDOWS_AGENT_TOKEN`、`DEVICE_AGENT_TOKEN` 都使用强随机值
   - `EVIDENCE_SIGNING_SECRET` 使用独立强随机值，失败证据链接必须带短时有效期
   - `LEGACY_WINDOWS_AGENT_TOKEN_ENABLED=false`，每个管理器使用独立 Agent token

2. 访问安全
   - 全站 HTTPS。
   - Nginx 只暴露 80/443。
   - Windows 管理器只主动访问云端 HTTPS，不开放公网端口。
   - API 写请求必须通过 Origin 校验和 JSON Content-Type 校验。
   - 普通用户不能访问后台、Windows 管理器、设备管理、诊断、审计页面。

3. 数据存储和备份
   - 正式运营使用 `STORAGE_BACKEND=postgres`。
   - JSON 存储只允许两台手机试运行，并显式设置 `ALLOW_JSON_STORAGE_IN_PRODUCTION=true`。
   - 上线前执行一次备份恢复演练。
   - 上线后启用每日备份 timer。

4. 设备管理稳定性
   - Windows 管理器在线。
   - ADB 手机池能稳定上报。
   - 手机插拔、授权变化、offline、unauthorized 都能在页面准确显示。
   - Airtest、Poco、Yosemite 和手机端 PocoService 在设备上线预检时就绪。

5. 任务一致性
   - 同一手机号等待短信期间不能重复分配。
   - 同一台手机同一时间只能执行一个扫码任务。
   - 设备锁可以在后台看到归属用户、任务 ID、过期时间和释放原因。
   - 异常锁必须支持管理员手动释放，释放时取消关联任务。
   - 用户取消、任务超时、Windows 迟到回写不能覆盖终态。
   - Windows 管理器离线时，活跃任务进入 `stalled`，管理器重连后只恢复属于自己的任务。
   - 小红书扫码任务失败必须有可读原因和步骤轨迹。

## P1：小范围灰度前必须完善

1. 运维可观测性
   - 诊断页显示上线门禁、Windows Agent 健康、ADB 状态、Airtest/Poco 状态。
   - 任务日志能看到最近动作、错误码、当前 package/activity、页面摘要。
   - 访问日志带 `x-request-id`，方便定位请求。

2. 用户体验
   - 用户只看到设备卡片和自己可用的任务入口。
   - 进入设备详情后默认展示短信库分页和该设备可用账号槽位。
   - 扫码任务占用时明确显示“执行中/占用中”，不能让用户重复提交。
   - 设置弹窗支持修改密码和退出登录。

3. 第三方接口
   - 短信验证码接口有清晰文档。
   - 新接入只使用 `/api/v1/open/sms-code-requests` 签名接口。
   - 旧 `/api/v1/third-party/sms-orders` 仅兼容历史调用，诊断页需要提示 deprecated。
   - 订单状态可轮询。
   - 错误码稳定，不随前端文案变化。
   - 建议第三方轮询 3-5 秒，避免无意义高频请求。

4. 容量和限流
   - 每用户短信等待上限。
   - 每用户扫码任务上限。
   - 单设备扫码并发上限。
   - 登录失败限流。
   - 请求体大小限制。

## P2：正式规模化前继续打磨

1. 多 Windows 管理器调度
   - 支持多台 Windows 主机。
   - 设备和任务按 `agentId + adbSerial` 精准路由。
   - Windows 管理器断线后任务回收或重派策略明确。

2. 更强可观测性
   - 指标面板：在线设备数、任务成功率、失败原因排行、短信同步延迟。
   - 告警：Windows 管理器离线、ADB 设备大面积离线、Airtest/Poco 不可用、备份失败。

3. 数据治理
   - 先保留 snapshot 兼容，但新增结构化表迁移脚本并灰度验证。
   - 结构化表准备脚本：`deploy/sql/phone-cloud-structured-schema.sql`。
   - 短信、任务、审计查询逐步切到分页 SQL。
   - 短信库保留策略按业务需求配置。
   - 用户和管理员对短信内容的可见范围明确。
   - 审计日志长期保留和导出。

4. 自动化脚本治理
   - 小红书流程脚本版本化。
   - 每个扫码任务记录脚本版本、关键选择器和失败步骤。
   - 不同厂商和系统版本的选择器规则分层维护。
   - 失败截图和 XML 摘要脱敏存储。

## 可重复测试

上线前至少运行：

```bash
npm run check
npm run test:smoke
```

`test:smoke` 会启动临时本地服务并覆盖：管理员登录、用户创建、Agent 注册、设备同步/上架、用户查看已上架手机完整短信库、扫码锁冲突、管理员释放锁和运维指标接口。

## 当前建议节奏

1. 先把 `launchReadiness.status` 从 `blocked` 打到 `review`。
2. 用两台手机连续跑 1-2 天，观察短信同步、扫码任务、设备上下线。
3. 修完灰度问题后，再把 `review` 打到 `ready`。
4. 再接阿里云 HTTPS、Postgres、备份、Windows 真实主机。
