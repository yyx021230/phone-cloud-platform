# M3私有PG后继最小切片（仅方案，默认禁启）

基线36be03d4168ca7bd2ed3c0dcf0bde92b3d12f2b7/observed.2；产品215fb15只为未接线新叶，bab3b9专属私有PG18/18，root4ba4ccd4闭合。保留首次17/1和旧失败DB。下述未实现，不新增PG/Windows动作，不改共享入口。延续主文档M3分片，不替换D-075、SYSTEM/ADB冻结或用户“停在邀请前、不影响查名”要求。

## 0. 已验证与未齐

已验证：本机PG16.15/pg8.22/Node25.9的六步NOWAIT/五DML原子claim、固定IDs的全tuple重读、真实断回复不重写、合成旧锁序交错与DDL约束。未证明生产旧writer共存、配置重绑屏障、journal、真实Windows父子/peer/时钟权威或原43清理。新叶始终protocolPermit=false/liveChecksRequired=true/mappingBarrierVerified=false/productionEnabled=false；anchor ready合成值不是运行许可。

M2原完整PG14是在加claim_data前通过；新18的legacy组仅NULL+host窄兼容，不代替完整14与新DDL复测。该兼容检查可与纯策略设计独立准备，仍按新固定源/新库另审，不重启任何旧库。

## 1. 当前写入/读取入口实际证据

| 当前代码 | 现状/必须处理的边界 |
|---|---|
| index领取分支及snapshotWindowsTaskClaim/restoreWindowsTaskClaim | 旧异常restore可删新增hold；不能用于v2 COMMIT未知。当前v2没有接线，不擅改旧路径 |
| wecom-cleanup-service.transaction/checkpoint/checkpointWriting | 现v1有committing和checkpointFences，但finally会删内存fence，错误回滚是旧快照；不冒充v2持久未知义务 |
| saveState/savePostgresSnapshot | checkpoint spool/full-state blob；PG先truncate phone_cloud_state，再pending task/job/hold，之后structured sync。只保护结构表而忽略blob/启动重建会漏掉v2义务 |
| persistTaskMutation/syncStructuredTables | task→job与job→task两锁序均在；普通UPSERT能回写业务投影，不能靠新叶NOWAIT宣布它们都兼容 |
| activeDeviceLockForTask/ForScreenControl、managedLookupReservationLock | 现读v1 pending/state锁与lookup reservation；未读新anchor/ledger。必须联合后才可说查名/控屏不冲突；现有控屏不被主动断开 |
| PUT /api/v1/devices/:id、applyAdminDeviceName | 目前先改内存deviceName再persist；v2映射变更不能在屏障确认前先改可见状态 |
| syncAdbDevices/updateAdbDeviceState/upsertAdbDevice | 心跳可改Agent/serial与自动名字，匹配忽略serial大小写；普通lastSeen/battery/state变化不是稳定映射重绑 |
| loadPostgresState/JSON bootstrap/structured hydration | 重启时只读旧blob不等于读到canonical v2；启动禁派发与canonical持久义务重建须先完成 |
| Agent createPhysicalLifecycle/reader_bootstrap | 现v1 HTTP ready/close、子进程自报+psutil parent/path检查不是新v2真实事实提供器；cross-host wall chronology不能继续当v2授权 |

## 2. S1优先：纯共存策略，不接共享writer

最小下一代码建议仅新增纯wecom-v2-projection-policy叶/测试，输入是可信存储owner将来提供的canonical固定tuple及待写记录，输出逐目标decision（legacy_candidate/retain_canonical/reject_target/ownership_unconfirmed），无SQL/共享数组修改、无ready/执行许可。legacy_candidate也不是允许写入或执行，只表示仍需旧业务/实时检查。canonical来源真实性不能由caller布尔替代；缺投影/关联不齐仅拒绝该物理目标，不清原hold，不升级v1。旧合法状态与M1revision进展沿现矩阵，不拿原queued整JSON当永久锁死条件。

先明确持有对象：v2 ledger/anchor是持久义务；task/job/hold是受保护关联投影，original business lock可合法释放但不释放物理义务。业务成功/超时、管理员取消、旧TTL过期均不清active；旧v1/NULL记录不签新v2 IDs、不重标原43/147/52。只纯策略，不把它称运行门禁。

