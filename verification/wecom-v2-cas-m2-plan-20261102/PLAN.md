# M2：单行CAS、提交去重及COMMIT未知对账（方案，未编码）

起点925898ff05784350885827271f7f8033d05428c6、wecom-v2-host-m1-20261102-rc.2；原工作区干净。分支codex/wecom-v2-cas-m2-plan-20261102。本片只调查/方案，root审后才编写M2代码；不运行PG服务/DDL，不连接生产，不改v1/index/Agent/手机，不实现proof/release。

## 实际现状与需要替换的提案部分

1. 实际启动DDL在server/index.mjs:initPostgresStorage：phone_cloud_device_locks为lock_id PK、device_id、status、可空expires_at、data JSONB；phone_cloud_windows_tasks为task_id PK、agent_id、adb_serial、status、created_at、updated_at、data JSONB。只有锁device/status等普通索引，无v2 revision/operation唯一约束。静态deploy/sql/phone-cloud-structured-schema.sql是旧准备稿，lock.expires_at NOT NULL且无data，不能当运行表结构或本次测试DDL。
2. server/postgres-repositories.mjs:inTransaction执行BEGIN/业务/COMMIT，catch试ROLLBACK；persistTaskMutation允许注入transactionClient，把多实体写在一个事务。upsertDeviceLock按data.updatedAt字符串决定覆盖，windows task按updated_at覆盖，均非revision CAS。COMMIT异常后ROLLBACK并不能证明前次未提交。
3. createPersistencePolicy结构化写完成后仅安排checkpoint。savePostgresSnapshot另TRUNCATE/重写phone_cloud_state，且会把pending physical义务交通用persistTaskMutation；syncStructuredTables跳过physical holds，但前述checkpoint仍有独立写入路径。因此只在同一lock.data追加v2 revision不足以防旧checkpoint/通用upsert覆盖，且本片禁止改这些共享入口。
4. 延续441a的单义务/去重/未知保守边界，**替换其“优先复用原lock.data、无必要不新表”的实现建议**：拟新建专属v2表作协议账本，原物理锁和旧v1始终保持不动。新表不是设备可用性来源，不声称已完成任务+锁+协议账本的跨实体原子接线；那是后继独立片。

来源为本地已核源码，不是本轮读取生产schema。生产版本仍以实际ACTIVE/回执核对，不能从本方案推定线上DDL已存在。

## 最小文件与接口提案

- 新server/wecom-cleanup-v2-postgres.mjs：显式getPool和可信认证binding provider，方法createPending、commitHostOperation、reconcileOperation；无环境DATABASE_URL默认、无自动建表、无路由/任务领取/开门。
- 新server/wecom-cleanup-v2-postgres.test.mjs：单元错误分类/输入边界；真实PG组必须显式本地fixture连接，缺依赖明确未运行/失败，不回退fake绿。
- 新deploy/sql/wecom-cleanup-v2.sql：仅专属表的可审DDL，模块不会自动执行；实际上线迁移另审。本阶段不改initPostgresStorage、原schema、generic upsert或persistence-policy。
- M1叶拟增加两个无行为改动的窄导出normalizeWecomV2HostRequest与validateWecomV2HostState，分别包装现request/state并冻结副本；供独立读对账校验规范化body与持久状态，不重复抄schema，也不从存储造OS事实。此依赖须root在方案审中明确接受；未接受则先停此接口，不自行扩M1。
- 独立verification运行器与有界PG协议代理，仅用于临时私有PG真实故障注入；普通npm test默认不得启动共享服务。生产模块不接受skipCommit/fault布尔或故障环境变量。

M2存储返回单独的storageStatus/已提交操作记录；M1 replyCandidate仍原样durable=false/requiresPersistence=true，不将它提前改成对外ACK。即便storageStatus=committed也只有存储结论，protocolPermit=false，fence held；没有配置下发/手机号/释放许可。M3接线须另审本地journal、真实父实例与时间依据，不能直接把M2返回值当原host路由200。

## 单行与唯一约束

拟表一条义务一行，最多2操作，与M1有限状态一致：

