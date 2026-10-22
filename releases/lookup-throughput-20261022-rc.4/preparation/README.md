# rc.4 发布准备回执

状态：已准备，未切换。用户2026-10-22明确“好的上线吧”；当前5路控屏需要另确认本次约5分钟中断窗口，未重载云端/Agent。

源码95725513b622611f82cebb3c84b8e01485a0887b，标签lookup-throughput-20261022-rc.4。实际生产仍lookup-scheduling-20261021-deployed.1 / 9d227688 / a9e487ec；26云端运行文件及24份Compose旧哈希通过，7 Windows候选前后哈希与语法通过。新镜像350e2f56909b2a17d5a863a1aef8dcc8e7360c1693422b2ba5198b8dc4457dd2，从精确生产基线叠加已提交文件。隔离网络Postgres、production模式启动/管理员后台鉴权及26文件哈希通过；临时容器清理。

最新全量dump、旧镜像、ACTIVE/Compose备份位于云端 /opt/phone-cloud-staging/lookup-throughput-20261022-rc.4-prep.1/rollback，dump目录检查通过；完整恢复演练继承今天rc.3同基线证据，本轮新dump未再次完整恢复。Windows新备份位于 D:\PhoneCloud\staging\lookup-throughput-20261022-rc.4-prep.1\rollback，5旧文件备份、2新增原不存在。镜像/备份SHA256见PREPARATION_RECEIPT.json。Compose合并预演仅业务镜像变化，未启用覆盖文件。

10:56北京时间快照：164、138、114、52、61号控屏；托管执行/人工/排队/通道均0，最近200任务无未终态。单独SQL找到11条7–9月旧queued/running行；与当前接口状态不同，保留为历史行未改写，不据此声称11个现行业务。切换前仍须刷新实际占用。

Agent24968、ADB8988均SYSTEM且未重启，ADB路径/端口保持；媒体宿主机D-075 live通过。Windows脚本第一次-File调用被既有执行策略拒绝，长EncodedCommand超过命令行长度；随后用已审阅脚本文本ScriptBlock执行验证通过，未改执行策略。没有ADB命令、真机新查询、通知或权限写入。

本次准备继续保留10人helper精确权限授予及回退清单；需新代码加载后核对账号、备份能力字段、授予并回读。未执行。实际发布按docs/LOOKUP_RELEASE_PREPARATION_20261022.md流程，保留本轮新镜像与备份、原查询和所有数据；不迁移数据库，不重启ADB/Windows/USB/媒体。真实验收与401根因仍未完成。