后续共享集成必须由root单独分派，拟动index、postgres-repositories、wecom-cleanup-service和persistence policy，当前不改。需要全部writer/restore/compact/启动恢复清单；不能只补status endpoint。

### S1b具体并发风险与待审实现约束

不能只在checkpoint开头读一次v2 ID集合，或只加NOT EXISTS ledger子查询：READ COMMITTED下语句快照可能看不到尚未提交ledger，随后等task行锁，M3提交后旧UPSERT仍可能用旧快照覆盖。真实PG场景必须覆盖这个窗口，不能拿source grep当证明。

拟方向是每个受保护task/job/hold写都对**当前目标行**的v2标识做条件保留/CAS，并核返回值；新叶在同事务先锁task后写v2标识/ledger，旧writer若先得行锁则M3 NOWAIT拒绝，若后得行锁须验证更新后可见目标仍不属v2。已有ledger但投影缺标识是冲突，不能当旧无主记录允许覆盖。条件SQL/EPQ行为须精确单独提案并真实PG核验，本文不假设已成立。

普通checkpoint遇某台受保护/未知v2记录不能用全局throw导致其他手机整笔失败；应保留该目标canonical投影/禁派发并继续其他无关目标。不能使用会让整笔checkpoint失败的全局trigger掩盖这个需求。若策略无法在同一事务保证目标保留与其他记录进展，则生产继续禁启，先改writer设计，不调大锁等待蒙混。

full-state spool与structured投影都不得发布未提交candidate。启动必须先从canonical账本重建每物理设备pending/unknown fence，再开派发；blob只作旧业务数据来源，不能覆盖新canonical身份。出现快照回退/数据库不可确认，目标手机不可用，其他已证实设备继续；v2未知不能走旧restore删新hold。进程内队列不是持久跨实例排他，DB anchor仍是最终序列化点。

验证矩阵：旧两锁序真实交错、旧statement在M3提交前取snapshot后等待行锁、取消/过期/maintenance、原业务锁释放、重复checkpoint、目标row缺标识、进程重建、任一点写错/COMMIT丢回复、多个serial同轮checkpoint一台冲突不阻其他；现有媒体/控屏回归仍须由root接线阶段执行，当前未跑。

## 3. S2设备映射屏障（仅设计）

稳定mapping字段为deviceId/serial/agentId/真实编号；fingerprint沿已审数组，revision受DB owner维护。lastSeen/battery/普通在线离线只影响live availability，不为每次心跳更换mapping revision或全局禁用。

需要参与的入口：管理员改编号、Agent scan/upsert实际serial或Agent归属改变、自动名字权威变化、导入/恢复/JSON bootstrap/设备别名合并和generic device UPSERT。旧入口尚不全，不能让某个provider返回ready=true就开放。

拟新映射事务：先锁已有anchor NOWAIT，active或旧v1 hold/lookup/control占用则拒绝变更；确实变更先将anchor disabled并递增revision，与device写入及可见内存交换形成同一提交边界。多物理映射需固定serial字典序锁，缺anchor不创device/anchor。不能“先改device再事后停用”，也不能为完成改名取消现有业务或断控屏。事务未知保持该目标disabled/unknown，不能用旧内存restore宣称已回滚；重新启用需单独校验全部条件，不随重启自动ready。

此方案不修改实际控屏映射/传输/重连逻辑；新请求可否领取的联合检查与冻结媒体实现分开，涉及共享入口由root核影响与现有投屏回归。与现有受控人工接管权限的冲突也要按同一个已持有业务/物理身份核验，不能绕v2 fence或以管理员覆盖默认放行。

先准备纯字段差异/改绑策略和SQL事务提案；没有生产初始化或启用器。没有参与屏障的写入口、映射歧义/缺设备/旧v1义务均使目标v2不可用。其他手机heartbeat/在线检测与恢复队列不能被该目标阻塞。

## 4. S3 journal拆片与恢复（仅设计）

S3a先纯格式/转移叶：exact binding13+claimOperationId/originalJobId/originalLockId、固定host/close操作请求、父子machine/PID/creationToken身份、bounded phase/revision/record sequence。业务手机号/备注、Agent token/HTTP认证头/口令/ADB密钥/完整任务payload不写。协议nonce/handshakeNonce是固定关联信息，文件受限且不进日志，不把其存在当真实OS权威。操作IDs生成一次，重读/断回复只重发同一操作，不能换nonce“恢复”。

