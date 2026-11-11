# S1b后继投影SQL：分成三个最小验证片，未执行

基线b1be4cd1fd4bbb0f7d39d15958732ec3229e92a2/observed.1，rootf3a52189接受task EPQ3+target SAVEPOINT私有4/4窄行为；不是生产根因或shared修复。当前只精确方案/未执行SQL字符串，不修改既有comparison、产品、DDL、index/repositories/cleanup-service/Agent，也不执行PG/Windows/设备。

## A. 下一最小建议：job/hold各正负对比，共4组

复用已审A真实M3完整5DML在COMMIT前暂停、B raw语句、C第三owned backend active/Lock/pg_blocking_pids精确A后放COMMIT的fixture边界。新数据命名空间/guard/hash/单次新库另审，不重用任何旧成功或失败库。B updatedAt2099严格晚于A，不能因旧timestamp条件而假阳性。

job-negative使用本文件unsafeJobUpsert，与当前generic repo同列/SET/旧时间条件，仅alias/RETURNING为验证补充。旧候选同jobId和immutable业务、queued/result旧状态、没有wecomV2Claim；预期在A提交后覆写1行丢claim，M3 full tuple重读conflict。job-guarded沿ad4bc2比较模块guardedJobUpsert，必须0行/rows[]、最终JSONB深等A job/claim完整/M3recorded。结果不合预期失败留证，不修改断言凑绿。

hold-negative使用unsafeHoldUpsert，旧候选同physical obligation ID和binding、status改released/updatedAt2099；SQL expires_at仍NULL，不能通过造过期日期来掩盖nonexpiry。预期冲突INSERT/ON CONFLICT实际等A后更新1行，最终statusreleased/M3conflict，但canonical anchor/ledger仍held，不声称实际释放了手机。hold-guarded沿原guardedHoldUpsert，必须0行/rows[]、最终完整nonexpiring cleanup_pending/binding/M3recorded。

hold的B等待可能发生在unique/transactionid冲突，必须以真实active/Lock+blocking PID为准，不假设同task row锁类型。每组保留A/B/C PID、A5DML、服务端proof、返回值/JSONB规范hash、最终status/marker/claim及fresh M3结果；完成case与失败attempt分开。候选仅验证原始SQL能否保留投影，不是从现网日志确认哪条writer实际触发过覆盖。

## B. 原business lock无marker，另片两组

实际M3创建claim时原business lock不写、不添加wecomV2Claim；因此直接给它套NOT(data ? 'wecomV2Claim')仍可放过旧写。B-negative先在真实已有claim后提出不同owner/job/device关联或错误status；insufficientOriginalBusinessGuard若更新应被作为负例保存，不能宣称task/job/hold marker已经保护原业务锁。

原business lock合法released/expired并不清canonical physical义务。受控正例必须未来owner在**同一事务**先anchor NOWAIT、全tuple同序读、验证原claim/context与immutable关联，再仅允许status/审计时间迁移并按旧完整JSONB CAS。ownerBusinessStatusCas是待审SQL，不是已授权方法；M3普通reconcile会另开连接，不能在自己持anchor时拿它当同事务loader而触发自锁。需要独立verification loader复制精确查询/规范化并用纯策略核结构，不能导出执行器或改已审M3来迁就测试。

验证fixture拥有明确合成owner context，不把S1 retain_canonical当写许可（其writePermit始终false）。保存受控操作前后的原business身份、phys hold/anchor未改，M3真实fresh重读recorded。未知/NULL/关联不齐或CAS0一律不执行更新，保留目标义务。此片协议权威仍只测试合成上下文，不证明真实caller/Windows来源或跨业务admission。

## C. 定制delivery与controlled progress，第三片

当前persistWindowsTaskDeliveryLease不是整份data覆写：jsonb_set在目标当前行只改delivery/deliveryAttempts/updatedAt，理论上保留其他字段。必须按originalDeliveryUpdate实际验证，不能为寻找漏洞写成“旧delivery会抹claim”的假预期。它只有task_id条件，没有claim/execution/current-state CAS；同task旧投递请求/旧Agent实例是否能改变当前delivery是另一负例，不假设同task允许重签claim IDs，最终marker可能仍完整/M3recorded，不能将“没有删marker”误当caller合法。

controlled delivery/progress另有授权owner路径：同事务anchor/full tuple与固定claim/epoch/执行身份/live/journal权限，immutable proposal先核对后old full JSONB CAS；ownerDeliveryCas/ownerTaskProgressCas/ownerJobProgressCas给出精确参数/RETURNING，但没有生产实现。task/job状态result/events合法变化必须能真实落盘，不能所有v2 generic写skip后称任务仍可返回结果。host/close操作ID和任务业务状态推进分开，业务success/cancel不清phys hold。

此片先准备最小真PG场景：正确owner task+job状态/result同事务提交→fresh读取与M3recorded；旧claim/epoch/完整JSONB错或immutable号码/备注/slot不同拒绝不写；task行成功但job CAS0必须整体rollback；COMMIT前/后断回复只同IDs对账不重播任务/发送；callback结果逐请求在durable known后发布，不整轮等齐。字段值为合成数据，不调用真实customer-invitations或Agent。

但只看到同一个claim仍recorded，**不证明某一次progress/delivery修改已提交**：该tuple可能在本次操作前已存在。C还需独立固定progress/delivery operation ID、完整内容指纹、已提交回执的存储合同先审；不能换claim ID、挤进M1 exact两操作状态或用旧events数组可裁剪记录冒充永久回执。当前未定义该合同/新DDL，因此不把本文件CAS字符串称为可恢复完整owner实现，未知时继续保留义务，不返回业务已成功。

## 边界、共同blob方案和验收

三个片不能自动扩大为shared writer改造。原generic两套UPSERT、定制delivery/maintenance/restore还未接本代码，S1b完整owner进展与首片4组不是同一结论。所有SQL类型/RETURNING/JSONB/状态以真实新库核验，源语法检查不算PG通过。

full-state blob/启动overlay与lookup executionWait的两个owner引用域仍按ad4bc2共同方案由root统一shared hunk。lookup canonical schema尚待其owner，不在此造表/字段或将WeCom anchor自动视跨协议原子门禁；不只在structured加条件而忽略blob/旧镜像恢复权限。业务锁可释放但两个owner各自持久义务必须保留，target unknown不拖无关target，真实连接/COMMIT失信不伪称其他提交。

建议root下一仅授权A四组fixture/owned runner源码；B/C待精确loader/context/迁移合同另审。当前实际只JSsyntax、基线/hash和最小差量检查，无SQL解析/PG/Windows/手机/生产。S2/journal/native仍默认禁启，原43设备清理义务/147/52、查名池与所有冻结保持，主号分身真机未验收。
