# 两台清理占用已恢复

源码候选 `wecom-live-state-repair-20261111-rc.3`，提交 `101e749fe0f0ba897754eb2418746cb4e87d94fe`。分支 `codex/wecom-live-state-repair-20261111`。部署详情见 deployment.json；未推送远端。

- 202：新维护任务 `933eec0c-b548-43a2-a7fc-0d8338391b78` 成功，原占用正常 released。双帧时间 47ms、1219ms。
- 200：新维护任务 `b4a27d1d-9612-4775-a36c-6efafd0af3d2` 成功，原占用正常 released。双帧时间 62ms、1453ms。
- 两次签名设备状态复查均在线、上架、无占用。两个原业务任务及四个旧 Windows 任务的 status/result/completedAt 与操作前受限备份相同。没有删除锁、改写失败为成功或重发邀请。
- 云端在原对象激活恢复判定并同步单个模块。Windows 只热更新两个独立 Python 子脚本：维护复核的其他设备分类和重复扫描、普通复核的重复远端授权。云端、Agent、ADB、Windows、媒体均未重启，固定 SYSTEM 身份及既有 ADB 路径保持。

版本：运行镜像仍为联合版 `fc0bb8c3`，叠加已记录的 `server/wecom-preinput-recovery.mjs`。下次启动镜像 `e6a2bf5e` 含相同模块，通过单一镜像覆盖文件登记，未启动容器。全部运行文件哈希核对只有这一项预期差异。Compose 对比使用 no-interpolate/no-env-resolution，仅镜像值变化，既有私有环境文件未修改；不声称已重新验收完整插值模型。第一次完整插值检查缺少单独加载的 XHS 环境变量，未改生产配置来绕过。

回归：企微 Python 622、Windows 维护 25、Windows 普通复核 11、控屏 53、根语法检查通过。新增 socket 边界负例的测试 Wire 最初缺 close，已补齐重跑；独立普通复核测试最初缺相对 fixture，改用已完整隔离的 rc.2 目录后通过。D-075 真实宿主发布前后均通过；Inspector 已关闭。

生产失败保留：202前三轮维护受其他设备隔离 QA 阻挡，第四轮成功。200前三轮受未知短时 `-c` 进程阻挡，第四轮超过三秒，第五轮成功。没有提高五代上限或延长三秒期限。首版 QA 分类仅支持根目录输出，真实 QA 使用 cache/xhs-data-collection；rc.2 补齐严格的同目录、同 UUID 取消/输出绑定。rc.3 去除零字节 connect 前重复全局扫描，connect 后及每次真实发送仍执行完整检查；进程在 connect 期间出现的负例必须无字节发送。

回退：云端原方法保留在原进程维护 Symbol 中；原模块、ACTIVE 和原记录备份在 `/opt/phone-cloud-staging/wecom-live-state-repair-20261111-rc.1/`。Windows 同名暂存目录保留原脚本及各轮备份。需要回退时先核验无企微子任务与现文件精确哈希，再只恢复代码；不重载共享服务，不恢复旧数据库，不回滚已完成证明及防重账本。原进程工具默认 dry-run，不能直接重复执行首轮 apply 脚本。

未完成：Agent 常驻结果压缩函数补丁仍未启用，用户“暂不重载”继续有效。两台没有再次跑新预览；202此前的超时根因未最终确认。正式 CPS 接单仍关闭，正式发送及业务回调均未验收，本轮真实邀请/正式回调为零。此次恢复成功不等同于 CPS 全链路验收通过。
