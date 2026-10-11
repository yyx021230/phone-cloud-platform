# 维护窗口执行单（尚未执行）

延续主文档13.5/13.6、D-075及 [rc.1发布手册](../platform-update-20261011-rc.1/RUNBOOK.md)。本轮用户允许推进构建/备份/暂存，但明确平台有人使用，完全停止前必须告知；本轮保持生产运行。下述切换需待确认窗口，不可把构建回执当作已经发布。

## 已准备的版本与目标

- 云端：当前实际业务镜像907e0c65 → 候选41af4d0b，源码7f69550；只更新 `phone-cloud` 服务。
- Windows：Tailscale远程连接到已核实同一公司主机。Agent根 `D:\PhoneCloud\agent`，计划任务 `PhoneCloud Windows Agent`，当前单实例PID85936；六份候选在 `D:\PhoneCloud\staging\platform-update-20261011-rc.1\candidate`。
- 所有云端准备物在 `/opt/phone-cloud-platform/staging/platform-update-20261011-rc.1`。rc.2是新增验证回执，不移动已建镜像和暂存目录。
- 冻结链路未改。**整台主机共用Agent入口更新会中断网页实时连接及手机任务调度**；不能称为仅一台手机受影响，也不重启MediaMTX/ADB/USB/Windows。

## 窗口到达后，先检查再停止

本轮完整库在本机恢复后，相同 Node22.22.3/pg8.22.0 源码冷启动13.05秒通过；实际候选Docker通过受限Unix socket连接该完整副本，在本机启动维护/checkpoint后通过readyz/Postgres/文档。跨机快照回写超时经压缩SSH通道复验通过，镜像检查202.73秒；两个时间均不能当作生产停机时长，实际生产配置/Redis/真机仍需窗口核验。

1. 再查本轮源码、镜像ID、云端26/Windows18项哈希、配置/Compose指纹。与回执不一致即停止，不覆盖新生产改动。
2. 在实际媒体宿主机执行未改动的标准 `verify.mjs --live`。现有宿主机PATH没有Node，本轮复用了运行业务容器的Node和musl、在**宿主机命名空间**直接执行，成功核验真实媒体进程；不是container-only或repository-only。获取当时业务容器PID后，以 `/proc/<PID>/root/lib/ld-musl-x86_64.so.1 --library-path /proc/<PID>/root/usr/lib:/proc/<PID>/root/lib /proc/<PID>/root/usr/local/bin/node /opt/phone-cloud-platform/deploy/mediamtx-pacing/verify.mjs --live` 执行，失败不修复/不重启。
3. 用户确认全平台/整台Agent维护窗口，停止接新任务并逐原ID对账、排空前台任务/人工交接/投屏。不要取消用户任务、强释锁或根据数据库历史running计数认定已经排空。
4. 备份需在维护窗口更新：现有PG全库dump是一致性备份，但之后还有新业务；云端文件和Windows Agent备份是运行中的温备份。保存停前状态、冷却/通知回执、未确认outbox及配置的新鲜副本，核对Hash/可读性。Windows备份排除仍增长的logs/cache，原文件保留；不再整包复制活动8GB日志。
5. 记录明确允许中断及回退范围后，才停止目标业务服务与 `PhoneCloud Windows Agent` 任务，确认原进程和受影响的已有worker状态。不得杀所有Node/ADB或启动第二个全设备Agent。当前尚未执行停止，具体停止耗时/恢复时间尚未实测。

## 配套切换

云端配置预解析已通过，原环境和挂载保留，只有候选镜像和飞书受限文件只读挂载增加。**以下命令尚未执行**，只能在已确认窗口运行：

```bash
docker compose -f /opt/phone-cloud-platform/docker-compose.yml \
  -f /opt/phone-cloud-platform/staging/platform-update-20261011-rc.1/compose.candidate.json \
  up -d --no-deps --no-build --pull never phone-cloud
```

发布回执必须保存实际激活的两个Compose文件路径/指纹，并要求后续运维沿用该组合；基础Compose单独执行会选回旧配置，禁止以旧宿主机源码重新build覆盖新镜像。暂存目录及受限secret不能作为可清理缓存，后续迁移其路径需单独审核并更新回执。

先确认云端新镜像/readyz/26项after hash及新协议就绪；再在停止的Windows Agent上，只按MANIFEST替换6个候选文件，逐个核对after hash、18项组件哈希，配置、data、依赖与22冻结文件保留。加载同一计划任务、确认单实例/心跳/扫描与原占用/任务对账后再开放任务；混版阶段不派冷却v1任务。不运行通用媒体安装或全仓部署脚本，不更新依赖。

飞书文件权限为0600，挂载只读，配置内容不进命令行/Git；持久通知目录与Agent outbox须在既有持久data下。真实提醒/查名/切号/扫码/发布仍需明确手机、账号和次数范围；当前没有新增真实副作用授权。单机→两机真机验收、rc.2再次自然触限→切号→拼图→恢复、自然8h和24–48h观察仍是后续验收项。只读健康或模拟回归不能替代。

切换后再次执行D-075 host live，记录新镜像、运行哈希、Agent单实例、ADB服务器原PID/在线集合、任务/结果/冷却/回执及非目标业务。状态先记“已发布待观察”，完成实际灰度和观察后才能记“生产验收完成”。

## 停止条件与回退

身份/冷却错归、任务或结果丢失、重复查询/外发、持续保存失败、跨设备影响、健康或D-075失败时暂停新任务并按原ID对账。先保存升级后新数据，不用旧整库覆盖新业务。

候选和旧镜像归档均已核验Docker OCI身份；旧镜像专用标签 `phone-cloud-platform:baseline-907e0c65` 指向实际907e0c65。回退使用**基础Compose加回退overlay**，不要叠加candidate overlay，避免遗留新增secret挂载：

```bash
docker compose -f /opt/phone-cloud-platform/docker-compose.yml \
  -f /opt/phone-cloud-platform/staging/platform-update-20261011-rc.1/compose.rollback.json \
  up -d --no-deps --no-build --pull never phone-cloud
```

同一已获准窗口配套恢复Windows备份中的2份原有运行文件，4份新增模块仅在确认仍为候选hash且无后续引用后移入受限隔离目录保留，不盲删。保留当前配置、data、冷却、通知和outbox；旧版失去新修复行为，不承诺旧版自动续接。随后复核版本/健康/单实例/心跳/设备集合/原任务与D-075，保存回退回执。完整旧DB只作故障恢复材料，不自动灌回生产。
