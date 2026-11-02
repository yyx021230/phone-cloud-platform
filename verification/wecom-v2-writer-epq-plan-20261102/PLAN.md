# S1b writer/EPQ、full-state与启动overlay：精确待审片

基线4adcc0d3f3a1779937d867a11ef793dad759614a；原M2新DDL兼容14/14与独立claimed2/2已封存。S1纯策略64、M3本机PG18均是独立阶段，尚未接共享writer/现网。本片只方案和未执行comparison-queries SQL字符串，不能直接用于生产，不修改index/repositories/cleanup-service/配置/Agent/DDL。

## 1. 已读实际入口、锁序与列

| 调用点 | 当前实际路径/次序 | 后继要求 |
|---|---|---|
| index:state await loadState、structuredRepos.loadOverlay/applyStructuredOverlay（约238—245） | snapshot→可选structured overlay，STRUCTURED_WRITES关闭就不走该overlay | 新持久义务owner bootstrap必须独立完成，不能依可选dual-write开关推定无义务 |
| normalizeLoadedTaskHistory（约248）、task-history-maintenance | terminal任务删除delivery/二维码字段、sanitize result/events，不会主动删v2 claim；不能据此保证未来lookup wait字段一定保留 | owner refs/固定身份在独立规范化阶段保护；不允许业务sanitize赋予执行/释放权限 |
| 启动screen orphan lock释放（约416）、初始化managedLookup等 | 可能在新wecomCleanup service建立之前写structured或saveState | bootstrap fence须早于一切可能落盘/派发的启动维护，保留旧控屏语义与冻结链路 |
| index领取persist及snapshot/restore（约2250—2370/4254—4290） | 旧restore会恢复业务快照并删新增WeCom hold | v2未知/lookup execution wait的owner义务不能走旧restore删掉；只明确known无副作用前置回滚才回滚业务候选 |
| postgres-repositories.persistTaskMutation（327） | 可选device→task(s)→xhs→job(s)→session→physical/business lock→events/audit | 整个bundle逐物理目标分组；目标存储身份不齐拒绝该组，其他device组继续 |
| persistDeviceMutation/persistDevicesMutation/相关设备writer | device及audit，可能改稳定映射 | S2未实现前不得借S1接线启用v2改绑；heartbeat可变字段与稳定映射分开，不扩大本片 |
| persistWindowsTaskDeliveryLease、status/event/cancel/expiry/maintenance路径 | 部分是定制UPDATE而非上述UPSERT；其他路由大量调用persistTaskMutation | 不能只补UPSERT；定制delivery字段与JSON path写也须在owner矩阵列清 |
| saveState→compactTaskCollectionsForSave→wecomCleanup.checkpoint→spoolSnapshot | spool在PG transaction之前；v1 checkpointFences只覆盖旧类记录 | 不发布未提交candidate/unknown消失的blob；新owner refs不靠旧v1 fence保留 |
| savePostgresSnapshot（8766） | BEGIN→truncate phone_cloud_state→write blob→pending task/job/hold→cleanupBundle→可选syncStructuredTables→COMMIT | 同一checkpoint中target级savepoint/owner协调，不用一台冲突让整批失败；未知commit不重放/清fence |
| syncStructuredTables（8937） | device→job/session→task→locks，与task→job顺序相反；这里旧UPSERT与通用repo不是同一SQL | 两处都处理；NOWAIT/明确目标owner协调，不以某一处修过代替另一处 |
| pruneState/pruneArray（7367） | task/job按业务terminal/retention可移除；deviceLocks虽保pending但不自动pin原task/job | canonical义务引用的原ID即使业务terminal也必须保留/从owner重建；lookup wait相关session/channel/request同理 |
| snapshot-stream.loadStreamedSnapshot与applyStructuredOverlay | blob/最近5000条投影、pending v1 locks专门补载；当前没有v2 anchor/ledger或新lookup wait owner恢复 | authoritative owner全待处理引用先加载，不受recent limit悄悄遗漏；超限/未知不能成为空闲 |

