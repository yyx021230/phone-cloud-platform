# 企微 v1 兼容与持久进程绑定：具体差异计划

状态：待协调审查的本地方案；不是实现、发布或真机通过。起点125c22e1abded1706a88f78098ed64e7517cfd0c，工作区原为干净。生产比较基线仍为32c0091a534aa7f9038deb91aa33f202f72e0e6b；未改生产或发Windows命令。共同流程2026-09-30、SHA256 0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b。

## 已核源码与这次解决的具体问题

- server/wecom-physical-cleanup.mjs 的 recordWecomHosts 用 Windows 的进程出生wall判断其是否晚于云端lock.createdAt；validateWecomHosts另要求它不晚于云端now。这两条不能证明跨机因果，会拒绝固定时差下真实新启动的reader。recordWecomHostClosed、validateWecomProof也使用跨机wall。代码缺口已确认；原43的完整ready原件缺失，不能据此宣布它的唯一根因。
- 当前Agent createPhysicalLifecycle.ready只匹配实际child.pid和reader自报出生记录；reader_bootstrap另核对SYSTEM父子/固定路径。缺少父Agent启动实例的持久绑定、配置下发前的一次性握手，以及跨Agent重启后的本地未知义务登记。
- createWecomCleanupService.transaction在内存按设备串行，persistTaskMutation把task/lock写入一个事务，但通用upsertDeviceLock按wall updatedAt覆盖、没有企微revision CAS；COMMIT返回错误后rollback不能证明COMMIT未生效。现有内存回退不是提交未知的对账证明。新的企微路径须另建窄方法，不能借此重写所有业务持久化。
- 当前proof已有“两次包不存在/forward为0、原reader退出、3秒、先持久后开放”的约束。本计划保留，不用删时间检查、调大3秒或重写旧43记录来取得绿灯。

## 兼容选择与最小文件差异

延续v1端点、业务类型和对外API；新增明确版本2的**内部**握手。保留version=1解析和历史义务原语义，绝不自动把v1时间改成接收时刻。延续model.2“每动作新采样/未知不放行”，但不把离线模型或Admin16组观察直接导入产品当权威。下面文件名/字段是待审实现计划。

| 文件/具体入口 | 拟定差异 | 边界 |
| --- | --- | --- |
| server/wecom-physical-cleanup.mjs / createWecomCleanupObligation、recordWecomHosts、recordWecomHostClosed | 显式按binding.version分派；v2绑定原任务/执行/设备/槽位/Agent实例，新增serverEpoch、handshakeNonce、revision。host不再比较两机wall，改验一次性父子握手与持久阶段。createdAt/creationToken原值只作进程身份和审计 | v1函数路径与旧记录不改、不重标时；版本不接受隐式降级 |
| server/wecom-cleanup-service.mjs / handle、originalReady、canPick、transaction、checkpoint | 增加v2登记/关闭/证明阶段；请求带operationId+预期revision，完全相同操作可返回原持久ACK，内容不同拒绝。存储未知保留设备fence并按精确operationId读回，未对账不得回到可派发 | 不改查名队列；一个设备的fence不占全局队列；业务成功不释放物理义务 |
| server/postgres-repositories.mjs / 新增专用persistWecomCleanupMutation、readWecomCleanupOperation | 在现有lock.data JSONB内增加版本/revision/操作摘要/结果，专用事务锁定对应lock行、比对revision、原task和设备绑定，再原子写task+lock。相同revision且内容不同拒绝；提交未知用新连接读回原操作，不能盲重放通用upsert | 先验证现有表/唯一键与装载查询；无必要不迁移表，不改变其他upsert语义。JSON模式另测原子checkpoint与重启恢复，不能用JSON通过替PG通过 |
| windows-agent/src/wecom-cleanup-protocol.mjs / physicalBinding、createPhysicalLifecycle | v1保留；v2父先生成一次性nonce，发给待机child；child回传实际本机parent+reader出生token、machineId和nonce；父校验实际spawn句柄PID及父实例后提交host，只有持久ACK与本地登记成功后可写业务payload | 不接收UI的clock/identity=true；HTTP超时只重传相同操作，不重spawn/换执行ID |
| windows-agent/src/wecom-preview-task.mjs / runWecomPreviewTask | 仅对v2传新bootstrap参数；区分bootstrap输入和业务输入。持久本地pending在payloadReleased之前完成；close只来自此spawn对象的真实close并绑定原实例。close记录先本地持久，再发云端；云端未知仍保留 | child.kill返回、业务stdout、当前PID不存在都不能代替原child close；不增加第二次UI执行 |
| windows-agent/scripts/wecom_host_identity.py、wecom_cleanup_contract.py、wecom_platform_preview.py | v2启动先读有限握手行；reader_bootstrap扩展返回固定父/子身份与nonce，旧出生数据不转换；v2 SYSTEM/runtime检查失败在读手机号前退出 | 保留现固定Python/Agent/ADB路径、SYSTEM、keys、env与启动入口；不启动ADB |
| 新windows-agent/src/wecom-cleanup-journal.mjs | 仅企微小型pending journal，原实例/阶段/原操作体摘要、真实close、ACK未知；原子替换/fsync与ACL前提明确。重启读到pending一律隔离并原ID对账，无TTL自动清除 | 不能用新的父实例替旧close背书；写盘/权限未知在UI前停止。具体Agent data目录权限先只读核实；无权不能新增SYSTEM任务/目录权限绕过 |
| windows-agent/src/wecom-cleanup-verify.mjs、scripts/wecom_cleanup_verify.py、wecom_physical_verify.py | v2 challenge/两组事实/close后上报绑定同执行与新generation；采样的原始时刻、完整管道/HTTP/OS退出/持久化耗时必须计入，验证函数不得把JSON序列化时刻当事实时刻 | 维持3秒上界；generation过期只可新建清理验证，不能复活业务reader；真实peer/进程出生由root/lookup共享组件提供，不能旁路 |
| server/index.mjs 的physicalCleanupRoute及领取分支、windows-agent/src/index.mjs 的poll能力（协调者接线） | 增加独立wecomCleanupProtocol=2能力协商；仅双方均加载且新能力开关开启的新任务生成v2；领取与持久义务原子形成。内部v2独立动作路由；旧1不能领取2 | 本工作区不写共享index；root整合。查名/控屏/共享runner行为不改；本轮不新增对外preview接口 |