```sql
CREATE TABLE phone_cloud_wecom_cleanup_v2 (
  obligation_id text PRIMARY KEY,
  server_epoch text NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 0 AND 2),
  host_operation_id text,
  close_operation_id text,
  protocol_state jsonb NOT NULL,
  CHECK (jsonb_typeof(protocol_state) = 'object'),
  CHECK ((protocol_state->>'version' = '2') IS TRUE),
  CHECK ((protocol_state->>'fence' = 'held') IS TRUE),
  CHECK ((protocol_state->>'revision' = revision::text) IS TRUE),
  CHECK ((protocol_state #>> '{binding,obligationId}' = obligation_id) IS TRUE),
  CHECK ((protocol_state #>> '{binding,serverEpoch}' = server_epoch) IS TRUE),
  CHECK ((protocol_state->>'hostOperationId') IS NOT DISTINCT FROM host_operation_id),
  CHECK ((protocol_state->>'closeOperationId') IS NOT DISTINCT FROM close_operation_id),
  CHECK (
    (revision = 0 AND host_operation_id IS NULL AND close_operation_id IS NULL) OR
    (revision = 1 AND host_operation_id IS NOT NULL AND close_operation_id IS NULL) OR
    (revision = 2 AND host_operation_id IS NOT NULL AND close_operation_id IS NOT NULL)
  ),
  CHECK (host_operation_id IS NULL OR close_operation_id IS NULL
         OR host_operation_id <> close_operation_id)
);
```

PK保证相同obligation只有一行；host/close各只能占一个槽并禁止两槽同ID，operationId的作用域为义务内，不新增跨义务全局唯一规则。M1完整有限历史、合法ID/host/schema/阶段检查仍须在写前与读取后执行，SQL约束不冒充整个认证协议。CHECK对可空JSON提取显式IS TRUE，避免缺字段的SQL NULL成为通过；列与JSON host/close ID双向校验。DDL暂不含DELETE/TTL/释放状态，不使用wall updatedAt参与CAS。

没有device_id全局唯一约束或跨旧v1物理锁约束：本表只负责协议账本，未来统一设备门控仍是独立必要条件，不能因此新建同设备业务任务。原task/lock不由本片改写。

## 事务与重复操作

连接只来自显式注入的pool；每次写拥有自己的事务，不复用外部未知事务并伪称已COMMIT。默认Read Committed，设置局部lock_timeout/statement_timeout以限制等锁；失败只影响本义务调用，不能持有全局队列。

createPending：当前可信认证binding与输入逐字段相等；从M1创建held revision0。INSERT ... ON CONFLICT (obligation_id) DO NOTHING；然后同事务SELECT ... FOR UPDATE读取。已存在必须是同完整binding/epoch与合法v2状态，不覆盖、不重标epoch、不清操作。COMMIT完成前不返回committed。此方法仅账本初始化，未与任务领取原子化，当前不可接生产。

commitHostOperation：

1. 新取可信认证binding；规范化action/body，拒绝v1/额外字段。BEGIN；SELECT指定PK FOR UPDATE，独立校验列、完整状态与当前epoch/全部binding。不存在不自动建；serverEpoch不匹配只报旧epoch，不更新它。
2. 同operationId存在：规范化action/完整内容必须与持久记录相同，包括原expectedRevision；相同返回原记录候选而不增revision，当前状态可已到revision2。异内容/action一律冲突；不能只凭digest认相同。这里是存储去重，不从数据库记录倒造新OS观察。
3. 新operation：调用M1真实preparer及未来可信父/spawn/close provider准备，要求expectedRevision等于读到revision；不复用请求中的OS/clock布尔。只提交这一个新revision候选：

```sql
UPDATE phone_cloud_wecom_cleanup_v2
SET revision=$4, host_operation_id=$5, close_operation_id=$6, protocol_state=$7::jsonb
WHERE obligation_id=$1 AND server_epoch=$2 AND revision=$3
RETURNING obligation_id, server_epoch, revision, host_operation_id,
          close_operation_id, protocol_state;
```

4. UPDATE必须实际rowCount=1，返回状态须与完整候选一致；0行不是成功ACK。写前、COMMIT前及COMMIT返回后重新核当前认证epoch/binding，变化则保留存储事实但不给协议许可。COMMIT在途后异常进入unknown分类，不能catch回退内存后声称已rollback。

同义务行锁串行化并发；CAS是额外防错保护。两个相同原revision/同ID请求仅一个新revision，另一个读到原操作复用；不同ID/同revision只有一个提交，另一个冲突。同ID异内容不以最后写入覆盖。规范化比较完整JSON结构，不靠JSON.stringify对象键序或仅hash；合法字符串内容不被trim/重写。

## COMMIT reply未知后的独立对账