当前task列task_id/agent_id/adb_serial/status/created_at/updated_at/data，job列job_id/device_id/user_id/kind/status/created_at/updated_at/data，lock列lock_id/device_id/status/expires_at/data；anchor/ledger精确列沿已审M3。候选SQL使用这些真实列，未改表。已有business original lock **没有v2 marker**，不能假装task/job/hold marker已经保护它。

## 2. SQL分为负例、窄控制和未来owner，不直接接writer

PostgreSQL16官方说明：Read Committed查询以语句开始快照找行；等并发更新结束后会对更新后的目标行重新评估条件，INSERT ON CONFLICT UPDATE也可能作用于语句快照本来不可见的冲突行。见[事务隔离](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-READ-COMMITTED)。因此“已在开头查过ledger”不足以证明旧writer安全；**本项目NOT EXISTS子查询在该交错下的实际结果仍须真实PG反例验证**，不把文档推导当实测。

comparison-queries.mjs是无副作用固定SQL字符串：unsafeTaskNotExists/unsafeBusinessLockUpdate仅负例；guardedTaskUpdate/Upsert、Job/hold upsert只验证当前目标row marker的窄EPQ行为，不是完整业务门禁。task/job当前data有wecomV2Claim（即使null）或task physicalCleanup.version2则拒写；hold有v2 binding拒写。保留旧timestamp条件并加括号，不以新时间戳候选绕过marker。缺projection行不能用INSERT重建：必须先经过canonical owner完整tuple检查。

