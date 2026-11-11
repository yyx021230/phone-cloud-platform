# C片：投递字段、调用者和后续进展回执，仅提案

基线 b5c93b4676344687e6d5affd5c7d99db2bc65910，B验证固定 eb42fc4，root实际审查2ef4a35。接受B的合成owner/known COMMIT及目标局部回退机制；本片延续此前projection SQL C项，细化其调用可达性和未知提交边界，不替代S1/S2/journal/native路线。不改代码或DDL，不执行SQL、PG、Windows、ADB、手机或接口。

## 已核代码事实

1. `server/postgres-repositories.mjs:344` 的 persistWindowsTaskDeliveryLease 在自有事务内仅用task_id匹配。三个jsonb_set替换当前data.delivery、data.deliveryAttempts、data.updatedAt，同时改SQL updated_at，之后insertAudit。没有全JSONB替换，也没有claim、状态、Agent或执行代次CAS。原比较模块originalDeliveryUpdate保持这三个路径，仅补RETURNING供观察；不是整个方法含audit的集成测试。
2. `server/index.mjs` 的poll首先认证Agent、scope、agentId/queued、设备运行占用、activeTaskIds、排除serial和协议能力。仅managed lookup/gallery/xhs_publish进入leased分支；`managed-lookup-delivery.mjs` 委托gallery profile，**WeCom preview不在当前leased分支**。不能把对WeCom合成行直接执行此SQL称为真实WeCom路由可达或线上已发生过的漏洞。
3. payload/ack/status均检查windowsCtxCanAccessTask：绑定Agent ID或明确开启的legacy令牌。gallery/managed ack校验当前delivery token/状态/时效；managed另有runtimeId投递字段与status generation检查。WeCom普通status按Agent ID，尚无v2 claim/epoch/parent执行上下文接线。已存在的token/generation检查必须保留，不能说“所有旧caller都能写”，也不能拿Agent ID相同证明具体执行实例合法。
4. WeCom status走现有普通任务同步与noteTerminal；这与leased delivery分开。没有观察到v2受控progress持久回执。M3 recorded只说明claim tuple仍在，不说明某条新progress已提交。

## C1建议首个最小验证片：两组SQL效果，调用条件另做本地核对

仅在根再次审查源码/tag/hash后使用全新owned私有库。复用已审M3真实claim、严格source/dependency guard、单次新root、超时/原Popen清理/失败保留边界。不更改旧p.originalDeliveryUpdate、不调用生产repository或index，不改生产owner。

|组|实际输入和观测|必须保留的结论边界|
|---|---|---|
|delivery-fields|原M3完整claim建立后，执行原三路径SQL，给定合成delivery及attempt。known COMMIT/release后新backend核SQL元数据、恰三JSON路径；将它们剔除后所有其他已知未知JSON深等，task/job/ledger claim与physical hold/anchor保持，M3 recorded|只证明窄SQL字段效果；不证明caller权限，不验证audit方法，不新增WeCom lease支持|
|delivery-stale-proposal|同一task依序写合成较新delivery，再提交带旧token/attempt/时间的候选到同一SQL。预期只要task_id相同仍更新1行；新backend核delivery确实替换而claim/物理义务仍在。若实际结果不同照实失败|这是repository语句不带CAS的负控制；旧候选由fixture直接输入，不能外推当前路由会放过token/auth检查，更不能声称WeCom该分支可达|

无需为此重签claim/epoch或改原business关联。无实际并发时不称EPQ/阻塞证明；若下一片要证明并发，必须另提A/B/C真实server Lock证据，不用sleep或调用顺序假冒。新原件必须保留RETURNING、前后精确JSONB/hash、事务结束与fresh backend事实，不累计旧4/4。

调用条件核对另设本地纯fixture：当前gallery/managed helper对有效token、错误token、到期、running已ack幂等，以及WeCom profile不支持的现有行为；原helper从可信源码导入，不复制一个更宽松实现。HTTP认证只读代码审查不能冒称运行真实中间件；如果要测HTTP须另设计隔离server，不启动生产入口。现在未编写或运行这些测试。

## C2受控progress：先审回执合同，再给源码授权

见RECEIPT_CONTRACT.md。C1不能“顺便”实现产品authorizer或新表。ownerTask/Job/DeliveryCas字符串仍只是未接入fixture，必须同client anchor/full tuple、原claim绑定、所有不可变字段/未知字段保持，真实caller/parent/host/journal/mapping能力由后续根协调提供。

未来最小场景包括：正确owner task+job进展与receipt同TX known COMMIT；同op同内容返回原receipt不重执行；同op不同内容拒绝；task成功但job CAS0全部回滚；COMMIT回复前/后丢失只用原op/指纹独立读取；旧epoch/claim/执行身份不写；目标NOWAIT/CAS0只局部回退，连接或COMMIT失信整个owned事务unknown。每条完成后逐请求发布，不等整轮。

当前阻塞项是持久receipt的存储、内容指纹规范、生命周期和真实owner来源均未实现。未经审查不造DDL或从现claim推导成功；unknown保留物理义务且不重跑外部操作。shared blob/boot/旧writer、lookup独立owner引用域与跨协议admission仍由根协调；43、147/52、查名155/157保持，主号/分身真机未完成。
