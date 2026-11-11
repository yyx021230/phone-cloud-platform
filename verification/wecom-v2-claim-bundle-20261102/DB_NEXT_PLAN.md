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

上方是设计动机，正式拟实现约束以下附录A为准，不只实现这段示例。M2原六列查询/NULL-only用例应兼容，不能把NULL记录补成某个新claim。claimed task与claimOperationId唯一约束不随未来物理释放删除，未知不能换新执行/claim/nonce绕过；全部ID先由可信server context固定，DB层只消费。

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

## 附录A：拟实现的完整claim约束（SQL未执行）

本附录取代第2节简化shape示例；M2原DDL原字节保持，新迁移单独创建函数/列/索引。函数仅接受固定字段且不读表、不取时钟。新增列NULL保持兼容；非NULL输入类型错误直接返回false，CHECK必须IS TRUE。recordedAt是审计字符串，不作租约权威；存储片仅接收0001—9999年四位UTC毫秒子集，超出纯叶子集明确拒绝，不悄悄截断。函数体是本提案的一部分，尚未通过真实PG语法/约束验证。

```sql
CREATE FUNCTION phone_cloud_wecom_v2_claim_valid(c jsonb, s jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE b jsonb; k text; parsed timestamptz;
BEGIN
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF c - ARRAY['version','claimOperationId','originalJobId','originalLockId',
    'ownerUserId','requestId','mode','businessFingerprint','recordedAt','binding']
    <> '{}'::jsonb OR c->'version' IS DISTINCT FROM '1'::jsonb THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['claimOperationId','originalJobId','originalLockId','ownerUserId'] LOOP
    IF jsonb_typeof(c->k) IS DISTINCT FROM 'string'
      OR NOT ((c->>k ~ '^[A-Za-z0-9_-]{1,160}$') IS TRUE) THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(c->'requestId') IS DISTINCT FROM 'string'
    OR NOT ((c->>'requestId' ~ '^[A-Za-z0-9_-]{8,100}$') IS TRUE)
    OR jsonb_typeof(c->'mode') IS DISTINCT FROM 'string'
    OR NOT ((c->>'mode' IN ('preview','send')) IS TRUE)
    OR jsonb_typeof(c->'businessFingerprint') IS DISTINCT FROM 'string'
    OR NOT ((c->>'businessFingerprint' ~ '^[a-f0-9]{64}$') IS TRUE)
    OR jsonb_typeof(c->'recordedAt') IS DISTINCT FROM 'string'
    OR NOT ((c->>'recordedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$') IS TRUE)
    THEN RETURN false; END IF;
  BEGIN
    parsed := (c->>'recordedAt')::timestamptz;
    IF to_char(parsed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      IS DISTINCT FROM c->>'recordedAt' THEN RETURN false; END IF;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN false;
  END;
  b := c->'binding';
  IF jsonb_typeof(b) IS DISTINCT FROM 'object'
    OR b IS DISTINCT FROM s->'binding'
    OR b - ARRAY['version','obligationId','originalTaskId','executionId','deviceId','serial',
      'agentId','appSlot','androidUser','nonce','serverEpoch','agentInstanceId','handshakeNonce']
      <> '{}'::jsonb OR b->'version' IS DISTINCT FROM '2'::jsonb THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['obligationId','originalTaskId','executionId','agentId',
    'nonce','serverEpoch','agentInstanceId','handshakeNonce'] LOOP
    IF jsonb_typeof(b->k) IS DISTINCT FROM 'string'
      OR NOT ((b->>k ~ '^[A-Za-z0-9_-]{1,160}$') IS TRUE) THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(b->'serial') IS DISTINCT FROM 'string'
    OR NOT ((b->>'serial' ~ '^[A-Za-z0-9_.:-]{1,128}$') IS TRUE)
    OR jsonb_typeof(b->'deviceId') IS DISTINCT FROM 'string'
    OR b->>'deviceId' IS DISTINCT FROM 'adb:' || (b->>'serial')
    OR jsonb_typeof(b->'appSlot') IS DISTINCT FROM 'string'
    OR NOT (((b->>'appSlot'='main' AND b->'androidUser'='0'::jsonb)
      OR (b->>'appSlot'='clone' AND b->'androidUser'='999'::jsonb)) IS TRUE)
    OR b->>'obligationId'=c->>'originalLockId' THEN RETURN false; END IF;
  RETURN true;
END;
$$;
ALTER TABLE phone_cloud_wecom_cleanup_v2 ADD COLUMN claim_data jsonb;
ALTER TABLE phone_cloud_wecom_cleanup_v2 ADD CONSTRAINT wecom_v2_claim_shape
  CHECK (claim_data IS NULL OR phone_cloud_wecom_v2_claim_valid(claim_data,protocol_state) IS TRUE);
CREATE UNIQUE INDEX wecom_v2_one_claim_per_task
  ON phone_cloud_wecom_cleanup_v2 ((claim_data #>> '{binding,originalTaskId}'))
  WHERE claim_data IS NOT NULL;
CREATE UNIQUE INDEX wecom_v2_claim_operation_once
  ON phone_cloud_wecom_cleanup_v2 ((claim_data->>'claimOperationId'))
  WHERE claim_data IS NOT NULL;
```

