# 本地验证回执

2026-11-02；范围只到服务端本地候选，不包含生产或新协议真机验收。

| 实际验证 | 结果 | 边界 |
|---|---|---|
| 根 `npm run check` | 退出0 | 语法检查 |
| `npm run test:screen` | 1858通过、0失败，157.920秒 | 现有屏控/服务端/脚本/Agent自动测试；不是实际投屏或手机 |
| 全量后最终相关复测 | 130通过、0失败 | WeCom、PG repository、occupancy、查名链可靠性/旧stop/proof |
| 真实JSON HTTP | 通过，包含于130 | 实际server子进程和文件存储，手机/进程证明字段为明确合成fixture |
| 真实Postgres structured | 1/1 | 独立loopback集群 |
| 真实Postgres snapshot-only | 1/1 | 非mock，验证overlay/领取状态 |
| 真实Postgres dual-write | 1/1 | 非mock，验证旧快照不能清除义务 |
| 原基线红例 | 预期失败 | 原同机新任务实际201，断言409失败 |

真实HTTP/PG均覆盖：领取、未知清理导致同机409、另一手机派发、host ACK前无许可、原业务失败保持、hostclose、实际server进程重启、实际归档、漏verify请求由poll补排、wrong proof拒绝、真实文件/数据库写入失败与回滚、proof成功后原业务不复活、迟到failed不降级、同机可接下一单；追加legacy在途模拟在真实进程启动时持久maintenance，业务实际过期再重启仍阻断。所有业务内容及物理证明均合成，未操作手机或发送邀请。

Postgres注入trigger拒绝release，以同一事务中verify仍running/hold仍pending证明回滚；不仅是mock client.query计数。三模式集群均在finally停止删除。运行方法：`python3 verification/wecom-cleanup-v1/run-postgres.py`，依赖本机Postgres二进制，明确不使用环境中现有DB地址。

初轮全量1805项中1773通过32失败：29项旧VM测试提取函数缺WECOM常量依赖，3项独立worktree未链接既有Agent node_modules；修复测试依赖并复用已有依赖目录后全量1858通过，未安装/升级依赖或修改锁文件。PG首轮snapshot-only曾因核验领取只更新快照、结构行仍queued失败；修复领取/快照同事务结构核验行后，三模式重跑通过。所有失败均属于本地，未发生生产变更。

原日志保留在任务临时目录：`/tmp/pc-wecom-cleanup-full.log`（初轮）、`/tmp/pc-wecom-cleanup-full2.log`（全量复跑）、`/tmp/pc-wecom-cleanup-specific-accepted.log`（130项最终）、`/tmp/pc-wecom-cleanup-pg-final.log`（快照反例）、`/tmp/pc-wecom-cleanup-pg-accepted.log`（三模式通过）、`/tmp/pc-wecom-cleanup-check-accepted.log`。SHA256见LOG_HASHES.json，可复跑但不把临时日志当永久测试门禁。

未覆盖：新协议真实SYSTEM Agent主循环/父进程hostclose/两帧实际手机、生产迁移与重载、真实媒体forward共存、多机长期并发、全部通用cancel旁路的真实PG故障。无部署、推送或手机操作。旧标签/主工作区既有改动保留。
