# M3分片计划：原子领取、journal与真实父子事实（未实现/未接线）

基线5946b2e0b7ab32442670ea60e592cb3b5da67ff5；真实PG通过绑定M2 rc.3 88633cc1和runner073886ee，只覆盖协议账本。当前分支codex/wecom-v2-m3-plan-20261102，原干净。本轮只读源码/具体方案，不写共享index/getPool、不再起PG、不操作Windows/手机或发布。

## 已核实际入口与不能直接复用的行为

- server/index.mjs领取分支先把windowsTask/job改running、创建v1 physical hold，再persistTaskMutation写task/job/session/hold/audit。snapshotWindowsTaskClaim/restoreWindowsTaskClaim遇错误会恢复记录，并删除快照之后新增的原任务physical hold；这套“失败即回退”不能拿来推断COMMIT未知未发生。
- M2 createPending自有事务只建账本；将它与原persistTaskMutation各调一次不是原子领取。M2存储committed也从未授权host ACK/UI。
- 当前checkpoint仍可能向generic upsert写pending physical及原任务；task generic upsert与snapshot双写按wall/旧内存数据覆盖。M3不能只证明一次三类写事务，就声称后继旧写不会使投影退化。
- runWecomPreviewTask现收到v1 ready后马上登记、ACK后写业务stdin，真实close回传；createPhysicalLifecycle只活在内存，缺journal。reader_bootstrap现核固定SYSTEM父子/路径并读OS出生，但父Agent的独立真实实例采集、v2握手/journal与时效接线仍未完成。
- data/wecom-send-claims是发送业务防重路径，不是process journal，不能拿它证明reader/父实例退出。现M2 ErrorEmitter contract只管checkout拥有期，idle pool全局契约仍待root接线审查。

### client与idle pool生命周期分工

M2 rc.3只拥有checkout返回后至release/destroy的本调用client listener，首错误止步且精确清理；不能为一个事务永久挂Pool监听，也不能替其他模块接管client。现index:getPostgresPool创建共享Pool，本地源码未见该入口注册专门idle error策略；接线时应由root的pool owner在创建处**一次**处理pool error，而非M3业务叶反复注册或加全局uncaughtException。

pool owner须记录有限error category/受影响连接及存储健康结果，明确该事件如何影响现readiness/待确认事务；不是空回调吞错，也不自动重放业务、清fence或重启PG。单个idle连接失效与整个数据库不可用要区分，不能在M2擅自把一个连接错误扩大成其他手机全停。具体健康降级/只读恢复probe由现persistence/readiness负责人单独审，M3a不写getPool。隔离fixture保持非目标client和idle pool错误仍失败；这不等于要求生产进程用throw崩溃来处理池错误。

## 先做M3a：三类记录同一事务的未接线候选

三类指原任务类（windowsTask及其automationJob/session必要状态）、非过期物理hold、v2协议账本。建议最小文件：

| 拟动文件 | 限定变化 |
| --- | --- |
| 新server/wecom-cleanup-v2-claim.mjs及同名test | 纯准备canonical claim bundle，严格校验原task/job/device/slot/Agent实例/原业务fingerprint，输出存储候选；不生成ACK/配置许可 |
| server/wecom-cleanup-v2-postgres.mjs及test | 只加命名createClaimBundle/reconcileClaim方法，复用现私有owned transaction/error生命周期；不导出任意SQL/transaction回调，不调generic upsert |
| 新deploy/sql/wecom-cleanup-v2-claim.sql | 提案为专属v2表新增可空claim_data JSONB，保存不可变claimOperationId、原job/原业务lock、原业务fingerprint/候选摘要；不放进M1 exact state，不改其schema |
| 独立verification M3a PG fixture | 延续已审新私有cluster方式，固定源码后交root；旧PG14回归与新跨实体/未知/回退用例分别计数 |

claim_data为**提案待审**。现M2对账显式SELECT六列、不假定这个列存在；旧M2-only/null记录不自动变成已领取业务。给现binding塞新字段或给M1 state加claim属性会破坏严格schema，故不这样做。

claim_data只存稳定IDs、版本和原业务fingerprint，不复制完整手机号/备注/凭据；原任务类数据沿现必要业务存储，测试与报告脱敏。新增列/方法的精确schema、旧数据兼容和故障fixture先审，不自动执行迁移。

建议事务顺序：可信认证/请求schema连接前检查→固定顺序锁原windowsTask/job/必要session及物理门控记录→核queued/原映射/业务指纹、旧物理hold/查名/控屏冲突→生成一次且固定的execution/obligation/claimOperationId→同事务写任务类running+v2 payload、physical hold、v2 revision0+claim_data及audit→检查每条实际行数/返回原数据→COMMIT确认或按原claimOperationId独立读取全tuple对账。任务UPDATE用queued状态与完整原JSONB快照CAS，不以updatedAt充当版本，不将0行写当成功。

若同claim重传，全tuple（任务类/hold/账本及业务fingerprint）必须一致才返回原存储结果；同ID换内容/跨epoch/另一个执行拒绝。COMMIT未知期间保留本机按物理serial的pending-claim fence，不调用旧restore把原设备开放，也不改opid/nonce/重排原任务。副作用未知不能退回“纯前置拒绝”诱使新执行；恢复新进程只读重建pending，不把旧epoch重新签成新任务。

