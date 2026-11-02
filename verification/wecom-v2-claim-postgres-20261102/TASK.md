# M3a独立存储叶，本地fake阶段

基线ccc38ae38769c91ce5530a77a82257a427990776；root审查561232cbff9ebcb05310dc386f05efc9ff18d4ac后明确限定新叶/新DDL/本地测试。主号和分身真机验收尚未进行，不执行发送邀请、不占用线上手机。无PG/SQL执行、监听端口、Windows、ADB或部署动作。

新增server/wecom-cleanup-v2-claim-postgres.mjs及同名测试、独立deploy/sql/wecom-cleanup-v2-claim.sql。M2/M1/旧DDL/index/getPool/Agent未修改。新模块无初始化/种设备/启用/清active/执行器或journal。初始anchor disabled；没有任何把旧映射写入纳入屏障的实现，生产不能启用。

六步同loader锁序anchors→task→job→hold→originalLock→ledger，每个SELECT NOWAIT；5条DML完整RETURNING/JSONB验证。queued→running依原始完整JSONB CAS，合法后续进展按固定claim关联/业务指纹重读，不用原queued全JSON作终态比较。结果不返回原业务数据，始终protocolPermit=false/liveChecksRequired=true/mappingBarrierVerified=false/productionEnabled=false/fence=held。此fence是保守义务状态，不声称已经建立现网跨业务互斥。

readDeviceMapping依赖未来可信server代码提供实际设备投影和mappingRevision，不接受ready布尔值；形状验证不证明配置写入屏障。必须同时保留“屏障未验”的结果，数据库anchor ready也不授予执行。上下文固定一组IDs/审计时间，工厂不生成新ID。COMMIT未知退役原连接后同序有界重读，缺记录/全无/锁失败不自动重写；无外部全局连接error吞错。

实际本地新叶67项通过（SQL-shaped fake + 真EventEmitter，不是PG），另原纯claim55/M1 61/M2 39/业务11在本轮独立回归共166通过；JS syntax通过。不能将67或166与历史PG14累加。fake不模拟行/唯一锁、SQL约束/触发器、驱动socket语义或真正并行事务。主号/clone与send仅合成数据，没有任何真实发送。

初版57项54过3失败，原件及源码在initial；同物理clone fixture错误地给了另一个设备编号，正确应主分身同编号，修正fixture。两条篡改号码/备注被正确拒绝但错误分类为unavailable，现归tuple conflict。第一次shell以tail退出码结束未保留node exit，另原样源码复现得到exit1，分别记录。新增M1进展测试第一次把既有纯函数参数顺序传反，67项66过1失败，独立原件在progress-fixture-red；只修新fixture调用，未改M1。

DDL是未解析/未执行的新迁移候选。完整数据库约束及真实PG场景源/新runner下一阶段固定后交root审；本阶段不继承旧M2 runner执行授权。仍须真实库验证不同task/slot同serial只有一个成功、不同serial独立、旧双锁序NOWAIT、映射禁用交错、完整tuple矩阵、每写点/返回值故障、COMMIT真实丢回复及约束反例。原43/147/52保留，155/157查名池不触碰。