S3b单独IO适配器：专用现有SYSTEM-owned目录/受限ACL、同卷原子替换、完整写入/flush/close及截断/损坏/版本校验、路径归属/重解析点拒绝；Windows持久性和ACL需实际证据，不能拿macOS rename/fsync单元或文件已存在替代。API选择/完整命令/失败模型与回滚先审，本文不声称Windows断电durability保证。不得改Agent/ADB身份、keys/env/启动方式，或新建SYSTEM入口绕过既有限制。

S3c恢复协调器先纯计划：读取journal与server完整tuple，一致且当前epoch/parent instance/原操作确认后才准备下一步；journal成功写入和server存储确认是两个独立条件。任一未知、损坏、旧epoch、部分写、ACL/磁盘失败、原reader生死不明，保留该物理义务，不重启/重放UI、不清active、不因为业务终态删journal；其余手机继续。缺journal不能推定无reader。真实parent/reader已关闭和后继物理verification尚未验之前，不提供清active实现。

本地反例：每个写点失败、重复/乱序记录、半截/旧版本/误路径、稳定ID变更、server commit未知、进程重启只对账不查人、两手机单台journal失败不挡另一台。后续Windows自有文件验证必须固定源/argv/目录/归属/预算单独交root，不接真实SDK/手机。

## 5. S4真实host/peer/时间权威（root共享入口，未实现）

现M1/M2/provider只做形状/关联/存储，不证明来源。当前只读Windows API-set时钟采样和owned普通stdio验收不等于生产Agent/SDK权威；当前ADB进程存在也不代表它是已批准执行baseline。不得自行读ADB、起服务、换身份或重建。

需要真实现有SYSTEM parent instance、当前自有child对象/PID-born-machine、实际连接peer/传输归属、child当前epoch/握手关联，以及同host单调时钟与出生token的已审核转换/能力边界。nonce/checksum/路径字符串/客户端自报不能替代这些事实；不再跨云端wall比较Windows出生或close先后。时间源不可用或bootstrap事实不齐必须返回unsupported，不自动换一种时钟/进程/SDK路径。

先接口/事实来源/隔离Windows验证方案，再root绑定共享执行器；两项目共享SDK/transport/worker shutdown不由本owner碰。关闭reader必须观察该确切自有child真实exit/close，killed=true或PID现在不存在单条信息不直接释放旧义务。旧43的原始缺失事实无法追补则维持隔离，另审具体单机维护，不拿新协议回填旧记录。

## 6. 兼容验证与真机入口

M2兼容源码后继复制其原14 bodies，最小仅before hook在M2 DDL之后应用新claim DDL；固定原body hashes并单列14结果，不能把新18或窄legacy代替。另加真实claimed row经原M2 host/close推进后M3 tuple重读的独立场景，不修改原M2产品代码。完整runner/依赖/预算/新root先审，仍不执行。

真正开真机前条件：canonical旧写共存/映射屏障全、journal与host/clock支持、重启恢复默认安全、原义务保留、具体已提交版本与运行hash核对。查devices取得当前空闲而非旧缓存，不占155/157或lookup reservation/控屏/其他任务；主号/分身同物理不并发，手机A卡住不应堵手机B。上一轮只读清单中只有155配置clone且与lookup重叠；这是历史记录，实际配置/空闲必须真机前重查，不能硬抢。

授权目标仍为尾号6441，走首页→选主号或分身→搜索→备注填写→预发送页，必须证明未调用发送点击。外部customer-invitations当前为send接口，不能为满足“外部API验收”去调用它做预览；预览走已支持preview入口，未提供外部no-send模式前该项列未验，不伪称全外部API链路通过。新接口如需改动另立最小候选，不在本存储方案夹带。

本轮只交此方案、源码baseline/文件hash与主文档日志，无代码、测试、PG、Windows或生产动作。建议root下一先定S1纯策略叶边界；shared writer/S2/IO/Windows均不得从方案自动扩大为实现授权。所有阶段都不宣称“完美无缺”或真机已通过。