精确字段提案：binding保留v1既有身份字段，新版增加serverEpoch、agentInstanceId、handshakeNonce；HostEnvelope为binding+operationId+expectedRevision+parentHost+readerHost+readyNonce。parentHost/readerHost均为实际PID+出生token+machineId+固定role；原createdAt仍原样存档。Agent实例必须与真实父身份相连，不能只凭Agent自填随机字符串。closeEnvelope增加该hostOperationId与原close操作ID；证明绑定verificationId/Nonce/TaskId、同一serverEpoch、同一本地实例和fresh challenge。版本2严格字段白名单单独定义，不能放宽v1 exactKeys混收字段。

## 时效与因果必须分开

握手只解决“这是本次新子进程”的因果和持久身份，**不解决真实经过时间**。不能将“云端收到host的时刻”替换Windows出生时刻来给旧执行续命。v2每个真实副作用、发配置、发证明、持久后开放设备，都必须现取可信本机时间，跨机器只传绑定的保守剩余量并扣完整RTT，不比较绝对wall/uptime。

生产时效适配器仍缺Linux实际源/VM暂停保证、真实误差与速率边界、Windows SYSTEM实例及本地journal/PG实证。16组Admin观察只证明固定API-set可调用；不授予时钟权威。拟先实现上述握手/CAS/journal为默认关闭候选，独立失败反例可验证；时效适配器未经刻画则v2执行拒绝，不能靠测试profile启用。

挑战发出至持久后开门使用同一可信云端epoch作保守上界可作为备选简化研究，但尚未选用：COMMIT返回丢失/延迟、服务重启、所有客体时钟冻结仍需处理；不能声称这个上界消除了真实时钟依据需求。禁止以本计划直接切换现有模型或新增默认支持。

## 重启、COMMIT未知与旧43

1. 领取task+v2义务先原子持久；失败或ACK未知不返回可执行任务，精确对账后才返回原操作结果。
2. host登记与本地journal完成后再释放手机号payload。云端ACK丢失、journal失败、close先到或Agent中途退出均保留pending。
3. proof事务失败与COMMIT未知分开记录。未知只读对账，不以catch恢复内存宣布数据库回滚；确认已提交后仍要本次新采样复核门控。过期/epoch不连续保留maintenance fence，不开门。
4. 重启必须从持久pending恢复，包括已写但未确认完成的release候选；跨epoch证据不当作新授权。具体“已持久verified但持久后新采样失败”的表示必须在实现前固定为pending release阶段，直到完成本次门控；不能仅持久released后在内存补一个布尔。断电各步骤都要实际PG/本地文件回放验证。
5. 原43没有当时host/close原件，仍maintenance，不迁移到v2、不重建它的born/close、不用当前进程不存在核销。147/52既有隔离、155/157查名池不改。旧义务人工恢复应另列有依据的单机流程，与本次新v2灰度分开。

## 验证与接线顺序

- A 本地专用握手/journal/CAS：真实自有子进程+文件，测试错父/错nonce/PID复用、stdin部分写、登记ACK丢失、journal失败、close重排/重复/错误实例、超时退出未知；mock只证明相应分支。
- B 隔离PG：在获准的本地独立库测试同revision并发、更新0行、COMMIT已成功但连接丢失、重启读回、checkpoint交错；按原操作对账，不能以stub COMMIT代替。环境缺失先报告未运行，不接线。
- C 适配器：先明确真实来源与支持条件，独立实际测量/失败证据；在每动作及持久后重新读，暂停/断档/进程epoch变化一律隔离。保持既有全部预算与3秒界。
- D root整合共享index/peer-bound transport，执行Agent与现有投屏回归；v1/v2混合、服务先回退/Agent先回退、pending义务重启恢复均验证。默认新能力关闭，回滚只关新领取，不能删除未结义务。
- E 经审查并获具体加载授权后，先一台空闲main、再另一台；重新读取在线/控屏/查名保留后才锁设备，仍尾号6441且停发送前。目前唯一配置clone在155查名池，不能以本轮授权抢占，主号通过不冒称分身通过；需要非冲突clone或获明确单机排空安排再补。

本轮只审源码/写方案，没有运行新测试，也没有Windows/手机动作。恢复真机验收依赖A–D完成及安全加载；不能把本方案交付写为“全流程验收完成”。

## 原取证注释勘误（追加，不改固定原件）

root后续直接json.load核对发现：export和contract实际命令路径均39字符、4个单反斜杠，没有相邻反斜杠。先前将工具JSON显示的转义读作实际重复分隔符，相关receipt文字注释和主文档说明错误；实际remoteCommand字面、传输、正文均未改变。保留原tag/receipt及其hash，追加本说明；无路径改写、无二进制切换、无重跑。16组观察/API-set实际调用结论不受影响。
