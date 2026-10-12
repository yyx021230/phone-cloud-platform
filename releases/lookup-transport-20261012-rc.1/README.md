# 130号查名短暂断线容错候选

版本 `lookup-transport-20261012-rc.1`，状态：本地候选，未部署。只拟替换生产查名Python一个文件；源文件SHA256在VERSION.json，与Windows实机一致。原不可变候选和共享Agent代码不改。

本轮35秒只读采样直接看到130两次从ADB列表消失，分别约1.87秒和1.36秒，回归后的transport_id变化；同轮单次API诊断启动失败、0号码、锁释放。底层断线原因未确认；手机在线快照不能证明稳定。本补丁修复页面读取对短暂断线立即失败的处理，不宣称修好了USB/驱动/硬件。

页面快照仅在精确目标device not found或device offline后等待本设备get-state，两次在线样本后只重取一次快照，最多等待8秒；不重放启动、账户切换、点击、输入或查询，不重启/重连ADB、不触及USB/PnP/投屏。持续断线、二次断线、未授权、其他错误停止。正常路径没有额外探测。

## 实际验证

- 10项故障注入：生产基线7失败，候选全通过。包含恢复、永久离线、有界探测超时、其他设备/权限错误、二次断线与未授权。
- 原有Python执行器163项回归使用本候选加载，全通过。只是本地fake/mock，不是真机修复验收。
- 130诊断创建一次失败，未提交号码；该会话终态，两测试设备不增加新消费。03:36 UTC目标锁/会话0，生产health/ready200，全平台8锁。
- 真实安装候选、双设备HMAC闭环、底层断线来源仍未验收。原表59/60仍未消费。

复验（仓根）：`python3 releases/lookup-transport-20261012-rc.1/verification/transport_recovery_test.py`；`python3 releases/lookup-transport-20261012-rc.1/verification/run_existing_tests.py`。补丁见verification/lookup-only.patch。

## 生效和回退准备

生产白名单仍是历史配置；用户指定的130/118已形成只替换deviceIds的预览，沿用 `releases/platform-api-integration-20261012-rc.2/CONFIG_CHANGE_PLAN.json`。启动时读取配置，生效必须重建业务容器，不能只改.env或docker restart。当前还有共享任务，不擅自停服。

收到具体发布/窗口授权后：核对ACTIVE与运行/下次启动镜像、Compose/.env/源文件哈希；真实媒体宿主机D-075 live核验通过；备份原.env和单个Windows脚本/权限/哈希。容器仅用ACTIVE记录的双Compose与71b02934镜像重建业务服务，不重启Windows/Agent/ADB/媒体。Python只在目标闲置时原子替换该脚本，新任务加载，不重启Agent。先130单设备有界验证，再118；只用原授权批次未消费号码并保存原session/query/idempotency IDs。将实际生效组件哈希、配置及回退位置写入发布回执；生产主事实记录新的组件版本，不能仍称无漂移。失败恢复备份脚本/.env和已核对镜像，不回滚数据库或媒体，不取消他人任务。

本轮原仓235项既有改动及并行主文档工作保留；仅本独立分支产出，未推送/上线。无真实通知。
