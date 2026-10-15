# rc.8 云端隔离规则发布准备（未切换）

候选 `lookup-readiness-20261015-rc.8`，源码 `9d49e66799bfaa3a68d9f57a0fea64052d888ea3`。3次连续准备失败进入查名不可用池、管理员显式重新探测通过后接单；API提交/结果协议不变。29定向、747全量含投屏、root check、374 Python及Windows视觉1通过。自审，无独立审查。

当前真实生产为 `lookup-readiness-20261015-deployed.8-agent.1`：云端仍rc.3/a34bcdbb，Windows热补为rc.7查名、rc.8视觉、rc.4 Poco启动探活。云端自动隔离未生效，130已通过旧设备开关停派。ACTIVE保留组件hash和cloudCandidatePending，不能把整体rc.8称为已发布。

新镜像见IMAGE.json（e92e3a93），以正在运行的精确rc.3镜像覆盖5个云端文件；133文件、6 HTTP200、未签名401验证通过。network=none/tmpfs临时数据、无发布端口，测试容器已移除，生产容器与ACTIVE未变。Windows现有overlay必须保留；新云镜像内旧Agent包不含这3个热补，不得直接以其覆盖Windows，下次Agent安装须按ACTIVE补齐已核实overlay。

完整PG备份468005107字节，63 TOC项、整份解码到/dev/null通过，未恢复到数据库；旧镜像、ACTIVE、环境和7层Compose备份见BACKUP.json。配置和数据库含私有数据，仅留真实宿主受限目录，不入Git。备份不是生产数据回灌授权。

## 切换前门禁

1. 新云端维护窗口仍未获确认；当前存在他人控屏，不沿用已结束窗口。仅维护云端业务容器，禁止重启Agent/Windows/ADB/USB/媒体。
2. 重新读取ACTIVE和实际容器、Compose/hash、Windows overlay；本记录基线若变化，先重新比较。重新核验真实媒体宿主D-075 `verify --live`，失败停止。
3. 目前池恢复disabled/revision39；155/164空闲通道已释放，162保留离线recovery原请求/锁，尚未排空。先处理该请求执行状态，不能强制清锁或重放。维护前重新核对采集/查询/控制占用，遵循用户本次窗口范围；备份陈旧则新增备份目录，不覆盖本轮备份。
4. 达到门禁后，沿用ACTIVE所有Compose，加 `/opt/phone-cloud-platform/staging/lookup-readiness-20261015-rc.8/compose.pending.json`，仅 `up -d --no-deps --no-build phone-cloud`。此处只是步骤，尚未执行。
5. 使用足够的有界启动观察（此前过短启动检查曾误判），核对ready/PG/Redis、133文件及冻结文件、Windows新鲜心跳和D-075 live。绑定新已发布版本、源码、镜像、Compose及回执。先单设备/两设备灰度，不直接开放全池。

## 回滚

先停新接单，保存新隔离设备；旧云版本不识别lookupUnavailable，因此退回前对这些设备显式enabled=false。确认在途/未知执行，保留原lookupId/queryId、别名、结果和冷却；不得为回滚强制清锁或恢复旧PG快照覆盖新数据。使用备份ACTIVE中的原7层Compose及a34bcdbb镜像，仅重建云端。Windows保持本次3文件热补，若单独回退视觉则按Windows rc.8备份及原文件hash逐文件恢复并登记，不整体覆盖。D-075必须继续通过。

## 本轮真机验收边界

6条业务5完成（4姓名、1空字符串），162离线原请求仍待恢复；6条超过2分钟换请求键均原lookupId。155空结果是布局补丁后一次明确管理员原请求恢复成功，该操作可能重输号码，不能把API幂等解释为本轮每条只发生一次物理输入。130短暂掉线根因未证实，按用户要求停止派发；155启动退出未再现但不能认定根因彻底消除。自然新触限转交与8小时到期本轮未覆盖，生产全量验收未完成。

## 14:36 前置故障更新

162已重新USB枚举，但ADB驱动安装受两OEM共享co-installer冲突影响，仍不可用。原请求到期后通道unknown，不能强制清锁后部署。详见[驱动维护准备](../adb-driver-20261015/README.md)；该维护尚未批准，云端仍待切换。三次查名失败隔离并不等于暂停Windows自动驱动安装。现有备份须在实际切换前检查新鲜度；Windows旧驱动回绑也可能再次触发冲突，不作无窗口自动回退。
