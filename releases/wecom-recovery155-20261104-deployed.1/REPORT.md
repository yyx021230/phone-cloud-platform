# 155补丁部署回执（恢复仍阻塞）

2026-11-04，人类明确批准等在途任务结束后维护。部署候选wecom-recovery155-20261104-rc.1（a91036f，运行源码462eaf3），生产基线32c0091，旧镜像4468f5ce，新镜像aba0ddc3。仅9个云端、17个Agent文件；没有CPS桥接、数据库迁移或真实邀请。

现有查名开关185→186临时暂停新接单，在途任务/结果outbox归零后切换；186→187恢复enabled=true，其余配置SHA256 deeaeb269cba7ca104e697ab3a6ef63a291cfa788d4aaf5be686564b05fe9d3c完全相同。等待拼图和队列请求保留，没有取消任务或重提号码。共享Agent由原SYSTEM计划任务停止/启动，旧19756退出，新15224；固定SYSTEM ADB31384/出生代次不变，确认ADB不属于Agent的任务进程组。未重建ADB、切身份、改keys/动作、重启Windows/USB/媒体。云端02:36:02Z重建，02:37:25Z health/ready均200，后检Postgres/Redis正常、141总设备/125在线、lookup outbox=0。新恢复能力已上报；控屏按批准范围短断并重新出现连接。

155仍在线且清理围栏pending。管理员GET恢复提案返回409 ineligible；没有POST恢复任务、没有清锁。原job/task/两个lock与维护前四条记录完全相同，独立只读模块校验这些数据库原件符合条件；但原job已有5311条、task已有5343条更新记录排在前面，生产启动只加载最近5000条，导致内存缺少原上下文。原记录没有丢失。后续须本地修复“pending义务关联上下文不受历史窗口裁剪”，不能调大全局历史上限或手工注入状态。

D-075真实媒体宿主发布前后verify --live均通过，PID2503525和自定义binary SHA d3a9eab65555680f1a7efe6d1746f315e25c69059d49aff40a0a45d292feec35，8Mbps/2包保持。实际26文件hash已验证。原生SYSTEM恢复proof、新企微主号/分身业务API未验，不宣称155恢复或生产全量验收。

回退材料在/opt/phone-cloud-staging/wecom-recovery155-20261104-rc.1：ACTIVE-before、原35份Compose引用及hash、旧镜像、rollback-runtime.tar.gz、四条原记录；Windows同名stage/rollback-agent存实际17文件旧值清单（新增文件记缺失）。只退业务镜像/Agent文件，不回退数据库、不删除围栏/尝试、不动共享ADB/身份/媒体。全库没有导出。后续回退需先排空并告知维护影响，不能在线盲目覆盖。

本轮测试沿用精确运行字节准备回执：test:all Node2516/2512通过/0失败/4条件跳过，后续Python/smoke完成；155独立真实PG1通过，Windows mock12及JS语法6通过。生产只读就绪/身份/hash/媒体和155原主键验证属于本轮新增证据；无法替代原生proof。
