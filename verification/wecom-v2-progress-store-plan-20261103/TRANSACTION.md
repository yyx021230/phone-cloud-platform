# 固定参数和同client事务模板（仅文字/未执行）

禁止作为现有应用入口使用。接口建议`createFixtureProgressStore({getPool,readFixedFixtureContext})`，只提供`apply(proposal)`与`reconcile({operationId,contentFingerprint})`。读到的fixed context严格绑定完整原claim和上述合成authority；调用前/每次await后复核，不给HTTP caller“allow”开关，不提供新ID/时间。输出恒protocolPermit=false/fence=held/canonicalSourceVerified=false/productionEnabled=false。

## apply精确次序

1. tree encoder严格校整个proposal，并按SCHEMA逐字段验证固定purpose、原owner、exact allowlist和规范类型；DML前拒绝任何漂移。只接已有预固定op，不创建stable journal。
2. owned checkout，自有first-error observer，BEGIN READ COMMITTED，原2s lock/3s statement/5s idle预算；每次yield后核fixed context。连接error后停止SQL并退役，只移除自己的listener。
3. **同client**原anchor/task/job/physical hold/original business/ledger六读取与device映射全tuple核对，然后head NOWAIT、operation receipt（若存在也锁定）读取。不调用另connect的M3 reconcile；fixture source/physical义务始终held。
4. 有receipt：严格所有列/data/重新指纹/原owner匹配；同op不同内容拒绝。当前仅支持head1→此receipt，last op/hash和当前task/job指纹必须等receipt next，并全tuple仍有效；相同即原已提交事实，不重复DML。head更晚/缺链未知。无receipt但head1不自动新建或退回0；head0须expected两指纹与当前完整snapshot/SQL metadata一致。
5. 新写沿原p.ownerTaskProgressCas八参数：`[taskId,"stalled",auditAt,JSON(nextTask),agentId,serial,JSON(expectedTask),JSON(claimData)]`。job沿p.ownerJobProgressCas八参数：`[jobId,"stalled",auditAt,JSON(nextJob),deviceId,ownerUserId,JSON(expectedJob),JSON(claimData)]`。比较模块原字节不改。每条都要求command UPDATE/rowCount1/完整RETURNING精确列/JSON与metadata完全一致；0行只能自有明确CAS冲突。
6. head CAS参数固定为 `[claimId,JSON(ownerClaim),authorityFingerprint,"0",null,null,expectedTaskFP,expectedJobFP,"1",operationId,receiptFP,nextTaskFP,nextJobFP]`。WHERE对比前8参数的每项，nullable用IS NOT DISTINCT FROM，SET只后5项；RETURNING精确11列，所有不变列和预期next逐项核。不是只WHERE revision。
7. receipt INSERT参数按SCHEMA表列固定11项：`[operationId,claimId,purpose,contentFP,authorityFP,"0","1",null,null,receiptFP,JSON(receiptData)]`；无ON CONFLICT，RETURNING精确11列，driver bigint只能规范string，data/fingerprints/owner全核。两表链和task/job修改在同一事务。
8. 实际COMMIT命令确认后release，之后独立新Pool/backend复读task/job/head/receipt及全部物理保护记录，先验完再M3 fresh；此为fixture known case。不能在持anchor时先M3 fresh。服务产品未来并不需要每次另开Pool，此处用来证明独立读取。

任何task/job/head CAS0或receipt冲突不得留下半更新。明确55P03/自有CAS0可在目标SAVEPOINT回退后让另一目标同TX继续；同TX结尾未确认前不外发任何目标成功。任意SQL/连接error和COMMIT不明不降为局部冲突，退役连接；所有该TX operation都unknown。INSERT RETURNING不是持久提交证明。

## reconcile与历史事实

原失信client已退役后独立checkout，固定原operationId+contentFingerprint+owner，按同anchor/full tuple/head/receipt规则只读。禁止再运行apply、改ID或重播手机。只有精确receipt指纹+head关系+当前投影核对才recorded；claim仍recorded或receipt记录存在不够。receipt缺且原事务未明确结束继续unknown，读取55P03/源异常也不是not_recorded。

本片head0无receipt只表明当前已读snapshot，不能证明另一个未决事务永不会提交；不提供自动重试写的许可。已知COMMIT后context变动仍保留历史已提交事实但不授新authority。建议明确两个独立字段：historicalCommitKnown只在原固定owner/op/fingerprint的真实已提交receipt严格复核后true；currentProjectionVerified只在当前head/全tuple/投影核对通过后true。伪造rev2/缺链或绕过catalog改当前投影时可为前true后false、storageStatus=unknown，不伪称合法后继或重新授执行权限；未验证receipt自身时不能给历史true。连接/来源失信不靠旧缓存将任一字段置true，不默默重绑owner。真实source authority仍未提供，fixture输出canonicalSourceVerified恒false。

## immutable/retention/outbox未实现

头与receipt不得跟events/terminal/session裁剪；业务锁released不清physical义务。当前只提出逻辑immutable/唯一链，没有生产roles/trigger或保留期限。blob/boot/旧镜像/lookup双owner由根统一。outbox在可靠持久边界另审；这里不写回调或声称对方收到。所有文本须先根审，之后才能授权verification adapter/owned PG；无SQL/PG/Windows/ADB/设备/生产动作。
