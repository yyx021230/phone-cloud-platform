# 普通异常自动恢复发布准备（未切换）

候选 lookup-auto-recovery-20261016-rc.1，代码提交1d4008e288d06598225041c4cadead025da43164，分支codex/lookup-auto-recovery-20261016。基线为实际lookup-account-offline-20261016-deployed.1 / 64e09fb / 63193b6f。未推送。

本地851项全量、14项新专项、27项恢复/掉线专项、check、HTTP模拟通过；193冻结文件hash不变。隔离Postgres使用只读导出的当前生产schema、空tmpfs数据库和模拟设备，12业务HTTP请求，原查询恢复、重复异常跨机、业务账户掉线跨机、其他4台继续、防重和重启均通过；无生产API/真机连接，无生产数据导入。

新镜像0d4f8ec8基于旧镜像增量替换两云端文件；37运行hash、完整Compose仅image变更、新旧鉴权、隔离ready和真实宿主D-075 live通过。最新数据库备份501915755字节已完整解码验证，旧镜像/完整Compose/env/ACTIVE及旧源码备份均在PREPARED所列路径；敏感文件只留服务器备份，不进入仓库。

需要云端维护约2分钟，控屏会短暂断开。Agent/ADB/SYSTEM/Windows/USB/媒体不用重载或修改。activate-body.py仅为待授权模板，不含批准范围，执行前须当次用户批准并复核占用、原164已确认终态、无其他在途任务、基线/配置/hash、D-075，再做切换前新备份。164原lookupId保留，不能改截止时间延长；若已到期按实际记录，不伪称原请求成功。

回滚：用ACTIVE.before完整Compose链恢复旧63193b6f镜像，仅重载phone-cloud；新请求/结果不回滚整库，不清空查询。旧版会恢复needs_recovery待处理行为。回滚前复核在途任务及维护范围。数据库备份仅灾难恢复材料，不自动导回。若媒体核验失败停止发布，不修复媒体。

尚未完成：生产切换、164原请求自动接续、自然业务掉线后原ID跨机真机。当前仅准备，无共享服务中断。生产运行版本仍为旧account-offline。
