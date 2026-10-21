# 查名调度完整优化部署回执

2026-10-21北京时间11:54—11:58；状态：**已上线，基础核验通过，生产全量真机验收未完成**。

## 身份与范围

- 发布 `lookup-scheduling-20261021-deployed.1`，源码 `9d2276884f26e6c436bc4ccd80bb3c8d18be3771`，不可变候选 `lookup-scheduling-20261021-rc.3`；分支 `codex/lookup-round-admission-20261021`。
- 上版 `lookup-ocr-snapshot-20261021-deployed.1` / `1ec44cf2bbf15583821f941efe2b711b0ecb455d`，运行/下次镜像 `0db4c7ed…f2225`。
- 本版运行及下次启动镜像 `sha256:a9e487ecb04afa22def7c926541a06be5593191066652881388d017e54022dab`，容器PID954599；Windows Agent24968，唯一SYSTEM实例。共享ADB8988、媒体2503525保持。
- 只替换已提交的16云端及2Windows文件；继承失败跨机、统一最多5预约、公平分配、原机重探优先、独立人工观察/新鲜卡片/息屏区分，以及首次两台之后保持本轮接单。文档下载同步，无依赖升级、名单/队列配置调整或SQL迁移，快照仍JSON。

## 授权与执行

用户明确要求“上线吧”，随后批准本次5分钟窗口内控屏短暂断开，包含新接入连接。切换门槛时154、159、155、124、54、172六路；一度发现运行中查名，等待其结束后才切换。03:54:11 UTC停止云端，03:54:50 Windows两文件加载，03:54:55启动新镜像，03:56:01就绪通过，约110秒内恢复云端。

Windows沿用原SYSTEM计划任务，停止旧Agent及残留的本进程Python/发布器子进程后加载两文件。共享ADB不在旧Agent进程树中，前后PID/所有者/路径一致；未执行ADB客户端、start/kill-server，未修改授权key、环境、启动脚本、计划任务定义、端口、驱动、USB、Windows或媒体。没有新提交号码/探测或手动发通知；平台已有轮次按其既有配置自动继续运行。未推送远端。

## 验证与结果

- 发布前候选967回归、43准入专项、JSON/PG各50请求HTTP、Windows40隔离测试及镜像16hash/6入口测试已经通过，本次代码未变，未重复整套。
- 生产16云端、2Windows hash匹配；环境与挂载与旧容器完全一致，保留原23Compose并增加image-only覆盖。Windows实例锁与任务为单实例SYSTEM；扫描/心跳新鲜。
- health/ready恢复；公网9静态文件HTTP200且SHA256一致；快照列实查为JSON。D-075真实宿主机前后live通过，批准二进制、8Mbps/2包、PID保持。
- 11:56:30快照：131库存、125上架、117新鲜在线；其余12physically_absent、1usb_composite_no_adb_interface、1unauthorized。本次不对这些设备做恢复或驱动操作。
- 维护前257条查询逐一与活动/归档结果核对，真实丢失0，已有终态变化0。活动列表裁剪使3条旧终态移到归档；数据库核验均保留。
- 维护前唯一waiting_human是内部readiness_probe，启动后按新补位策略终态cancelled/code lookup_probe_human_replaced；不是用户业务被取消。本次没有业务运行时强制切换。
- 两次后续快照均5个查名预约，分别为3人工+2idle；48设备配置保留，队列0。11:57已恢复138实时控屏。11:59:25再查仍为5预约（161/115空闲，58/188/182处理），117在线、health/ready正常，257旧记录再次核验丢失0/终态改写0。既有轮次继续补位探测；快照不是长期稳定性承诺。
- 有界云端日志200条未匹配FATAL/uncaught/内存耗尽/managed dispatch unavailable；Windows最近400条未匹配观察报告失败、终态outbox待发、心跳或扫描失败。只说明所检查窗口。

## 失败与检查纠正

初次40秒ready等待失败，容器未退出/OOM、PG无阻塞，继续有界等待，66秒左右就绪；不将40秒超时写成通过。一次临时node -e引号丢失导致诊断命令语法错误，未运行其查询，后续统一stdin脚本。

第一次原查询核验仅对活动窗口，误报3条缺失；代码确认只保留256条已完成记录，补查归档后真实缺失0。第一版设备统计用了adb.status，改为实际adb.state及120秒新鲜度。快照列查找最初用snapshot表名无结果，改查phone_cloud_state.data确认JSON。以上只调整诊断脚本，没有临时修改运行代码或生产数据。

## 回退与剩余验收

备份与回退步骤见[发布准备](../../docs/LOOKUP_SCHEDULING_RELEASE_PREP_20261021.md)。云端备份 `/opt/phone-cloud-platform/deploy-backups/lookup-scheduling-20261021-prep.1`；Windows两文件备份 `D:\PhoneCloud\agent\backups\lookup-scheduling-20261021-prep.1`。失败可恢复原Compose/旧JSON兼容镜像与两个Agent文件，保留切换后数据；不把旧dump覆盖新查询，不回JSONB。本轮未回退。

尚未完成新版真实号码主动API全流程、人工完成到接续/卡片的实际时延、自然触限切号/冷却及长时验收；967/40模拟不能替代。维护已经结束，如后续需要再次中断使用，应按实际范围确认新窗口。