ON CONFLICT WHERE拒绝的行不会出现在RETURNING，见[INSERT RETURNING](https://www.postgresql.org/docs/16/sql-insert.html)；因此0行不是成功覆盖，也不直接代表全局异常。owner须在同target事务用新语句重读当前行+canonical进行分类：已持有正确v2→保留；ledger/anchor有而projection丢marker/缺行→拒绝该target/保留义务；无canonical只有在受审完整读取证实后才legacy_candidate，仍要旧业务检查。RETURNING必须核rowCount/rows长度/精确列/日期JSONB/身份，不只看“query没throw”。

**原business lock、device/session等无v2 marker的投影不能靠这几条SQL保护。**拟每个参与writer先对已有physical anchor NOWAIT取锁，再用新SQL语句读完整owner tuple，后写target；同device多row按M3 anchor→task→job→hold→business→ledger，多个device按physical_key稳定排序或各自事务，缺anchor不隐式建。当前new lookup wait是否使用同一公共物理协调点必须由root定精确原子协议；本文不把WeCom专属anchor自动变成跨业务门禁，也不把两条连接分开的mutex当原子。

未来v2业务status/result/events推进必须有**独立controlled owner transaction**：锁完整tuple、核immutable与允许状态迁移、task/job完整JSONB CAS及RETURNING、commit已知后才发布该请求结果。不能把所有v2 generic写简单skip后就称业务结果能落盘。controlledTaskCas仅给此路径验证，不给checkpoint调用；M1 host/close仍由原专属repository，不共用业务状态操作/ID。

## 3. target级失败隔离和COMMIT未知

拟shared bundle coordinator先按physical target分组，为每组SAVEPOINT；NOWAIT冲突/错误projection只ROLLBACK TO该target savepoint，保留canonical/unknown引用，不作该target写入；无关target继续其验证/更新。不能放全局trigger使整笔checkpoint回滚，不能吞SQL错误后在aborted事务继续。SAVEPOINT名字固定代码生成/参数不拼用户文本；执行后检查失败目标无变更、独立目标确实提交。失败连接/COMMIT未知是整个transaction信任问题，与单台target冲突区分，不谎称其他写已知成功。

checkpoint本就持phone_cloud_state锁；新M3不取该锁，旧双锁序交错需实际验证NOWAIT退出，不延长全局等待或改共享pool错误处理。COMMIT未知退役旧client→原IDs重读，不调用旧restore去删除任何WeCom/lookup持久义务，不能重播整轮其他device。恢复结果逐请求返回，不整轮等齐；具体业务owner的durable状态/幂等由各自协议处理。

## 4. full-state blob与两个owner的扩展边界

lookup负责人正在准备executionWait v1状态/存储候选；当前不是已实现canonical库。其session/channel/request JSON或pool索引可能被旧blob/checkpoint/旧镜像遗漏。不能只往JSON添wait字段即宣布持久化，也不能让本owner替对方定义真实store/schema或合并两协议。

拟root统一的checkpoint/boot owner registry只收**两个独立引用域**：wecom canonical obligation/claim/physical/epoch refs；lookup executionWait canonical引用及其session/channel/request/generation关联由lookup owner定。各自状态/操作ID/host事实/释放判断不互换；一方unknown只禁止相关物理目标新admission，不改另一协议义务。不把两个JSON里的true标记当来源证明。共享hunk index/repos/saveState由root统一，不在两个分支各改。

full-state snapshot中的owner refs只作保留/发现线索，绝不授予执行/释放权限。已知canonical行用规范化投影保留；缺行/unknown保留opaque引用和target unknown状态，不用旧queued记录或“空refs”消除义务。不把完整canonical快照/敏感任务body写入日志；并发未提交候选仍只留owner私有pending，不进入spool。structured与blob都要验证，不能只屏蔽structured写却让blob恢复出新权限。

旧镜像不认识这些域时不得运行新协议，部署/回滚能力门控必须root另定：读取schema/owner capability失败则新协议disabled/相关目标unknown，不能自动降v1或重签IDs；回滚材料须保留新canonical存储。普通旧业务与既有控屏不借此被主动断开，数据库整体不可用等真实全局存储故障则如实影响readiness，不伪装单机失败。

## 5. 启动顺序和retention验证

拟顺序：加载legacy blob→可选structured overlay→**分别加载两个owner待处理canonical refs/完整必要记录→建立每物理target held/unknown fence→受保护ID overlay/pinning→历史normalize/compact/prune→启动任务admission**。任何启动维护可能写盘/释放锁前必须看到此boot guard。不能仅将refs塞入state后就视为bootstrap完成。

canonical缺task/job等为unknown，不自动从blob“修复”、不升级legacy NULL。structured recent5000限制不得裁掉持久义务，完整cursor/有界分页及overflow处理由owner明确；不完整时该新协议不能ready。prune按canonical关联pin原task/job/lock与lookup指定refs，不因terminal/TTL删除；normalize仅允许批准的可变业务字段，不删owner身份。重启不能从blob缓存hostClosed/ready或lookup请求“已超时”推导可执行。

## 6. 只验证用源码/实际PG场景计划（未运行）

首个最小真实PG片建议仅task EPQ三对比+target隔离，先不实现全shared writer：新私有库/已审M3 fixture，事务A持task行并写新v2 marker+ledger未提交，事务B发旧NOT EXISTS/marker UPDATE或UPSERT，第三owned backend必须观察B active/Lock且pg_blocking_pids包含A，再让A提交。保存B语句快照/实际阻塞/rowCount/RETURNING及最终JSONB，验证负例可能覆盖而marker控制不覆盖；不能sleep猜测或把预期写成通过。

随后独立补job/hold、原business无marker负例→anchor参与控制、v2projection缺失拒绝不INSERT、两旧锁序/多个target savepoint、rollback/COMMIT前后断回复。所有负例只在reviewed新库，不能用生产日志推演出通过，不能因一例不合预期改断言到绿。

blob/boot验证源另片：old blob queued+new canonical held；structured保持但blob漏refs；只lookup wait/只wecom/两者并存一台unknown另一正常；新owner读取异常/overflow/中途断开；旧restore/prune/compact试图移除refs；重启先boot guard后admission；旧镜像不认识schema→disabled；混合device证明另一条已知安全写实际COMMIT完成。当前只是场景/调用顺序，不创建新执行器、store或owner真值来源。

本轮唯一实际检查是comparison-queries.mjs的JS语法与实际基线hash/文件差量，无SQL解析、PG执行或业务代码修改。原43设备清理义务/147/52、155/157查名池和所有冻结保持；S2映射、journal/native与主号分身真机仍未闭合。
