# 企微物理清理核验契约 v1（本地设计，未上线）

2026-11-02；服务端基线2b5e932，Agent由企微窗口实现。R2，延续“业务终态不证明物理清理”，不改业务邀请结果、发送claim或媒体。只读核验，不执行kill/remove，不重放查询/邀请。生产与手机操作不在本阶段范围。

## 绑定与存储

既有device_lock.data保存独立`wecom_physical_cleanup`义务行（独立lockId/taskId，status=cleanup_pending，expiresAt为空），未完成条目不随job/task归档、锁TTL或业务终态删除。不是原业务锁；旧job释放其原lockId不触及义务。启动额外加载未决义务，5000条上限溢出拒绝启动，不静默截断；归档显式保留未决行，不用极远expiry。领取企微任务前，与running task同事务提交新义务；任务payload新增`physicalCleanup`：

```json
{"version":1,"obligationId":"fixture-obligation","originalTaskId":"fixture-original","executionId":"fixture-execution","deviceId":"adb:fixture","serial":"fixture","agentId":"fixture-agent","appSlot":"main","androidUser":0,"nonce":"fixture-execution-nonce"}
```

所有字段由云端生成或从已核验原任务固定，后续必须逐项精确相等。身份来自现有Windows Agent token及tasks读写scope，不新增权限。nonce仅防串代，不代替认证。新Agent领取声明`wecomCleanupProtocol=1`；不支持协议的Agent不领取新企微任务，其他业务不受此能力门槛影响。

未知义务阻止该物理手机所有槽位的新业务和派发，不占用其他手机。既有同任务只允许登记host/上报终态，不允许重新投递业务。原host未确认关闭、新证据缺失、资源残留均保留义务。业务任务失败/取消/过期仍保持原业务终态和send claim。

## Agent端点（全部POST，沿用Agent鉴权）

前缀`/api/v1/windows-agents/:agentId/wecom-cleanup/:obligationId/`。

1. `host`：在原生读取开始前登记`{binding, hosts}`，hosts为`[{role:"reader",pid:124,createdAt:"ISO",creationToken:"0x1.9p+30",machineId:"64位小写hex"}]`。只包含真实任务专属OS子进程，至少reader、最多8个，额外子进程必须全部登记；共享长活Agent不属于待退出host，不为合同创建新的supervisor。PID正整数、role唯一；creationToken是psutil.create_time().hex()精确字符串，PID复用判断不得用ISO毫秒替代。machineId为Windows MachineGuid只读SHA256，全部host若存在则必须同机；缺精确身份的旧任务保持maintenance。reader先ready等待stdin，父Agent取得真实身份并完成登记成功后才允许操作手机；已登记只能完全相同地重试，不能换PID。若启动失败无法取得完整身份，保持maintenance，不能补猜。
2. `host-closed`：`{binding, hosts, observedAt, exited:true, observerMachineId}`。observerMachineId必须匹配原登记machineId；不能在新电脑以旧PID不存在冒充退出。匹配已持久登记的全部host身份，由仍存活父Agent确认实际退出；业务终态/子进程stdout/单独cleanupConfirmed不构成证明。允许业务终态后的迟到证明；错误任务/Agent/nonce一律拒绝。缺登记或无法核实退出不解除义务。
3. `verify`：`{binding}`。仅原业务已终结、host-closed已提交、无该手机其他运行/控屏/人工租约时创建新的`wecom_cleanup_verify`任务；有未完成核验任务则返回原任务，不创建重复。任务仅核验资源，不启动SDK/业务。每次新核验固定`verificationId`、新nonce和2分钟截止。过期/失败不能清理义务，再申请时使用新代次。
4. `proof`：`{binding, verificationId, verificationNonce, verificationTaskId, snapshots:[...]}`。只接受当前已领取核验任务的同Agent报告。每帧为`{observedAt, packagesAbsent:true, packageNames:["com.netease.open.pocoservice","com.netease.open.pocoservice.test"], serialForwardCount:0}`。恰好2帧、严格时间递增；都晚于本次核验领取，接收时各不超过3秒、不晚于服务器当前时间；原host退出必须早于两帧。目标serial上任意forward（包括合法媒体forward）均拒绝，绝不为通过而移除。包名必须恰好这两个；unknown/缺字段/命令超时不能转换为absence或0。

`wecom_cleanup_verify`的payload为`{physicalCleanup:binding,verificationId,verificationNonce,issuedAt,expiresAt,hosts}`，无手机号、姓名、邀请码或原业务payload。Agent领取继续声明protocol=1；首次领取才固定pickedAt，禁止通用stalled重试重放，专用核验失败可以另开新代次。Agent每次只读命令前核验取消/归属和截止；失权立即停止只读验证并报告失败。

核验租约：GET同前缀`lease?verificationId=...&verificationNonce=...&verificationTaskId=...`，返回`valid`，仅对当前已领取、身份完整、未过期、仍归属的核验为true；不续期，不绕过其他占用。

## 提交与错误

所有新义务/host/close/核验代次/解除均先持久提交再ACK。解除将义务改为verified并记录proof、新核验task succeeded及相关旧锁释放，同事务提交；不改原task/job业务结果。持久失败保留阻断，不能内存提前空闲。并发请求按物理device序列化。已成功proof精确重复只返回同一次完成，不允许新payload替换。旧代次proof不得释放新任务。

错误：400无效schema；401/403沿用鉴权；409 `wecom_cleanup_binding_mismatch` / `wecom_cleanup_host_unconfirmed` / `wecom_cleanup_not_terminal` / `wecom_cleanup_device_busy` / `wecom_cleanup_proof_invalid`；503存储失败。正常提交受清理阻断返回409 `wecom_cleanup_pending`。不向外输出host命令行或任意日志。

## 兼容与验收

现有在途旧任务未登记身份：仅留maintenance义务，不自动伪造身份或清除旧任务。无义务的历史已终态任务不批量回填，不宣称全部历史问题已修复。义务记录独立保留，即使原任务归档仍能按绑定核验，但必须有可信host关闭及新鲜核验；没有则maintenance。

本地必须覆盖：原红例failed/cleanup=false后同机被拒、其他手机可用；取消/过期/TTL/重启/归档不释放；错owner/代次/nonce/迟到/残留/时钟/持久失败；新核验提交才解除；原业务和claim不变。JSON实际进程重启与Postgres事务测试分别记证。真实Agent/手机、共享重载及生产发布未验。旧应用不理解此义务，不能直接回滚并恢复接单；回滚必须保留义务并关闭企微派发，不能删数据以解锁。