- 明确区分COMMIT发出前失败、COMMIT在途未知、COMMIT已确认但回复调用方前断开。保存原绑定/operationId/规范化请求/预期revision与阶段，不换请求号、不重放业务，也不换新nonce。
- 原连接退役，不能以其ROLLBACK报错/成功推断COMMIT结果；独立pool新连接、新事务、新快照读取指定义务。对已存在行用SELECT ... FOR UPDATE等到此前行事务结束，带局部超时；不能以在途提交期间一次普通SELECT读到旧版本就判“没提交”。该核验有行锁，虽不改行，不标成无锁/只读事务。
- 只有完整合法状态含原operationId、action和相同规范化请求、原结果候选，且epoch/binding仍匹配，才能返回storageStatus=committed_reconciled。真实协议许可仍false。前次host已提交且随后close也提交时，必须找原host操作的revision1结果，不能返回当前revision2冒充原结果。
- 未找到、旧revision、等锁超时、连接失败、数据损坏、读回COMMIT失败或epoch变化：保守unknown/conflict/obsolete_epoch，保持fence；M2不自动重写。初始化INSERT未知且行尚不可见尤其不能以缺行断言失败，本片不引入advisory锁或后台无界重试。
- epoch重启后旧行保留审计，不能把旧serverEpoch改成新值来复活请求/证明。M2根本不接收proof；未来证明必须单独新generation和真实时间授权，不能用本次存储确认开门。新epoch对旧行不做自动迁移/删除/TTL清理。

## 隔离PG真实验证与故障点

现本机postgres/initdb/pg_ctl/psql均16.15 Homebrew；Compose源码是postgres:16-alpine，只说明主版本相容，不证明线上具体版本。本工作区require.resolve('pg/package.json')实际MODULE_NOT_FOUND；root提供既有共享依赖来源后，本轮用createRequire('/Users/yyx/ztqc/phone-cloud-platform/package.json')只读解析，实际找到该根node_modules/pg，版本8.22.0，与本工作区lock文件pg=8.22.0相同（package声明^8.16.3）。后续独立测试可显式使用此已确认依赖，不安装/升级、不改共享内容或package锁；来源/版本变化先停。没有启动测试库，二进制/模块可解析不算真实CAS已验证。

获方案审后，运行器只建随机私有临时目录、随机loopback端口与私有Unix socket、initdb新数据目录和固定fixture数据库；显式最小环境、无生产URL/凭据继承。非root、无capability；拒绝已有数据目录/非loopback/非fixture库。只启停自己新建cluster，不探测或复用本机共享5432，不自动启动Docker/Homebrew服务。先保存启动/测试/停止回执，验证自有PID退出后才删除自有临时目录；清理失败保留路径/证据，不能全局pkill。

真实用例：

- 两条独立PG连接以barrier同时提交同revision：同ID同内容只增一次、异ID只有一个成功；实际SQL行revision/ops与返回逐项核对，不能只验证内存结果。
- 同ID异内容/不同action、canonical键序重排、host已提交后close再提交的迟到host重放；不同义务行等待不互相占全局锁。
- 独立连接持行锁时有界超时；触发器在此专属fixture表上拒绝UPDATE，确认原行与revision不变；非法SQL直接写缺JSON字段/重复槽ID时约束拒绝。
- 确认COMMIT已实际在PG完成但调用方未收到：测试专用有界PG协议代理收到后端COMMIT CommandComplete/ReadyForQuery后，丢弃返回并断前端；模块得到连接错误，新直连核原操作已持久。这不是把COMMIT函数mock成throw。
- COMMIT发送到PG之前断代理并关闭其自有后端连接，确认原连接事务已结束、独立读仍revision0；接口仍不得编造committed。UPDATE后断链、COMMIT响应丢失、重启Node后读取、初始INSERT未知缺行分别保留日志。
- 代理/PG后端只属于本临时cluster，固定帧大小和超时，不操作生产backend；无HTTP/真实手机号/ADB。测试fault参数只能在fixture代理，不在产品模块增加bypass环境变量。
- 修改可信epoch后相同原操作拒绝；读取旧行数据保持不变，不清fence、不允许创建旧证明。依赖缺失/代理边界未实现应红或明确未验，不能让mock分支兜底PASS。

还须回归M1 61与原v1 50；这些不是PG测试数量。这里只列计划，本轮没有运行这些测试、SQL或PG服务。

## 回退与接线门槛

未接线候选撤回只是不引用新模块；生产本轮没有可回滚改动。后续若已应用专属表，旧版本继续忽略该表，**保留所有行**，不DROP/清空/重置revision/整库恢复；关闭新v2领取与具体部署另审，既有pending不因回退释放。表不是旧物理锁的替代，新旧状态合并、原任务/锁原子创建、journal和unknown重启门控都留待后继接线片。

本轮不改运行时能力，不发成功ACK/配置，不触碰查名/控屏/ADB或旧43。只有方案审、依赖与真实PG证据、未知/回退/跨epoch测试完整后，才考虑后继阶段；不得宣称真机主号/分身或对外API验收完成。

## SQL语义核对来源

本计划只采用PG16行锁等待和Read Committed的新命令快照语义；官方文档不替代故障注入测试：[行级锁](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS)、[Read Committed](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-READ-COMMITTED)。约束中显式防NULL绕过，PK/同一行检查的职责与完整协议校验分开：[约束](https://www.postgresql.org/docs/16/ddl-constraints.html)。
