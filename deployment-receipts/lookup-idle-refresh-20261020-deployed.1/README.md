# lookup-idle-refresh-20261020-deployed.1

已发布：2026-10-20 11:27（Asia/Shanghai）。候选lookup-idle-refresh-20261020-rc.2 / 74b245e05ea5c0a6ef666c8cbed189e9fcdf1066，运行变更deb9723。镜像c84f493d，源于实际持久镜像7980919c，保留恢复页面补丁；非根仓旧代码发布。

只发布：健康原机空闲5分钟优先重探；整轮无未完成业务且连续15分钟空闲安全结束。探测/轮询不延长空闲期限，业务保护/停止ACK保持。48台名单和最多5并发不变。

用户授权本次约2分钟窗口全部控屏短断，仍禁止实际业务在途时切换。首次名单变化安全拒绝，无切换；新授权后实际六路152/164/124/172/159/155。云端切换约47秒。没有Agent/ADB/SYSTEM/Windows/USB/媒体重载或环境修改，没有数据库迁移或远端推送。

验证：878回归、58专项及示例检查此前已过；隔离Postgres无外网/模拟设备的15秒加速轮次自动结束、ACK、重启、结果保留、新启动通过。41运行文件哈希、8公网文件哈希、health/ready、PG/Redis、D-075宿主live前后通过，Agent心跳恢复；131总/125上架/118在线，容器healthy且重启0，启动后有界200行错误关键词0。新策略真实5分钟重探/15分钟墙钟关闭未新触发验证；本轮0准备/业务提交。不能宣称全平台或所有真机验收完成。

备份：/opt/phone-cloud-platform/deploy-backups/lookup-idle-refresh-20261020-prep.1，最新postgres.preswitch.dump为531138009字节且已完整解码，原镜像/Compose/ACTIVE及文件齐全。回退先确认新策略任务排空及stop ACK；不可直接降级活动轮次，不覆盖数据库新结果。具体哈希见DEPLOYED.json，公网及状态证据见VERIFIED.json，候选准备见release-preparations同名prep.1。

分支codex/lookup-idle-refresh-release-20261020。根仓及其他worktree既有改动保持，未混入本次提交。
