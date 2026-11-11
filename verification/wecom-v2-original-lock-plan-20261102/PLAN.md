# B片原business lock：同事务验证提案，未实现/未执行

基线ba015964c61175987567f93d097055fa47ac927d；job/hold4/4只窄投影控制，未改shared。当前仅本提案/精确loader规格，不新写DB adapter、SQL迁移或改M3。沿root112c864f要求：无marker负例、同TX anchor/fulltuple、immutable/status/fullJSONB CAS、目标局部冲突，禁止持anchor再开M3 reconcile连接自锁。

## 1. 事实、SQL与边界

M3原business lock仍lockType=wecom_customer_preview、appSlot空串表示物理整机，taskId指originalJobId；原claim只读/锁它、不加wecomV2Claim。因此NOT(data ? 'wecomV2Claim')不足以保护它。精确负SQL沿c15a85 verification-queries.insufficientOriginalBusinessGuard，状态/expires/data全绑定/RETURNING lock五列；这不是生产实现或原线上因果。

受控CAS沿ownerBusinessStatusCas：lock_id/device_id/完整原data JSONB作为WHERE；新status/expires/data全绑定，RETURNING lock_id,device_id,status,expires_at,data。它本身不是权限门禁，也不防未参与anchor的旧writer在随后覆盖；必须全入口后继root统一，当前维持v2禁启。验证片只证明拟议同TX fixture过程及局部回退，不声称完整生产owner已实现。

## 2. 验证用同transaction loader（后继源码，未实现）

一次已持有client，BEGIN Read Committed/局部2s lock、3s statement、5s idle；从已有anchor开始NOWAIT，不补设备/anchor。按M3同序：

|序|表/固定where参数|精确返回列|
|---|---|---|
|1|wecom_v2_physical_anchors physical_key=lower(binding.serial)|physical_key,device_id,active_obligation_id,active_claim_operation_id,agent_id,mapping_revision,mapping_fingerprint,mapping_state|
|2|windows_tasks task_id=binding.originalTaskId|task_id,agent_id,adb_serial,status,created_at,updated_at,data|
|3|automation_jobs job_id=context.originalJobId|job_id,device_id,user_id,kind,status,created_at,updated_at,data|
|4|device_locks lock_id=binding.obligationId|lock_id,device_id,status,expires_at,data|
|5|device_locks lock_id=context.originalLockId|lock_id,device_id,status,expires_at,data|
|6|wecom_cleanup_v2 obligation_id=binding.obligationId|obligation_id,server_epoch,revision,host_operation_id,close_operation_id,protocol_state,claim_data|

每步恰1row/rows1/列集合严格，首次业务claim已完成故不容NULL记录。device JSON用同client普通SELECT data WHERE device_id读取，核配置关联；S2真实重绑屏障仍未实现，不把此读称稳定mapping已证明。PG Date→有限有效UTC ISO/null显式规范；mapping_revision必须驱动返回的正整数字符串，不String()升格。其他JSONB不默默删字段/把undefined变null。

完整normalized tuple可交已审S1 rc.2纯policy核结构/身份/业务指纹，provider只返回本次已锁快照，结果恒零写权/来源认证，**不能用retain_canonical当写许可**。验证fixture拥有源码固定的合成context（binding13、claimOperationId、originalJobId/LockId、owner/request/mode/fingerprint/audit），同DB claim逐字段比，不用UI ready/authenticated布尔。实际caller/OS/journal权威未实现，不被本fixture代替。

这里不调用M3 repository.reconcileClaim：它会另connect并再锁anchor，与当前已持锁的client不同。只在本transaction以独立verification loader读取/规范/验证；COMMIT或ROLLBACK确认并release后，才另开M3 fresh完整重读。原M1/M2/M3模块不导出私有executor/loader、不为fixture改签名。

## 3. immutable与允许status合同

原lock immutable：lockId=context.originalLockId、deviceId=binding.deviceId、lockType=wecom_customer_preview、taskId=context.originalJobId、ownerUserId=context.ownerUserId、appSlot空串、createdAt原值。原business expiresAt本片保持原canonical值，不续期或任意重置预算；不可把它等同物理hold的空expiry。

