# lookup-throughput-20261022-deployed.1

状态：已发布待真实业务观察。用户明确授权上线及本次5分钟窗口内控屏短暂断开（含新连接）。运行源码为`95725513b622611f82cebb3c84b8e01485a0887b`，候选标签`lookup-throughput-20261022-rc.4`；当前分支`codex/lookup-unavailable-20261022`。无远端推送，根仓已有改动未动。

## 实际切换

- 北京时间10:58:34进入维护，11:00:14云端ready，约100秒；窗口内原控屏为164、138、114、52、61，业务任务为空才切换。没有取消原查询或清理业务锁。
- 原生产`lookup-scheduling-20261021-deployed.1`/`9d227688`/`a9e487ec`；新运行及下次启动镜像`sha256:350e2f56909b2a17d5a863a1aef8dcc8e7360c1693422b2ba5198b8dc4457dd2`，已写ACTIVE，新增Compose仅替换业务镜像。26云端文件、51累计运行哈希、7Windows文件核对。
- Windows Agent24968→5176，使用原计划任务且动作不变、单实例SYSTEM；ADB8988原路径/5037/SYSTEM未变，无ADB客户端命令。媒体2503525保持、D-075实际宿主机前后live均8Mbps/2包，二进制hash未变。没有重启Windows/USB/数据库/Redis/媒体或进行数据库迁移。
- 精确10个账号`lookupHumanControl:true`已通过管理员API授予、回读；保留普通角色、密码和其他权限。能力原值备份位于本轮云端rollback/helper-capabilities.before.json。用户名/ID按原已确认名单，不模糊匹配；实际人工控屏新一轮尚未验收。

## 验证与边界

此前本地1053项Node、JSON/隔离PG各50条模拟HTTP、零容量30并发拒绝、121秒换Key防重通过；Windows原生历史21图双帧通过。当前实际发布新镜像隔离production模式+PG启动通过。

本次生产health/ready均200，业务/Postgres/Redis healthy且0重启计数；14公开静态文件哈希匹配，另4个公网健康/鉴权检查通过，管理员后台API可读。11:00:39库存138、127台新鲜ADB在线，托管执行/人工/排队/通道为0；Agent新鲜心跳、lookupPostHumanProtocol=1；11:02:20状态outbox为0。没有为了验收而发送新号码/拼图/通知，没有改API Key或48台设备池。

上线后有界2000行日志中0个HTTP500、0个fatal/unhandled，仍有226条401提及，达到行数上限；401是此前已见的待定位项，不能以健康通过宣称全部错误已消失。新查询的真机提速、自然触限/冷却、未知页面和5台真实并发，待外部开发今日业务实测；模拟/离线OCR不代替真机验收。

此次合入管理员查名后台、10人协作、人工后状态闭环、准备错误分类/释放与队列调度、姓名卡关联与无姓名布局、新版限制页、跨机保持总期限，以及启动/查询中零能力反馈。新号码无能力503/accepted:false；已受理原单保留，queued GET给容量反馈，processing仍等待安全恢复/转交，completed结果可读，不把异常当空姓名。

## 回退

云端备份：`/opt/phone-cloud-staging/lookup-throughput-20261022-rc.4-prep.1/rollback`，完整dump/旧镜像/ACTIVE/Compose及hash见准备回执。新dump目录校验通过；完整恢复沿用今日rc.3相同基线演练，不声称新dump重新全量恢复。
Windows备份：`D:\PhoneCloud\staging\lookup-throughput-20261022-rc.4-prep.1\rollback`，5旧文件备份、2新增文件原不存在。

如果需要回退，在获准维护窗口用原Compose及`a9e487ec`旧镜像，仅恢复7文件对应旧状态并沿用原SYSTEM任务；保留当前数据库、已完成结果、冷却和新增请求，不回灌旧dump，不撤销JSON快照修复。需要撤销helper授权时只恢复10个账号的能力原值。ADB/SYSTEM/媒体冻结继续。回退后重复组件、健康、心跳与D-075核对。

部署回执已保存云端`/opt/phone-cloud-platform/deploy-receipts/lookup-throughput-20261022-deployed.1`与本目录，候选标签不移动。自审：只发布已提交哈希范围，授权窗口内操作，没有附带驱动/身份/冻结链路变更。
