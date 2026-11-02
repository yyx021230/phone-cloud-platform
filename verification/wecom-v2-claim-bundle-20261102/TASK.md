# M3a第一片：纯claim bundle候选，未接数据库或手机

基线66c4eb89e3624e8ac92db999c38c8b9805c36c40，原干净；分支codex/wecom-v2-claim-bundle-20261102。root限定仅新增纯叶/测试/fixture/docs。没有改M2 repository/DDL/index/getPool或运行PG，物理串行化anchor及精确SQL/旧写锁序仍另提案，不在本片实现。

## 接口/输入与固定关联

createWecomV2ClaimPreparer仅接受readClaimContext代码provider，options严格单字段；工厂捕获一次服务器尝试，后续每次读取必须完全相同，不能在未知重试时悄悄生成新execution/claim/nonce/recordedAt。模块不生成ID、不读当前时间/随机、不做I/O。provider来源由未来可信服务器接线负责，shape不证明认证/父实例/时钟。

context完整字段：binding（复用M1严格v2）、claimOperationId/originalJobId/originalLockId/ownerUserId/requestId/mode、已解析target(deviceNumber/appSlot/androidUser)、原业务fingerprint、recordedAt。target须未来服务端现有配置解析器给出；叶只校验一致性，不自行读取设备配置或声称机型已允许。新物理hold ID不得等原业务lock ID。

input严格task/job/businessLock/device四记录。这里只接**新显式v2 standalone** queued记录：task.payload与job均有数字wecomCleanupProtocol=2，mode/slot明确，session为空、无picked/completed/历史result/send claim/既有physical binding。旧NULL/缺版本/旧v1不自动升级；此新marker目前没有写入任何现生产producer，未改外部API。

所有task↔job↔owner↔lock↔device↔Agent/serial↔request↔mode/slot关联严格核对。现WeCom原business lock的appSlot本来是空字符串（整机锁），保持原语义，不能当main/clone锁。业务字段须是既有API规范化后的phone/remark/description，不在准备器里偷偷trim/改目标；preview/send及previewOnly严格相符。

## 快照和指纹分开

expected完整保留queued task/job/businessLock的JSONB原快照，含原status/events等，供将来CAS；没有丢字段、访问getter或JSON静默丢undefined/NaN/BigInt/Date等。内部CAS快照/原任务候选含已有必要业务号码和备注，**不能日志/公共响应输出**。device心跳不作为完整CAS快照锁定；实际门控由后继DB/在线验证负责。

businessFingerprint与既有previewOperationFingerprint对规范化输入一致：mode+备注hash+号码+deviceId+Android user，不包含status/events/updatedAt等合法进展字段；固定字面golden SHA与现业务函数独立核对。claimData只存IDs/原业务指纹/audit/binding，不复制号码/备注/凭据。具体DB claim_data列和后续进展对账矩阵仍待审，不能拿queued全快照当永久不变指纹。

## 输出与未实现边界

输出冻结的expected与candidate(task/job running候选、原business lock、新非过期physicalHold、M1 revision0协议state、独立claimData)。始终protocolPermit=false/durable=false/requiresPersistence=true/requiresPhysicalExclusion=true/requiresLiveChecks=true。recordedAt只作候选审计，不证明租约有效；未做SQL、物理排他、在线/控屏/查名空闲、真实父子facts/时钟验证或host ACK/配置释放。

physicalKey为已关联serial的lowercase，用于下一片已存在的物理anchor设计；这**不是锁**。单测特意让不同task/主分身/大小写serial的两个候选都生成，结果同physicalKey，显示不能声称已一胜；必须另有实际PG串行化/排他证据。旧v1/其他业务未参与前更不能称已解决跨业务冲突。

## 实际验证/版本

当前55纯叶测试通过，覆盖四mode/slot正向、完整快照/指纹区分、固定golden、深冻结和无别名、Date.now/random禁用仍确定、provider ID变化、双边目标篡改、各ID关系、旧NULL/v1、不规范输入、同机两候选的局限；现11项WeCom业务测试通过。新JS syntax、代码diffcheck检查。INITIAL 55是options进一步收紧前的历史源/回执，当前源对应CLAIM_PURE/TEST_RECEIPT，不累加历史运行。

14旧产品源及M2/M1/DDL/runner全部保持；不重跑旧39/61/50或PG14凑数。本片无PG/Windows/ADB/手机号查询/邀请/发布，主号和分身仍未补齐。下一片先补物理anchor、与旧checkpoint锁序共存、完整snapshot CAS vs进展矩阵精确DB提案，root审后才可写SQL/DB实现。
