# rc.3 云端计时修复发布准备

- 候选 `lookup-readiness-20261015-rc.3` / `373729203e65714c1985d38cb7c9ffba416b159f`，本地全量 Node 741 通过。API文档与SDK契约不变。
- 当前生产 `lookup-readiness-20261015-deployed.2`：云镜像73b24327/fda9967，Windows c559f96二Python补丁。新镜像 a34bcdbb 仅覆盖云端 `server/managed-lookup.mjs` 一处成功释放时清计时。不要回退Windows补丁。
- 已在真实宿主隔离构建，network=none/tmpfs/无发布端口/临时生成测试凭据；132文件hash、6 HTTP 200、未签名prepare401通过，测试容器删除，生产容器/启动时间/ACTIVE未因构建改变。
- 新完整PG备份446585904字节，63 TOC项，整份解码到/dev/null通过（未恢复到数据库）。当前镜像63559680字节、ACTIVE、环境及6层Compose均已备份。详见BACKUP.json。
- staging：`/opt/phone-cloud-platform/staging/lookup-readiness-20261015-rc.3/`，仅 `compose.pending.json`；尚未执行compose up。恢复点：`/opt/phone-cloud-platform/deploy-backups/lookup-readiness-20261015-prep.3/`。

## 下一次切换

先取得这次云端重载维护窗口；前次窗口已结束，当前有其他控屏与小红书采集。重新核对ACTIVE仍deployed.2、容器73b24327、Windows overlay c559f96、6层Compose/env与备份hash。复核他人任务已完成或有本次明确处理授权，不擅停任务。管理池须disabled、0通道和0活动查名，原请求历史保留。真实媒体宿主D-075只读live，失败停止，禁止自动修复。

确认后沿用ACTIVE的全部Compose文件，加staging/rc.3/compose.pending.json，执行 `up -d --no-deps --no-build phone-cloud`。只重建云端业务容器；不改环境、PG/Redis，不重载Agent或Windows/ADB/USB/媒体。核对ready/PG/Redis、新云文件hash、旧静态/控制hash、Agent新鲜心跳、原屏幕恢复与D-075 live。登记新的已发布版本/提交/镜像/Compose/回执，不移动原tag。

再做本轮原表授权号码的单台→两台→5台API灰度；准备成功后才能提交。重点补真实新拼图计时不继承上一条、2分钟新键防重、二值结果；130连接不稳须单独查明，不能伪造第十台通过。旧失败118/155记录不改写；自然触限/8小时到期本轮仍未覆盖。

## 回退

如果新云端启动/烟测失败，使用备份ACTIVE记载的原6层Compose及已留存73b24327镜像，仅重建云端。保留Windows c559f96与当前所有任务/结果/别名/冷却，不回灌PG快照。未知执行须确认停止，不能盲重放。回退也保留D-075并核验实际宿主。

## 当前交付状态

已部署2 Python兼容，十机灰度：9台成功业务；12条中10完成（8姓名、2空），2失败。130未通过。rc.3云端计时补丁仅候选/镜像暂存，等待新维护窗口；平台自动池恢复原disabled，未开放全量。工作区分支codex/lookup-readiness-deploy-20261015，本轮提交/tag分阶段保存，未推送，根仓既有改动保留。
