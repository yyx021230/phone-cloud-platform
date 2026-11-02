# S1纯projection-policy叶：输入和决策

基线9bf9bde951f0fd79fe6be1e4573ef899e3d157fb，root4814a5de明确仅本地新叶/测试/fixtures。工厂`createWecomV2ProjectionPolicy({readPolicyEpoch,readCanonicalProjection})`必须是两个自有data-property函数，无verified/ready布尔开关。读取epoch一次固定本policy实例；每目标调用同步provider前后核相同epoch。实际DB owner未来先异步读取/锁定/规范化，再用只返回该快照的代码closure提供；provider形状不证明真实数据库来源或锁/屏障。

模块只import node crypto/util、原纯claim及M1结构校验；无SQL/文件/网络/进程/clock/ID生成、执行器或日志。privileged provider未来由可信代码实现，不接受UI“已认证”字段替代。当前没有任何共享writer调用它。

调用输入exact `{targets:[{target,writes}]}`，最多128目标；每目标JSON值最大256KiB/50000节点/24层，拒绝非JSON/访问器/循环/稀疏写数组。目标exact `{deviceId,serial,agentId}`，deviceId必须`adb:`+原serial，serial固定大小写和格式；与canonical关联精确核对，物理anchor key才小写。writes最多64条，exact `{kind,record}`，kind为windowsTask/automationJob/physicalHold/businessLock/device；每条record.deviceId必须同目标。输入错误只该target reject；batch外形错误返回invalid_batch与空results，不调用provider。

provider返回exact `{version:1,kind,observationId,serverEpoch,target,canonical,legacyPending}`。observationId/epoch是限定格式固定代码关联，不是来源证明。target必须精确等请求目标。kind支持present、observed_absent；其他kind及missing/null/undefined/异常均ownership_unconfirmed。legacyPending非空永远reject_target/保留旧义务，内容不升级或复制成v2。

observed_absent必须canonical===null、legacyPending空，仍只是legacy_candidate且**无写入或执行许可**。缺canonical字段/缺整份观察不能当observed_absent；kind=present但不完整记录则reject_target。如何从真实数据库证明“完整读取且无v2义务”是后继owner/共享屏障任务，本叶不提供。

present.canonical exact七字段：anchor/windowsTask/automationJob/physicalHold/businessLock/ledger/device。前六为已审M3六步loader的固定列集合，必须先由DB owner把PG Date规范为UTC ISO/null、bigint保留正整数字符串；该纯叶不直接接受JS Date或执行规范化数据库查询。device是关联配置JSON。拒绝任何缺行或错列集合。常规JSONB data允许业务扩展字段，但身份、模式、原业务指纹与M3原关联严格校验。

核对ledger精确M1状态/revision/绑定/epoch；claimData十字段和原claim IDs；task/job上的claim相同、task.payload binding相同、pickedAt等于固定recordedAt；anchor活跃IDs/serial/device/Agent/fingerprint精确；物理hold为非过期cleanup_pending、原业务关联不变。business lock可active/released/expired但不清物理义务。task/job可running/stalled/succeeded/failed/cancelled/expired且不必相同，M1合法revision0/1/2允许；事件/result/updatedAt正常进展不是原queued CAS不等故障。

重用原纯claim preparer核不可变业务指纹及完整task/job/owner/request/slot/device/Agent关联：只在**私有验证副本**重置可变status/result/终态时间并移除v2注记，不修改canonical或原记录，不生成新IDs，不持久化或升级旧v1/NULL。canonical自身缺注记、queued回退、ledger legacy NULL、状态投影不一致都拒绝目标。原完整queued快照CAS仅是M3首次领取职责，本叶不执行CAS、不重新领取。

提出的旧queued快照可没有v2注记，immutable业务/ID必须仍相同；这表示应保留当前canonical，不能写回旧快照。提出的marker若存在则须精确；跨账号/号码/备注/mode/slot/device/Agent或原锁关联变更拒绝。提出的物理release也不能清canonical：本叶仍retain_canonical并始终releaseAllowed=false。正常进展应由未来专用owner操作，generic writer不从此结果获得写权。

输出exact顶层`{requestError,results,writePermit:false,protocolPermit:false}`。逐目标只含targetIndex、decision、固定reason码及writePermit/protocolPermit/releaseAllowed/canonicalSourceVerified恒false、retainExistingObligations/liveChecksRequired恒true。不给原号码、备注、完整快照或provider错误消息；目标只有数组序号。结果深冻结。

| decision | 语义 | 不能推导的权限 |
|---|---|---|
| retain_canonical | 在给定未证实来源的快照中，当前tuple关联一致，旧generic提案应保留当前投影 | 不写、不发配置、不放物理锁 |
| reject_target | 该目标输入/tuple/提案冲突或旧义务待处理，保留原义务 | 不修复、不换ID或重建 |
| ownership_unconfirmed | 没读到完整当前来源/epoch/关联，不能确认owner | 不把未知当未领取/空闲 |
| legacy_candidate | provider显式观察无v2、但未证明旧业务/映射/实时条件 | 不升级v1、不允许写或执行 |

实际53项本地纯测试通过，fixture由已审createWecomV2ClaimPreparer候选生成，与已验M3 normalized tuple列相同，不导入PG/fake pool/执行器。覆盖主/分身和preview/send仅合成数据、缺行/回退/NULL/v1不升级、合法状态/M1进展、旧快照/immutable提案、provider/访问器失败、两设备一冲突另一继续、输出无业务内容/冻结。没有任何DB/SQL/Windows/手机/生产操作，不证明真实来源、跨旧writer互斥、Windows父子或真机。共享S1b SQL/EPQ/blob启动重建、S2映射屏障、S3 IO及native都仍未实现。
