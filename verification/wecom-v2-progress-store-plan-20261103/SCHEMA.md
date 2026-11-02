# C2最小progress store：精确verification schema提案（无可执行DDL）

基线1f9e33884572c0b35a6d7c4b94a41b1b825a394c，原C2规范9546c831与encoder/goldens保持原字节。仅isolated新synthetic库的文字提案，不是产品表名或迁移；没有SQL文件、adapter、角色或执行。延续原C2 head/receipt合同，将首次可验证purpose收窄到task_job_progress、task和job都running→stalled，不包含delivery、business release、任意terminal或手机操作。

## 规范值与唯一最小迁移

固定fixture authorityFingerprint为64个`1`（仅合成标签，无真实权限）。operationId用预先固定synthetic字符串，不在apply/reconcile内生成；稳定journal来源仍缺。固定next updatedAt=`2026-11-03T00:30:00.000Z`，仅fixture audit文本，不是wall/live权限。next task和job从各完整expected JSON复制，只改status=`stalled`、updatedAt为上述值、result为精确对象 `{fixtureOnly:true,phase:"fixture_stalled",attempt:1}`。只有这三个key可变；其余所有已知未知字段（包括events/pickedAt/completedAt/关联/备注/手机号/slot/claim）深等原值。expected两者都必须running且result精确空对象；初次M3 claim后的规范快照满足该条件。任何多余result字段、其他状态、audit不同或未知字段新增/删除均DML前拒绝。

fixture数字只由可信constructor产生的小有界整数/有限值，日期为固定规范string，Pg bigint只接受规范十进制string。此片没有验证一般JSONB数值无损读取，也不把JS parse/重新编码视为该证明。不能从任意生产JSON/legacy/blob自动建立此域。

## 两张逻辑验证表的精确列

`fixture_wecom_progress_heads`：

|列|拟SQL类型/约束|
|---|---|
|claim_operation_id|text PRIMARY KEY，固定原M3 claim ID|
|obligation_id|text NOT NULL UNIQUE，原physical obligation ID|
|original_task_id / original_job_id|各text NOT NULL，原task/job ID|
|owner_claim|jsonb NOT NULL，完整exact原claimData，不变|
|authority_fingerprint|text NOT NULL，64小写hex，固定fixture值|
|revision|bigint NOT NULL，**本片仅0或1**；驱动读为`"0"`/`"1"`|
|last_operation_id|text nullable，rev0必须null，rev1非空|
|last_receipt_fingerprint|text nullable，rev0必须null，rev1为64hex|
|task_fingerprint / job_fingerprint|各text NOT NULL，完整当前JSON的WCMUT1指纹|

共11列，RETURNING必须逐列列出上表字段（斜线拆为独立列）。owner_claim与各ID/authority互相关联由严格fixture验证，不能只靠jsonb_typeof(object)当有效性证明。

`fixture_wecom_mutation_receipts`：

|列|拟SQL类型/约束|
|---|---|
|operation_id|text PRIMARY KEY，稳定mutation ID|
|claim_operation_id|text NOT NULL，FK到head的claim_operation_id|
|purpose|text NOT NULL，本片只task_job_progress|
|content_fingerprint|text NOT NULL，完整proposal规范指纹|
|authority_fingerprint|text NOT NULL，原fixture authority|
|before_revision / after_revision|各bigint NOT NULL，本片分别0/1|
|previous_operation_id / previous_receipt_fingerprint|各text nullable，本片都必须null|
|receipt_fingerprint|text NOT NULL，完整receipt data剔除此自身字段的WCMUT1指纹|
|data|jsonb NOT NULL，下面exact record|

共11列，UNIQUE(claim_operation_id,after_revision)禁止同claim分叉；不使用ON CONFLICT UPDATE或幂等吞错。逻辑immutable要求fixture只有INSERT、没有UPDATE/DELETE方法且重试完整核原记录；本片未做角色/trigger，**不声称数据库管理员不能篡改**。

receipt data精确key：version=1、operationId、purpose、ownerClaim、authorityFingerprint、beforeRevision=`"0"`、afterRevision=`"1"`、previousOperationId=null、previousReceiptFingerprint=null、contentFingerprint、expectedTaskFingerprint、expectedJobFingerprint、nextTaskFingerprint、nextJobFingerprint、proposal、outcome=`applied`、receiptFingerprint。每个scalar列必须与data对应值完全一致；不能用String(number)接受本应string的revision。

proposal精确key沿9546规范：version=1、operationId、purpose、claimData、authorityFingerprint、expectedProgressRevision=`"0"`、expectedTask、expectedJob、nextTask、nextJob。contentFingerprint按整个proposal计算，不排除audit/result/未知字段或旧快照；两expected/next独立完整指纹均重新计算核对。receiptFingerprint含完整proposal和所有owner/revision/关联字段，不是只hash四个snapshot摘要。

## 只允许显式isolated seed建head0

新fixture先实际M3 createClaim known COMMIT并释放client，再M3 fresh recorded；之后**另一个owned seed transaction内**同client按原顺序anchor/full tuple NOWAIT读取并严格核claim、原业务身份、nonexpiring physical义务及当前running规范投影。可复用已审verification loader的精确查询/规范化，S1结构分类仍零权限；不能持anchor另connect M3自锁。

仅已知全新synthetic seed这一路INSERT head0，写原完整owner/authority、task/job当前指纹和两个last=null。没有INSERT IF MISSING、ON CONFLICT吞错、production initializer或旧NULL/v1自动提升。正式apply/reconcile缺head返回unavailable/unknown，保留义务。真实head初始化/迁移仍待根审，不改M3五DML。

## 后继链的保守边界

完整通用合同保留before/after revision、previousOperationId、previousReceiptFingerprint、expected/next双snapshot链，不能删字段。但本片唯一running→stalled成功后已stalled，**没有第二条被授权的状态迁移**。本片不造恢复running/stalled→stalled或任意terminal来凑合法后继测试；rev>1、非null previous或未知purpose只能unknown并保留义务，合法后继验收明确未覆盖。根另审最小后继迁移后才扩revision域及测试；原9546通用规范不被此局部验证范围替换。

真实journal/authority、head生产初始化/允许迁移、完整链retention、blob/boot/outbox与主号分身真机仍未闭合，43/147/52和查名池保持。
