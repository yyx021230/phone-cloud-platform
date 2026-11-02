# C2独立mutation回执：verification-only逻辑schema/interface提案

基线7b2ef410cc45cf2831151938f2fd471d75b52d13；root C1实际2852677，当前仅文本审查。延续b4641e4/RECEIPT_CONTRACT，细化持久回执需求，不替代M1/M2/M3或S1/S2/journal/native。本目录没有可执行DDL、角色、repository、authorizer、接线或新测试。以下表名只是**验证域逻辑名称**，不是生产表名或迁移授权。

## 固定输入与权限边界

建议接口逻辑 `applyMutation(proposal)` / `reconcileMutation(operationId, fingerprint)`；读取同一固定可信owner context，重新核验不能由HTTP请求传入一个allow布尔。只有本地fixture合成context时恒canonicalSourceVerified/protocolPermit/productionEnabled=false。真实可信执行能力、parent/host/mapping/journal未提供时禁止生产调用。

proposal的精确字段建议：version=1、operationId、purpose（task_job_progress或delivery_update）、claimData（原M3 exact claim副本）、authorityFingerprint、expectedProgressRevision（十进制规范字符串）、expectedTask/expectedJob完整JSON、nextTask/nextJob完整JSON。delivery也以完整下一task作为提案，字段允许集另核，不只带token。owner context中claim/authority必须与proposal完全相等，不能由proposal自己证明权限。未知字段/accessor/非JSON拒绝；内容指纹覆盖整个proposal，规范见CANONICAL.md。

operationId必须由可信server/journal第一次尝试前稳定记录后提供，重试/换HTTP请求号/COMMIT未知不换ID；本接口不提供ID/时钟生成器。现有M1 host/close op、claim ID和业务requestId都不能自动替代mutation ID。**这个稳定来源尚未实现**，不能因为文字定义了字段便称重启幂等完成。

authorityFingerprint是未来根确定的可信执行上下文的规范指纹引用，不是任意字符串持有者即可写的凭证。原claim binding已有serverEpoch/agentInstanceId/executionId/handshakeNonce，但它们本身不证明live parent/host；真实来源/schema、失效规则需根另审。fixture只能使用明确synthetic常量，不能提升为生产authorizer。

## 验证域逻辑记录（无SQL）

|记录|精确字段建议与约束|
|---|---|
|ProgressHead|version=1；ownerClaim（完整原claimData）；authorityFingerprint；revision（0或正整数规范十进制字符串）；lastOperationId（revision0为null，否则稳定ID）；lastReceiptFingerprint（revision0为null，否则64位小写hex）；taskId/jobId来自原claim，不能重绑|
|MutationReceipt|version=1；operationId（全验证域唯一）；purpose；contentFingerprint（整个proposal）；ownerClaim；authorityFingerprint；beforeRevision；afterRevision=before+1；previousOperationId；expectedTaskFingerprint/expectedJobFingerprint；nextTaskFingerprint/nextJobFingerprint；receiptFingerprint（本记录除自身字段外全部规范字节的SHA256）；outcome=applied|

还建议唯一(ownerClaim的稳定claim ID,afterRevision)，但不能只用易变requestId或device编号。两条不同operation争抢同revision只能一条提交。receipt immutable，只追加不覆盖；claim/authority/op与revision字段强类型、互相关联，具体SQL类型/CHECK/FK待另审。ProgressHead和Receipt独立于M1 revision0..2，不向M1 exact state/claim_data/events加字段。

ProgressHead不能在任意写失败时自动创建；缺失/旧NULL/v1 owner一律unavailable并保留义务。以后是新claim同TX创建，还是一次受控初始化，须根单独决定；本提案不改M3的5 DML、不从legacy快照升格。初始化未定是实际阻塞，不是已经具备的能力。

expected/next两个指纹必须按完整候选JSON，而非只选status/result字段。合法字段变化采用明确purpose允许集，其余已知未知字段保持；此处未定义完整生产任务状态机。root须给出progress/result/events允许集与身份校验后才能实现产品writer。

## 结果类型建议

- recorded：只有确认COMMIT，或独立可信读取到完全匹配的immutable Receipt且owner/head/链关系核验通过；返回该operation的receipt，不表示物理义务已清或对方收到回调。
- conflict：确定operation同ID不同fingerprint/owner，或已确认目标CAS/revision不匹配；此标签不覆盖连接/事务结束未知。
- unavailable：权限/来源/初始化/映射/输入不可信且尚未提交；保留义务，不能发任务。
- unknown：连接/COMMIT/重读未决或持久记录关联不完整；退役不可信连接，仅原ID对账，不自动重播手机动作。

所有输出继续fence=held/protocolPermit=false。合法后继revision不把旧receipt判成未提交：receipt本身证明历史mutation，但当前投影还需沿head与回执链验证已审后继；不得要求task当前值永远等于旧next快照，也不能见claim存在便接受无链覆盖。缺链、跳revision、未知writer改投影必须fail closed保留义务。

## 生命周期与缺口

业务terminal/released、session取消、HTTP换requestId、events裁剪或镜像回滚都不得删除receipt/head或原physical hold。retention必须与原物理义务关闭、所有未知对账、重试重放窗口、跨owner引用和审计保留共同批准；目前没有安全删除期限。shared blob/boot/legacy fallback由根统一，不能只在structured表存receipt就宣布回滚后仍权威。

单条recorded后可逐请求发布结果，不等整轮。外发outbox必须同一commit建立或有另审的可靠桥，稳定回调ID/对端去重及送达确认另合同；receipt不是“回调已送达”。本片不新增outbox表或外发消息。

待根决策：稳定op journal入口、实际authority schema、ProgressHead初始化/DDL和迁移、允许状态/字段、canonical数值读取证明、完整链保留和blob/boot权威、outbox。当前主号/分身真机仍未完成，43/147/52和查名池保留，无生产动作。
