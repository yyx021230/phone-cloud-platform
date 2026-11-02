# M3a DB片精确提案：已有物理锚点、锁序和进展对账（未实现）

基线f95b054b3dd81fd05bdc28cf156b05f4423f1e35纯叶候选。下文是待root选择/审查的DB方案，不是新增表/约束已应用或跨业务冲突已解决。本轮没有改M2/DDL/index/getPool、执行PG或启动手机。

## 1. 物理排他：预置专属锚点，禁止锁“缺失行”冒充互斥

现phone_cloud_device_locks只有lock_id PK，缺失hold行的FOR UPDATE不锁不存在的设备；不同task的queued CAS也不相互排斥。提案新建小型phone_cloud_wecom_v2_physical_anchors，只在单独审过的初始化/迁移中，从**已有且映射无歧义的配置USB设备**预置，claim不能INSERT anchor或device。这里不选择隐式创行/哈希advisory锁，也不拿appSlot当物理键。

```sql
CREATE TABLE phone_cloud_wecom_v2_physical_anchors (
  physical_key text PRIMARY KEY
    CHECK (physical_key ~ '^[a-z0-9_.:-]{1,128}$'),
  device_id text NOT NULL UNIQUE,
  active_obligation_id text UNIQUE
    REFERENCES phone_cloud_wecom_cleanup_v2(obligation_id),
  active_claim_operation_id text UNIQUE,
  CHECK (lower(device_id) = 'adb:' || physical_key),
  CHECK ((active_obligation_id IS NULL AND active_claim_operation_id IS NULL)
      OR (active_obligation_id IS NOT NULL AND active_claim_operation_id IS NOT NULL))
);
```

physical_key取已确认配置serial的小写，main/clone共享一行；不是根据传入任意IP/别名认定物理同一。预置前生成映射预览/重复或大小写别名冲突清单，歧义拒绝，缺设备/缺anchor拒绝；不自动把一条旧v1 hold塞进新ledger。device_id对照当前device映射必须一致，映射变化走维护，不在claim改anchor归属。此表刻意不加device FK以免claim过程中引入隐含device行锁；初始化需核真实device存在，UI前另有fresh映射检查，不能声称这已处理并发设备重绑定。

```sql
SELECT physical_key,device_id,active_obligation_id,active_claim_operation_id
FROM phone_cloud_wecom_v2_physical_anchors
WHERE physical_key=$1 FOR UPDATE NOWAIT;
```

0行即anchor_missing，不补造；已有active pointer只允许对同claim进入只读全tuple对账，异claim/异task/主分身均physical_busy。完成所有前置锁定/校验后，同一事务设置active pointer，第二次取得锚点时仍会看到占用，不因前事务提交就立刻让第二个业务也成功。不同serial没有共同锚点或全局串行队列。本片不提供清active方法；只有后继实际物理清理协议审过才可清，不能用业务完成/TTL清指针。

## 2. claim_data独立schema与唯一性

M1 exact state不改；在v2表新增nullable claim_data，新M3-only列；旧M2 NULL保留但不升级claimed。字段由纯叶固定：version=1、claimOperationId、originalJobId、originalLockId、ownerUserId、requestId、mode、businessFingerprint、recordedAt、binding。无phone/remark/credential。除应用严格schema校验，拟最窄SQL约束示例：

```sql
ALTER TABLE phone_cloud_wecom_cleanup_v2 ADD COLUMN claim_data jsonb;
ALTER TABLE phone_cloud_wecom_cleanup_v2 ADD CONSTRAINT wecom_v2_claim_shape
  CHECK (claim_data IS NULL OR (
    jsonb_typeof(claim_data) = 'object'
    AND (claim_data->>'version' = '1') IS TRUE
    AND (claim_data->>'claimOperationId' ~ '^[A-Za-z0-9_-]{1,160}$') IS TRUE
    AND (claim_data->>'mode' IN ('preview','send')) IS TRUE
    AND (claim_data->>'businessFingerprint' ~ '^[a-f0-9]{64}$') IS TRUE
    AND ((claim_data->'binding') = protocol_state->'binding') IS TRUE
  ));
CREATE UNIQUE INDEX wecom_v2_one_claim_per_task
  ON phone_cloud_wecom_cleanup_v2 ((claim_data #>> '{binding,originalTaskId}'))
  WHERE claim_data IS NOT NULL;
CREATE UNIQUE INDEX wecom_v2_claim_operation_once
  ON phone_cloud_wecom_cleanup_v2 ((claim_data->>'claimOperationId'))
  WHERE claim_data IS NOT NULL;
```

