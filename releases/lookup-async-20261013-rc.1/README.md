# 异步支付宝查名：本地候选

版本 `lookup-async-20261013-rc.1`，分支 `codex/lookup-async-api-20261013`。尚未上线或推送；本轮没有操作真机、账户或飞书。

对方使用两个接口：

1. `POST /api/v1/open/name-lookups/tasks`：JSON仅`phoneNumber`，持久受理后立即返回`lookupId/status/reused`；新任务202，复用200。
2. `GET /api/v1/open/name-lookups/tasks/{lookupId}`：获取原任务的`status/name/code`。HTTP200只是读到记录；有姓名看`succeeded`，`not_found`与`failed`分开。

首次发送前保存`Idempotency-Key`，网络重试保持原键、更新HMAC Nonce。即使调用方等2分钟后换请求号提交，同一客户同号码只要仍在处理中，仍返回原lookupId。成功或明确未查到结果固定从原完成时刻起复用10分钟；旧键/别名一直关联原结果，不因窗口结束重新查。不同客户隔离。最多50个新别名/任务，超限429，改为读取原ID。

设备分配、49名单、最多5台并行、同机串行、首次账号确认、触限切号、8小时冷却和人工接续继续内部处理。HTTP断开不取消任务或放锁；停止未确认的终态任务也不能在归档时丢掉号码绑定。单业务进程/单托管owner，当前不支持横向多实例。

## 接入资料

- [API说明](OPEN_NAME_LOOKUP_API.md)、[SDK使用](sdk/open_name_lookup/README.md)
- [交付ZIP](public/downloads/name-lookup-integration.zip)、[查名OpenAPI](public/downloads/name-lookup-openapi.json)、[ZIP校验](public/downloads/name-lookup-sha256.json)
- 静态门户`public/api-docs.html`：42平台操作，其中10个HMAC操作（新增2、原同步1、原会话7），原40契约保持。
- [验证回执](verification/RESULTS.json)、[更新说明](RELEASE_NOTES.md)、[版本](VERSION.json)、[完整哈希](MANIFEST.json)

Node：`submitLookup(phoneNumber,{idempotencyKey:savedKey})`，保存返回lookupId；下轮`getLookupResult(savedLookupId)`。Python对应`submit_lookup`、`get_lookup_result`。真实地址和凭据由管理员单独交付。新异步接口尚未在生产开放。

## 本地复验与限制

依赖沿用项目已有Node/Agent模块，未升级或安装依赖。正常项目依赖准备后，可运行`npm run check`、`npm run test:screen`、`npm run test:smoke`及SDK测试。Node HTTP测试会创建并停止自己的loopback平台/合成Agent；不需要ADB或真机。`verification/async-http.mjs`可用`LOOKUP_ASYNC_HOLD_MS=121000`实际等待超过2分钟；`LOOKUP_ASYNC_PROOF_FILE`保存脱敏结果。

生产存储必须PostgreSQL。独立临时PG先执行原`deploy/sql/20261013-managed-lookup.sql`，再执行新增`20261013-managed-lookup-async.sql`；仅对自己的loopback数据库设置`MANAGED_LOOKUP_TEST_DATABASE_URL`，分别运行`verification/async-http.mjs`、`verification/async-postgres.mjs`及旧`server/managed-lookup.http.test.mjs`。测试拒绝非127.0.0.1数据库。JSON只适合开发，不能代替生产事务保障。

默认队列最长30分钟，从首次受理起总体执行预算60分钟；人工期限30分钟。预算到期请求停止，确认后失败；离线或未知执行仍保留预约，不承诺60分钟内能安全停止。重复提交/GET不延长期限。推荐5秒轮询；尚未单独实现GET限流。PG结果/别名未自动清理，至少7天为保留要求，10分钟仅是新键的近期结果复用窗口。

## 来源、迁移与回退

完整候选由不可变lookup-pool rc.1以及rc.2/rc.3/rc.4已验证覆盖组合，再仅修改异步云端/SDK/文档及专项测试；[BASELINE.json](BASELINE.json)保存322文件原组合哈希。根仓旧业务不是生产基线。Agent/查名Python/OCR依赖、冻结媒体控制代码及现有部署回执原样保留。生产当前版本本轮未核验，发布前仍须核对ACTIVE/镜像/文件与D-075真实宿主机只读live检查。

新增迁移仅添加提交别名表及索引，不删数据。候选旧同步入口也识别异步别名，必须先完成新增表迁移再升级受理组件。回退时先暂停受理并安全排空，离线/未知/停止中保留设备预约；保留结果、别名、原键、冷却与迁移。不能直接回旧受理源码接受已使用别名，否则旧版可能把别名当成新请求。需要退回旧应用时应保持新查名入口关闭并保留可读账本，不擅自删表或整库覆盖。

本轮证据为本地实际HTTP/SDK/独立PG和模拟Agent，真实手机查询0。未覆盖真机新接口、真实五台/49映射、自然触限后完整切号/8小时到期、真实Agent断线重启、Windows OCR安装与公网/生产验收。前版已有缺口（首次启动拼图无resident worker的自动观察、自然Canvas API兜底）保持待验，不把历史双机成绩算作本次异步验收。