M3a产出仍protocolPermit=false，不返回host ACK，不向Agent/reader发手机号。claimOperationId是服务器本次领取的稳定内部身份，不等于外部业务requestId；未来poll响应丢失/父Agent重启的恢复契约须单独核对，不能以新GET自动重领running任务。未有可验证Agent实例上下文时默认拒绝，不用UI能力布尔代替。

### 旧写共存/门控是接线前的硬前提

canonical v2账本独立保存义务与claim指纹；原task/hold是需一致的兼容投影。若checkpoint使投影不匹配，读取/配置前核验必须转maintenance，不能清v2 fence或自动修回旧数据。新门控必须同时看v1 hold、v2 pending与本次pending claim，主号/分身共享物理serial；不能只看legacy hold当前一行或账本stored状态。

root后继集成需明确哪些checkpoint/业务状态写路径保留v2 claim投影、怎么装载v2 pending，以及所有查名/控屏/企微入口统一询问门控。M3a叶候选不写这些共享入口，不能因此宣称冲突问题已解决。若需要修改通用持久化，须再单独评估最窄v2排除/投影策略；本片不扩generic upsert，不用数据库全局trigger让其他业务checkpoint整体失败。不同设备不串一个全局等待队列。

### M3a实际验证计划

本地先纯bundle反例：错job/task/slot/业务指纹/Agent实例、preview/send混用、同claim换内容、输入冻结。新隔离PG分别在每条任务/hold/ledger写前后注入失败，核实际全部或全无；真实COMMIT丢回复后读**完整tuple**，不只见账本就ACK；两个同task不同执行只能一个胜，同claim复用；旧snapshot覆盖反例使门控拒绝而不开放；新进程/新epoch恢复不重领、不删hold。保留旧M2 PG14与v1回归。先固定fixture交root再执行，不能连生产。

## 后续M3b：恢复journal，只在专属模块先验证

拟新windows-agent/src/wecom-cleanup-v2-journal.mjs/test，独立于wecom-send-claims；schema只含task/execution/device/slot/父与reader原PID-born-machine/nonce/阶段/操作摘要/原close事件。不得写手机号、备注、Agent token、Cookie/密钥或业务payload。

顺序至少覆盖spawnIntent持久→真实spawn/ready身份持久→host注册未知/ACK持久→configIntent持久→单次stdin写→真实close持久→close ACK未知/确认。部分stdin写或ACK丢失不重写payload。父进程崩溃/新实例接续时只恢复pending/维护，不以当前PID不存在、kill尝试或新的父实例捏造原close。未取得确切身份的spawn中断保持未知；等待bootstrap不能接触SDK/手机。

原子替换、文件flush、损坏/截断、并发、写盘拒绝及断电恢复都要验证。Mac文件fsync不证明Windows NTFS/ACL/刷盘语义；chmod600不能证明Windows受限ACL。先只读核现SYSTEM data目录权限，再设计实际受限journal fixture；无法确认则在手机号释放前失败，不修改SYSTEM计划任务/ADB keys/env/startup来绕过。不安装新的启动入口。

## 后续M3c：真实父子facts与v1兼容（先定适配器再接线）

专属拟动为wecom-cleanup-protocol-v2.mjs/test、wecom_host_identity.py的独立v2入口及runWecomPreviewTask分派；共享Agent/index由root持有，未审本片不写。parent事实必须来自真实固定SYSTEM Agent实例、OS出生/机器身份/父子关系与实际spawn child；nonce只能绑定，不能单独证明新spawn。reader原出生值保留，不和云wall比先后；父侧OS事实采集具体适配器与真实SYSTEM验证先审，不能以自报PID+boolean或Admin样本代替。close只采原spawn对象的实际close，不伪造旧43。

v2还依赖已审的实际connected-peer/出生身份守卫与真实时间授权适配器；当前Linux/VM/真实误差/Windows时效依据未齐，默认不能把M2 committed升级为host ACK。需要后续明确配置释放与proof的generation、持久后新采样和完整耗时界，不放宽3秒或复用旧stamp。

兼容矩阵：旧server/旧Agent=现v1；新server/旧Agent=只v1；新server+明确支持v2的Agent=默认仍关闭，完成全部前提后仅新任务启v2；旧v1/legacy义务维持原ID/状态，无自动迁移/重标时间。回退停止新v2领取，旧pending保留并阻止相同物理设备，不DROP账本/journal或伪装回v1重跑。原43/147/52和155/157查名池不核销。

完成以上本地候选及root集成审、所需实际Windows验证/安全加载后，才恢复本轮空闲主号→另一主号→空闲配置分身的真机预览；仍尾号6441、发送前停。唯一现配置分身155与查名池冲突时不抢占；不得用外部真实发送接口代替预览验收，不在本片顺带新增对外preview端点。

本轮仅计划，未写M3业务代码/DDL、未运行新测试或任何PG/Windows/手机命令。共同流程2026-09-30 SHA256 0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b；下一动作先审M3a限定文件/claim_data/旧写共存前提，再编码，不能把整份M3一次接线。