实际DDL还须对其余固定ID/recordedAt存在与类型校验，完整字段白名单由应用执行；示例不是schema已验。M2原六列查询/NULL-only用例应兼容，不能把NULL记录补成某个新claim。claimed task与claimOperationId唯一约束不随未来物理释放删除，未知不能换新执行/claim/nonce绕过；全部ID先由可信server context固定，DB层只消费。

## 3. 已知旧写锁序与非等待策略

已核实际顺序：persistTaskMutation通常device(可选)→windowsTask→job→session→physical hold→original business lock；savePostgresSnapshot先占phone_cloud_state，再写pending cleanup(task→job→hold)，随后syncStructuredTables可能device→job/session→windowsTask→lock。**job→task与task→job两种旧路径共存**，所以不能靠宣称一个新统一顺序就保证无死锁。

提案M3单设备事务：anchor首先NOWAIT锁；随后task→job→已有physical hold→original business lock→已有ledger全部**FOR UPDATE NOWAIT**，明确不锁/更新device行、不触phone_cloud_state、不调用generic upsert。已有row碰锁即整次退出/ROLLBACK，不持task等待旧job，也不引入新device↔task等待环。锚点缺失不代表空闲；fresh physical hold/ledger行不存在的排他由真实anchor保证，不靠空SELECT。

NOWAIT不涵盖新INSERT唯一冲突等全部等待，因此仍须局部lock_timeout/statement_timeout；新ID碰撞或约束失败保守退出，不能继续。先拿完已有行并验证再写。未提交candidate不先塞进共享state数组，单独per-physical pending claim fence在claim入口建立；这样checkpoint不会看见一个尚未提交的新hold去反向争锁。root集成须先审此fence/checkpoint投影，不能照旧restore删除新fence。

旧写在commit后仍可回写task/job/hold投影，本片不能修好所有旧路径。canonical anchor+v2 ledger持续是新协议义务；任一投影身份不一致禁止配置/重复领取，旧v1/控屏/查名入口未参与统一门控前仍默认不启v2。不给旧表加全局trigger使其他手机checkpoint整笔失败，也不悄改generic upsert。上述NOWAIT/锁序只是假设待真实PG交错验证，未宣称绝对无锁冲突。

## 4. 单事务写与未知对账顺序

在三类已有行锁定后，从当前DB记录调用已审纯叶生成bundle（input与context不能由UI authenticated布尔替代），原数据必须仍匹配期望完整queued快照。任务类包括windowsTask/job；第一片standalone只接session空，后续session支持另审。

```sql
UPDATE phone_cloud_windows_tasks SET status='running',updated_at=$3,data=$4::jsonb
WHERE task_id=$1 AND status='queued' AND data=$2::jsonb RETURNING data;
-- automation_jobs同样按原job_id/status/data完整JSONB CAS；每条必须1行。
-- INSERT physical hold、v2 revision0+claim_data，不允许覆盖旧NULL/异claim。
UPDATE phone_cloud_wecom_v2_physical_anchors
SET active_obligation_id=$2,active_claim_operation_id=$3
WHERE physical_key=$1 AND active_obligation_id IS NULL
  AND active_claim_operation_id IS NULL RETURNING physical_key;
```

