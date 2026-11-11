# 单次隔离PG失败观察（原件逐字复制）

root审fa2452df/draft.2后只执行一次固定runner。原目录/private/tmp/pc-wecom-v2-pg-3mrc7nik；本目录7文件逐字复制，hash逐项与原RUN_RECEIPT相符，执行source manifest也与当前固定manifest一致。没有运行第二次、连接失败库或修改产品；原失败db保留在原目录，不复制/删除/重启它。

实际TAP14项，7通过/7失败，7失败均为7个代理断链场景的uncaughtException: Connection terminated unexpectedly；Node exit1且自有组已消失，原PG26307 SIGINT后exit0、停止已确认。PG_EVIDENCE有14条body note，不能当作14项通过：Node test捕获未处理事件后，已排队的Promise错误处理仍可继续并写note。runner最终actualPgCases默认0表示未完整验收，不是0项实际执行。

已通过的7项是基础去重/迟到host、同ID并发、异ID竞争、trigger回滚、SQL约束、单行锁不拖另一义务、新Node旧epoch拒绝。7个断链case虽留下预期行/原写1次/新backend等局部事实，进程错误生命周期失败仍使其验收失败，不核销为绿。

本地实际依赖源码确认：pg-pool checkout在344附近移除client idleListener；pg client unexpected end先_errorAllQueries，把query.handleError排到nextTick，再同步_handleErrorEvent/emit('error')。M2 checkout-owned client未装error监听，所以await COMMIT的Promise catch尚未接管时已产生未捕获事件。仅fixture Pool.on(error)覆盖不到这个checked-out client路径，也不能用空回调吞错误。相关实际源码路径/hash/节选在DRIVER_SOURCE_EXCERPTS，root已独立确认。

下一最小片须处理本调用拥有期client事件、锁首错误和失信、查询边界止步、提交未知仍先销毁再独立读、精确listener清理；idle pool生命周期仍由未来接线另审，不改现index/v1/getPool。先真实EventEmitter单元反例与新候选，再更新固定runner交root审，不能直接重启失败库或弱化断链断言。

状态：真实PG部分验证失败，完整验收未完成。无生产PG/Windows/ADB/手机/邀请/部署动作，原43/隔离/查名池/冻结保持；主号与分身真机仍未补齐。