claimData严格10字段，binding严格13字段；DB验证所有类型/必填/格式及binding与protocol_state完全一致。M1重建校验仍校验protocol_state全结构、revision/host操作，不以这函数代替M1。task/job全JSONB是开放业务记录，沿纯叶严格值域+必需关联检查而非伪造固定顶层字段白名单；不添加独立手机/备注副本到ledger。claimOperationId与M1 host/close operationId属于不同操作用途，后续若出现同号冲突拒绝，不默许跨用途复用。

## 附录B：锚点初始化与并发映射门控（尚未接线，默认禁启）

第1节anchor拟补充以下列（最终CREATE一次完整列清单，不是运行时ALTER）：

```sql
agent_id text NOT NULL CHECK (agent_id ~ '^[A-Za-z0-9_-]{1,160}$'),
mapping_revision bigint NOT NULL CHECK (mapping_revision > 0),
mapping_fingerprint text NOT NULL CHECK (mapping_fingerprint ~ '^[a-f0-9]{64}$'),
mapping_state text NOT NULL DEFAULT 'disabled' CHECK (mapping_state IN ('disabled','ready'))
```

fingerprint由固定server解析后的JSON数组[deviceId,serial,agentId,deviceNumber]生成SHA256，大小写serial保持原配置；physical_key单独小写。初始化独立受审事务从真实devices读取并生成逐设备预览，拒绝非USB/重复alias/缺Agent/不一致映射；所有anchor初始disabled，不自动转换pending v1、不覆盖已占用anchor、不创建device。纯DB测试用合成数据可显式设置ready，但不等于生产可启。

实际集成前，所有设备配置/映射变更入口必须先取得相同anchor NOWAIT锁并将mapping_state改disabled、递增revision，active指针存在则禁止改映射；禁用与映射写入须有同一事务或可验证不可用屏障。不得采用“先改device，再事后禁anchor”的窗口。旧generic/checkpoint设备写入尚不参与，因此当前无法证明该屏障，**生产v2必须默认禁启**，不能靠leaf读到相同device快照或无device FK宣称解决竞态。不能为了加此屏障本轮改共享配置入口。未来启用要求root审核入口清单与并发变更验证；重启不自动把disabled升ready。

## 附录C：create/reconcile共享精确读锁集合与返回校验

两者用同一专用loader：BEGIN ISOLATION LEVEL READ COMMITTED；局部lock_timeout=2000ms/statement_timeout=3000ms/idle_in_transaction_session_timeout=5000ms。reconcile只SELECT/SET/事务结束，无INSERT/UPDATE/DELETE，包括全无也不重写。FOR UPDATE不能放在READ ONLY事务中，这里的“只读”指无数据DML，不冒称PG READ ONLY。每次固定以下顺序；每张表查询同样NOWAIT，不调用原M2会等待的SELECT helper：

| 序 | 查询/固定参数 | 必取返回列（不得SELECT *） |
|---|---|---|
|1|anchors WHERE physical_key=$physicalKey FOR UPDATE NOWAIT|physical_key,device_id,active_obligation_id,active_claim_operation_id,agent_id,mapping_revision,mapping_fingerprint,mapping_state|
|2|windows_tasks WHERE task_id=$binding.originalTaskId FOR UPDATE NOWAIT|task_id,agent_id,adb_serial,status,created_at,updated_at,data|
|3|automation_jobs WHERE job_id=$originalJobId FOR UPDATE NOWAIT|job_id,device_id,user_id,kind,status,created_at,updated_at,data|
|4|device_locks WHERE lock_id=$binding.obligationId FOR UPDATE NOWAIT|lock_id,device_id,status,expires_at,data|
|5|device_locks WHERE lock_id=$originalLockId FOR UPDATE NOWAIT|lock_id,device_id,status,expires_at,data|
|6|wecom_cleanup_v2 WHERE obligation_id=$binding.obligationId FOR UPDATE NOWAIT|obligation_id,server_epoch,revision,host_operation_id,close_operation_id,protocol_state,claim_data|

