# M1：企微 v2 host 状态准备器（未接线）

基线441a0e7744f77844c70d5aacc0b3159d1d938679，干净工作区；分支codex/wecom-v2-host-m1-20261102。root审查441a计划后仅允许此片：新增server/wecom-cleanup-v2-host.mjs与专属测试，不改v1/service/index/PG/Agent/Python。共同流程2026-09-30 SHA256 0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b；本阶段不发Windows命令、不操作手机或部署。

## 实现与信任边界

createWecomV2HostState只创建revision0、fence=held。createWecomV2HostPreparer必须注入两个代码级同步provider：未来服务端认证后的完整binding及真实父实例/spawn/close事实。没有默认provider；HTTP/JSON不能提供函数，request内authenticated/clockAuthority等额外字段拒绝。

**provider的来源仍由未来接线负责**：本模块的shape检查无法证明OS观察或认证真实，更不防止具有任意JS执行能力的调用者伪造closure。测试只注入明确合成事实，未实现真实Windows身份、时钟、认证或父spawn采集；nonce单独不构成OS新spawn证明。parent/reader的原PID、出生token、machineId和createdAt逐字段对照provider原事实，audit字段原样保留，不和云端时间排序，也不把云端接收时刻写进出生记录。本叶不对真实误差或出生数据源做新保证。

两个动作仅host、host-closed。严格绑定server epoch、task/execution、物理设备/serial、Agent instance、主/分身槽位与Android user、nonce、operationId、expectedRevision；close必须对照provider原实例的closeEventId，不能以请求exited=true代替。旧version1明确拒绝，现v1解析/运行路径完全未改。

输出为冻结的nextState、replyCandidate和reused；replyCandidate始终durable=false、requiresPersistence=true，不是可对外回200的持久ACK。相同操作规范化key顺序后复用原候选且不增revision；同ID不同内容、错revision、错实例、close先于host拒绝。JSON结构恢复会重建最多两条历史并校验一致性，只是结构校验，不证明存储真实性或COMMIT成功；旧epoch仍拒绝。所有状态保持held，无proof/release/payload许可。

并发从同revision0可生成两个revision1候选——测试明确保留这个事实，不能称纯函数已经解决CAS或选出提交赢家。下一阶段需独立审查专用PG CAS/journal/存储未知/重启pending-release，之后才可谈接线。导入此叶本身不会触发I/O，但调用方若自行实现provider副作用不在纯模块保证内。

## 实际验证

- M1专属45项通过，保留实际TAP与exit0回执。覆盖主/分身、±跨机wall偏差不拒绝、错nonce/parent instance/PID/birth/machine、无真实close事实、同ID换内容、迟到同操作重放、并发revision候选、深冻结输入不变、JSON结构破坏、epoch变化、旧v1和HTTP权限布尔拒绝。
- 原v1 server cleanup、Agent cleanup protocol、physical readiness共50项通过；仅本地fake/自有fixture回归，未启动生产Agent或ADB。没有把45与历史40次运行相加；TEST_OUTPUT.txt是补5项前的初次40项输出，当前源对应M1_OUTPUT.txt。
- 两新增文件node --check通过。产品扫描未发现现有server/windows-agent/public导入新叶；实际源hash/日志见TEST_RECEIPT.json。未跑PG、HTTP新接线、Windows原生、真机或媒体测试；未改共享Agent/投屏文件，不用这些本地用例替代真机验收。

## 导入与回退范围

候选后继只允许导入此叶及同名测试，文档/回执作证据；**不在index导入、不新增路由、不改领取能力或数据库，不将provider测试事实复制为生产实现**。旧14个产品源码hash须保持441a SOURCE_BASELINE逐项一致。撤回仅停止引用候选新叶，不清除任何既有任务/锁/43义务；本阶段没有生产数据或运行行为可回滚。

状态：本地候选待root审；原43/147/52、155/157查名池及全部冻结继续保持。真机主号/分身流程未完成，也未发送邀请。