本片只验证active→released及审计updatedAt/releasedAt/releaseReason（固定合成值），不实现expire/renew任意迁移。original binding/claim/owner/request/slot/号码备注等不改，task/job/physicalHold/ledger/anchor不得跟着清理或换IDs。新状态只能已批准集合，invalid状态或immutable不同在任何DML前拒绝目标。canonical缺字段/ledger legacy NULL/投影不齐拒绝，不能自动修复/upgrade。

createdAt/expiresAt不在claim_data历史快照内；这里只要求本次锁内fresh canonical值到候选不变，不声称恢复了最初创建值，不以审计wall时间推断权限。ledger固定身份/原业务指纹与本次JSONB CAS的职责仍分开。

CAS RETURNING必须rowCount1/rows1/精确五列/状态及expiry JSONB对应、data深等候选；0行不是成功，也不重写或生成新ID。一个目标中的任何失败只保留/回滚该目标候选，持久物理义务不清。这里只known COMMIT可记验证成功；COMMIT未知的owner progress特定操作回执仍未定义，不能看claim recorded推定本次status修改成功，保持unknown且不发布业务成功/重放。

## 4. 建议四个独立PG组，先审源码再另行新库

1. unmarked-negative：用原M3实际5DML在COMMIT前暂停，B不足marker UPDATE已发，C实际active/Lock/blocker A后放A。旧候选保持lock/device/task等但ownerUserId改合成other-owner，updatedAt2099；期望B1row/M3conflict。初始与A后原lock都无v2 marker；ledger/anchor/非过期physicalHold不变，不说物理手机被释放。
2. owner-status-known：M3 claim先完整known提交，B同TX loader锁全tuple；同合成context/immutable校验后原lock合法active→released/fullJSONB CAS1。确认B真实COMMIT并release，再M3 fresh重读recorded/原physicalHold和anchor/ledger保持。S1仍零权限，原lock仍不加marker，只证明fixture受控路径。
3. target-nowait：先对f/g各建原M3 known claim，独立holder锁f原business row；B以SAVEPOINT锁f anchor→task/job/hold，原business NOWAIT真实55P03→ROLLBACK TO该target；同B继续g loader/合法status CAS/COMMIT，fresh独立backend核f原data不变/g released。先结束holder，再M3 fresh重读，避免把仍被holder锁住产生的unavailable误称不合法。
4. target-cas-zero：f/g已known claim；B savepoint加载f完整期望后，**验证fixture故障注入**在同TX改f一项审计字段，再用原JSONB CAS，必须真实0rows/[]；ROLLBACK TO连注入一起撤销。g同transaction继续合法CAS/真实COMMIT，新backend核f exact恢复/g生效，两个physical义务保持。注入不是线上并发事实，不改断言凑绿，不用伪rowCount。

raw B非法owner操作、故障注入只在已审owned新库；不使用生产当首试。fixture记录真实backend/锁proof/返回值/原JSONB规范hash/提交tag/逐目标结果；不输出业务号码备注/provider错误或把合成host/ownership当生产来源。

## 5. 提案未覆盖的实际风险

受控B持anchor不意味所有旧generic/business writer已参与：无marker旧writer仍能在之后覆盖。因此该片通过也不是shared修复、跨lookup/control admission、full-state blob/旧restore/启动恢复完成。all-entry inventory与row条件/缺marker拒绝、pin/overlay由root另案统一。

delivery只改三path的行为/旧投递与controlled task+job progress另片；特定progress opID/内容指纹/持久回执合同缺失时不做未知成功推断，不塞M1 exact或裁剪events。lookup executionWait canonical schema由lookup owner，blob/boot两个引用域仍root协调。S2/journal/native默认禁用，原43设备清理义务/147/52、查名池/ADB/SYSTEM/媒体冻结保持，主号分身真机未验收。

当前仅提案与LOAD_SPEC JSON，无测试或PG/SQL/Windows/设备/产品动作；后继owned新root/marker、固定源/预算/finally清理需随fixture源码重新交root审，不能继承旧4组执行授权。