create的新领取允许4/6缺失；其余必须恰1行。active指针非空时，仍按原固定尝试IDs读上述集合，全tuple一致才算同claim已记录，异claim只返回busy，不跳读其他任务。reconcile允许缺行作为unknown/冲突事实，但须完成可读集合后分类，绝不从全无推导可重写；缺anchor直接拒绝不做补造。取锁失败中断ROLLBACK，保留pending义务。两者都不查/锁device行；稳定mapping证明由附录B的未来屏障要求，未齐不执行。

每个SELECT结果同时核rowCount、rows.length、恰好返回列集合、标量类型与JSONB对应值；日期按驱动Date或string统一为ISO/null再比较，不能依赖日志文本。task投影核task_id/agent_id/adb_serial/status/created_at/updated_at与data对应；job核job_id/device_id/user_id/kind/status/日期；lock核lock_id/device_id/status/expires_at与JSON（physical hold JSON expiresAt空串→SQL NULL）；ledger先M1完整验证再claimData/关联验证。任务状态与投影必须各自一致，但task/job状态不强求相同，沿第5节矩阵。

create所有写语句绑定参数，不拼用户字段；次序task CAS→job CAS→新physical hold INSERT→ledger INSERT→anchor CAS。task UPDATE仅status/updated_at/data，WHERE同时匹配task_id、agent_id、adb_serial、status='queued'、created_at/updated_at IS NOT DISTINCT FROM预期时间、data=$fullExpected::jsonb；job同理再含device_id/user_id/kind。新hold插入五列(lock_id,device_id,status,expires_at,data)；ledger插入上述七列，revision0/两个operation NULL；不使用UPSERT/ON CONFLICT掩盖旧NULL或其他claim。anchor UPDATE还要求原mapping_revision/fingerprint/state='ready'与两个active NULL；仅赋active IDs。business lock不写，audit本片不写。

**每条DML必须RETURNING该表上表完整列集合，rowCount=1且rows.length=1；返回值通过相同列/JSONB检查并与candidate完整JSONB相等**。anchor返回mapping不变且active IDs准确；hold SQL expires_at必须NULL/JSON空串；ledger claimData/protocolState必须与原候选深相等。任一不足/多行/不同值即失败，不COMMIT。JSONB比较按JSON语义忽略对象键序，不忽略数组序/字段缺失/null或不同数值。COMMIT只接受真实command COMMIT；未知先retire原client再独立checkout同loader，原IDs不变。共同loader不是跨事务快照锁：真实PG并发测试须证明持锁期间全tuple稳定；不把缺失行锁当互斥。

## 附录D：拟动文件与独立验证清单

待root逐片批准后，拟新增server/wecom-cleanup-v2-claim-postgres.mjs及同名测试、deploy/sql/wecom-cleanup-v2-claim.sql、verification/wecom-v2-claim-postgres-20261102/专属fixtures/runner/代理场景/manifest；更新主文档日志。**不改已审M2 repository/DDL、M1、index/getPool、共享repository、Agent/SDK/配置入口**。M3库叶始终protocolPermit=false，不启动执行器。M2错误拥有期模式若复制进新叶，固定源/独立反例审，不抽共享重构。

固定manifest覆盖新叶/测试/DDL、纯claim叶/M1及fixture、实际使用的runner/代理/observer和既有pg依赖实际源码hash；列完整argv/env/预算/归属清理/失败保留。runner修改另固定版本，不拿既有M2 runner授权覆盖新源。当前没有这套新runner或新PG授权。

独立PG场景逐项计，不复用M2 14数目冒充本片：①main基本claim和全tuple；②clone独立serial；③同anchor不同task/slot并发最多一胜+原业务busy拒绝；④不同anchor一条持锁另一提交；⑤大小写同key/缺anchor/缺device不创；⑥disabled或映射revision/fingerprint不符拒绝；⑦受审合成映射变更先disabled交错，active禁止重绑；⑧同claim完整tuple复用/改关联拒绝；⑨旧NULL/claim/task唯一碰撞；⑩五个DML写点回滚及RETURNING错行/错JSONB反例；⑪真实COMMIT丢回复与COMMIT前断开，全无未知不重写；⑫任务正常进展/业务锁释放/ledger revision1、2完整矩阵；⑬各投影queued回退/丢claim/错手机号备注关联拒绝；⑭旧task→job与job→task两交错NOWAIT退出且独立设备不受阻；⑮reconcile精确同序/取锁失败/缺任一行/全无无DML；⑯client同步error、首因保留/退役后独立读/无listener泄漏；⑰DDL所有必填/错类型/额外字段/错binding/日期/索引负例；⑱旧M2 NULL行及原M2独立回归。未定义清active或跨业务接线验收，不运行Windows/手机，不宣称满足最终真机目标。