ledger存在后才设置anchor FK指针；原business lock不续期/不放宽预算。若写audit，ID从固定claimOperationId确定性派生，不能在重试中另生成。三类记录和audit同一owned transaction；每个rowCount/返回数据核对再COMMIT。M2 createPending+另一个事务写task/hold不合格。

COMMIT未知仍先销毁原client并保持per-device pending fence，再在**相同锁序**有界读完整tuple；缺anchor、缺任一记录、legacy NULL、内容冲突或取锁失败不当成功，不发host ACK/配置。仅见ledger一行不能认业务已领取。原IDs/context不变，完全未见提交也不自动换号重写；已知前置拒绝/成功ROLLBACK与副作用在途未知分开处理。所有存储返回仍protocolPermit=false。

## 5. 原始CAS与后续不可变指纹：对账矩阵

| 重读状态/变化 | 存储claim结论 | 执行/物理处置 |
| --- | --- | --- |
| 尚queued且无claim tuple | 不得称已提交；若仅known前置冲突，可由coordinator同ID重取快照，未知不自动重写 | 不启动 |
| task/job running，claim IDs/fingerprint/anchor/hold/ledger全一致 | 原claim已记录 | 不因此ACK；继续后继journal/facts/live gate |
| 合法events/result/updatedAt变化；task/job进展至stalled/终态 | 原claim仍记录，不要求与原queued JSON相等 | 不重新领取/改回running；按当前业务状态拒绝再执行，物理义务保留 |
| task succeeded但job因mode/result检查变failed，或job先cancelled而task尚running | 按现syncAutomationJobFromWindowsTask/cancel语义可属正常进展，指纹/关联一致就不判永久maintenance | 业务许可关闭，等原reader真实close/物理核验 |
| 原business lock active→released/过期，但v2物理义务尚held | 不抹掉原claim | 不按业务TTL放开同机 |
| ledger合法revision0→1→2/host-close进展，binding/claim_data未变 | 原claim仍记录，不要求一直revision0 | 不是重新发送/配置许可 |
| device.lastSeen等心跳变化，稳定deviceId/serial/Agent映射仍一致 | 不作为业务指纹变化 | 当前在线/占用另查 |
| task被旧snapshot写回queued/丢wecomV2Claim、绑定或不可变号码/备注/mode/slot等改变 | 不假认未领取；冲突/maintenance，保留canonical fence | 禁止自动补写/重领 |
| 原claim IDs/epoch不同或NULL | 旧记录不升级/不重新签发 | pending/拒绝 |

immutable business fingerprint沿纯叶/现业务规范字段，原task/job/lock ID、owner、request、binding等另逐字段固定；不能只比hash忽略关联。正常terminal/result并不改号码/remarks/mode指纹。完整queued JSONB只用于第一次CAS，不能在进展后每次拿它判不等而卡死。

## 6. 实际PG计划与仍待裁决的边界

固定源码/SQL/runner再交root审，单独新私有库，不重启两次历史库。案例包括：真实已有anchor的不同task/主分身同serial竞争不得双成功；满足同样有效业务前置时anchor级恰一胜，另physical_busy；若旧业务锁本已冲突，完整入口应按现规则都拒绝，**不为制造一胜而放宽旧busy规则**。锚点窄竞争与完整任务入口分别举证，不能拿只测同task CAS代替。

另测不同serial一条持锁另一条实际提交、大小写同key、缺anchor/缺device拒绝不创行、same claim全tuple复用/异内容拒绝、新ID冲突、各写点rollback/真实COMMIT丢回复、legacy NULL、合法progress矩阵、旧checkpoint双锁序交错/NOWAIT有界退出与commit后投影回退拒绝、不发布未提交candidate、恢复/回退pending保留。原M2 PG14作独立回归，不累计覆盖数量。

即便本DB片通过，也只证明参与该新anchor的M3路径；旧v1/查名/控屏未接联合门控前不启用、不能宣称跨业务排他成立。journal/真实父子facts/Windows/共享idle pool健康仍仅后续计划。当前只文档，没有上述SQL、表、约束、PG用例或M3 DB实现。
