# 企微物理清理v2时间域合同草案

**评审状态：draft.2，未实现、未合并、未发布。** 源码参照生产`32c0091a534aa7f9038deb91aa33f202f72e0e6b`；前置失败观察`37a954fd6a3ec750e70466be99ed7a46ae09605a`。独立本地分支`codex/wecom-clock-contract-20261102`。当前生产新native动作冻结，合同评审通过前不改产品源码；更不调用ADB CLI/SDK、启动第二SYSTEM入口、改NTP或部署。

本草案延续主文档v1独立义务、同物理全槽隔离、未知副作用不重放、当前绑定/机器/精确OS身份/实际close、双帧无工具包及全部目标forward为0、持久原子释放。拟替换的是**用两个机器的wall大小判定因果和新鲜度**，不是放宽已有证明事实。43旧义务不迁移、不补造原host；其维护另评审。

## 1. 信任边界与时钟

| 事实/时钟 | 权威与用途 | 不可用的用途 |
| --- | --- | --- |
| 原Agent实际spawn返回的child PID、真实私有stderr管道与close事件 | 父Agent给当前execution的因果证明；Python自报PID须等于实际child PID | 不能用PID存在/当前进程列表代替旧child精确close |
| OS出生token、原createdAt、MachineGuid摘要 | 同一机器内的进程身份核对；token精确解析回出生时间，canonical ISO误差至多既有1.001ms | 不与另一机器的lock.createdAt/serverNow比大小，不restamp |
| 原Agent monotonic | 从spawn到ready/close的实际经过时长、230/245秒本地预算；每个记录绑定execution与Agent runtime | 不拿一个进程的monotonic与另一个进程/机器的绝对值比较 |
| 云端monotonic + serverEpochId | 同一服务进程内的授权年龄：原任务领取、120秒核验租约、3秒观察挑战 | 不能跨云端重启恢复其绝对读数 |
| 两机原始wall/ISO | 审计，保留原样；发生跳变可记录，不是授权依据 | 不推算另一机器剩余lease，不证明帧晚于服务器pickedAt |

本协议仍信任已认证的原SYSTEM Agent及其受控实现如实执行spawn/管道/close。云端不能从HTTP独立重演Windows OS事实；新增时间逻辑不能声称防御已完全被管理员篡改的Agent。SYSTEM/父进程路径、固定ADB binary/owner/监听与现有keys/入口守卫完全保留；身份基线变化即停，不把新PID默认为基线。

**时钟源评审门槛：** 不能默认任意`performance.now()`/hrtime都覆盖宿主/VM暂停。后继实现须选已验证包含暂停经过时长的服务器时钟，或在原时钟/运行连续性异常时使当前epoch授权全部fail closed；不确定就不能签发或接受proof。wall跳变本身可使当前授权保守失效，但绝不能让旧挑战复活/续期。该局部时钟守卫只作用于v2企微授权，不改查名/XHS/媒体时钟策略；实际时钟源和暂停反例通过前，合同仍不可实施。

## 2. 版本协商与旧数据

- 新任务仅在Agent明确声明`wecomCleanupProtocol=2`且服务端v2门禁就绪时领取，binding.version为2。不能仅Agent升级后复用v1的版本号和字段含义。
- v1持久义务保持原合同与隔离；v2端点不能接受v1 binding或把缺host补成新进程。旧Agent不领取v2原任务/核验任务，v2 Agent不在没有绑定时走legacy手机分支。
- v1/v2原业务result、sendClaim、原task/job/obligation及核验代次必须分别保留。cleanup成功不将原业务失败改成成功。
- 云端重启后带旧serverEpochId、仍未提交的核验挑战一律失效，保留设备锁。不能把旧monotonic读数当新进程时间。已经**事务提交成功**的同体proof重放可返回持久结果，不需要重新采集或重做业务。
- 未决义务未终结前，旧版不识别的整机锁不能靠只停企微回滚。上线和回退仍须root单独的实际版本/影响评估及授权。

## 3. 原任务host登记与实际close

### 3.1 不变的动作门槛

云端领取事务生成原binding、fresh execution/nonce、独立义务；父Agent接收后只spawn唯一reader。Python仍先完成SYSTEM/父进程/原ADB只读身份守卫，只通过私有管道报告真实host；尚不获取手机UI SDK、不操作手机。父Agent验证self-report PID==child.pid、精确token/ISO、唯一reader、机器身份。只有host登记持久ACK成功且原任务未abort/close/过本地预算，才允许下发含号码的业务配置；配置未知不重放。

不从历史共享管道领养host、添加supervisor或把共享Agent加入退出集。draft.2将**最小启动握手设为必需**：父Agent先持久保存当前execution/原nonce和独立pipeNonce的spawn-may-have-started意图，再spawn全新私有管道的`--physical-ready-v2` child。第一行只含`protocol=2, purpose=physical-bootstrap, originalTaskId, executionId, executionNonce, pipeNonce`，没有手机号、备注、设备业务配置、服务地址或认证凭据。child在完成原SYSTEM/父进程/监听身份守卫后，ready逐字回显该绑定和两个nonce及真实host；父Agent验证全部相等、实际child.pid/精确token，并持久ready记录后才请求云端登记。旧管道、重复ready、旧execution/pipe nonce、错PID/出生token一律EOF/取消并等待真实close，配置不释放。pipeNonce在该execution只用一次，不能因重试新spawn换nonce复活旧业务；原host/body日志缺失不补握手。

### 3.2 时间合同改变

- 服务端接受host须满足：binding完全相等、当前原任务running/未terminal、设备和Agent映射不变、未释放的独立义务、服务器当前原执行授权未过期、同体幂等。移除“OS出生wall晚于云端lock wall”作为因果证据，替换为上述当前execution/私有spawn管道及服务器接收状态。
- v2 host校验保留canonical ISO、精确出生token与同机一致性，严格唯一reader/实际PID；**不再把出生wall未来于服务器wall判为非法**。这不是接纳任意存活PID：实际spawn/PID/私有管道/原nonce守卫由原Agent完成，错PID的配置永不释放。
- close只能由父Agent在同一child真实close事件后产生，同原hosts/机器/execution/runtime，带原始observedAtAudit及从spawn开始的monotonic经过时长，后者不得小于同一执行的ready经过时长。服务端记录自己的closeReceived时刻用于因果序列。审计wall即使回跳也不改变授权先后，不重写OS字段。
- 延迟close可在业务预算后作为清理证据补达；不能因为超过245秒就丢弃真实退出事实，也不能因此延长原业务执行预算/重放配置。无法确认close时仍整机隔离。
- ready/close网络响应未知仅按原不可变body有限重发；非成功ACK不允许手机动作。不得在原任务terminal后重新创建host登记来启动业务；晚到缺失正文的义务保持maintenance。

### 3.3 诊断持久性（拟实现的一部分）

在原Agent持久保存最小生命周期记录，至少包括原task/obligation/execution、实际child PID、原出生token/createdAt/机器摘要、ready接收、host HTTP状态/固定拒绝分支、配置`not_released / may_have_been_released`、真实close及monotonic经过时长。记录受限保存在应用数据中，不含手机号、UI、账号凭据或agentToken，不写Git/普通日志；日志只出固定事件码/原ID及脱敏差值。

配置状态须在写stdin**之前**持久改为`may_have_been_released`，不能在写后才记录。落盘失败即不释放配置。该journal用于保留可审计的原事实，不自动清锁、不允许恢复入口补造host、不替代真实新核验；崩溃窗口和ACL/保留期/原子写失败须在实现前给出精确约定。当前43没有该journal，不补填。

draft.2固定拟采用的存储边界如下，仍须Windows离线文件系统负例验证后才算实现：

- 专用目录`D:\PhoneCloud\agent\data\wecom-physical-v2`，仅原SYSTEM Agent创建。新目录/文件使用受保护DACL：SYSTEM完整访问、Builtin Administrators只读/读权限，其余无允许项；owner=SYSTEM、同卷NTFS、禁止reparse point。已有目录owner/DACL/卷类型或父路径异常则拒绝，不自动改属主/ACL/继承。该新目录权限是后续候选发布的显式范围，不借此修改Agent根目录/既有keys权限。
- 每条严格schema、最多16KiB，文件名只由已校验的executionId生成；最多256条未决、最近64条完整已核验记录，总完整记录上限5MiB，另最多4096条/2MiB的已核验receipt摘要，至少32MiB可用空间。超限/未知文件/权限不可验证/任何写失败，停止新的配置释放，原义务保留。未决记录永不按年龄清理；已核验记录只在exact proof的事务成功ACK已接收、同binding/proofDigest的`cleanup_verified`记录同步持久后，才能将较旧完整副本压缩为receipt摘要并删除重复本地全文。服务器独立义务及完整proof仍保留，不删除云端记录。摘要保留最近4096条，轮转也须原子持久；旧文件只有新摘要持久成功后才能删除。不设“满256条后必须等30天”的吞吐限制，不从未知ACK或业务success推断已核验以腾空间。具体轮转和失败恢复是发布范围中的显式策略，实施前仍须负例与审查。
- 同目录随机临时文件以CREATE_NEW和同一受限安全描述创建，完整写入、文件fsync/FlushFileBuffers成功后，同卷原子替换并请求write-through；原文件替换后再次打开核对内容hash/ACL，任何异常不写手机配置。Windows实现须明确使用的原生API/错误处理与OS保证边界；没有目录fsync等同保证时不声称抗任意断电，只能通过断点/失败恢复证明不确定状态failclosed。不得用无保护继承的普通temp后移动进来。
- 状态顺序为`spawn_may_have_started -> ready_persisted -> host_ack_persisted -> config_may_have_been_released -> child_close_persisted -> cleanup_verified`。每个不可逆前置点同步持久：spawn之前记may-start，host POST之前记真实ready，配置stdin之前记may-release，host-closed POST之前记实际close。HTTP未知ACK不把stage回退。close晚到只补同体清理事件，不延长业务230/245秒或新发配置；超出原report预算保持journal/隔离，后续单机恢复另审。
- 最多16KiB的应用私有record含绑定nonce和真实host证据，属于协议持久状态；不复制agentToken/密码/手机号、原始UI、ADB密钥或环境。普通日志只出原ID/固定事件码/HTTP状态，不能输出record全文。journal重读只供审计和只读核验计划，不自动采纳旧进程或重发邀请。

### 3.4 业务lease也必须去掉跨机wall判定

已核实际代码：`wecom_platform_preview.py:lease_valid`仍用云端`expiresAt > local time.time()+3`；仅修物理cleanup会在手机UI之前/途中继续误拒。现有服务端原业务锁自提交起300秒，`previewLease`要求剩余超过3秒，不能改成只看valid或延长TTL。

v2原业务lease应由服务器同epoch本地时钟计算实际剩余`remainingMs`，同时保留原expiresAt作为审计；同一响应严格绑定原task/设备/slot/备注指纹/操作指纹及serverEpochId。Python在发请求前、收完整响应后各取本进程monotonic，**用服务器返回的剩余时间减去完整RTT**作为接收时可用时间的保守下界，仍须>3000ms才允许该次受保护动作，不用本地wall做减法。返回字段缺失/非有限/负数/大于原300000ms、RTT非法/预算不够/epoch变化均拒绝。核验120秒lease同理，20秒本地预算仍独立存在。RTT不能加回服务器预算，不缓存一次valid代替每次现有守卫。

原send-claim前后两次lease确认、唯一持久claim及未知不重发全部保持；本轮不会用真机验证发送。新v2任务/业务锁的服务器计时源须自原提交/领取的实际起点保存，不从“现在收到一个lease请求”重开300秒或230秒。跨server重启旧授权fail closed/保留义务，不把恢复的ISO当新monotonic起点。

共享`expireWindowsTasks`/`expireAutomationJobs`/`expireDeviceLocks`与启动恢复可能提前终结普通业务锁；必须逐个审查v2分支的保守性及独立义务是否仍阻同机所有入口，不能为本功能全局替换其他业务TTL。即使普通业务终态提前出现，也不能解除独立物理义务、重排原业务或改写邀请结果。固定源码的这些真实函数需反例覆盖，而非只测新纯函数。

## 4. 核验与3秒首项事实年龄

### 4.1 两层服务器授权

1. 原业务terminal且真实原host close已确认后，按既有逻辑创建新核验task/verificationId/nonce（服务器monotonic最多120秒，云端epoch绑定）。保持当前20秒单reader本地执行预算。`issuedAt/expiresAt/pickedAt`原始server wall仅审计，不在Windows用wall计算剩余授权。每次固定IO之前继续检查本地预算、SYSTEM/原ADB身份与原服务器lease；不能缓存一次valid代替所有现有守卫。
2. 所有准备完成后、任何证明帧的首项事实开始前，请求该核验代次的**一次性观察挑战**。建议新增v2专用`POST .../wecom-cleanup/:obligationId/challenge`，原binding/verification三ID及稳定challengeRequestId必须精确匹配。服务器在设备门锁内持久分配挑战，绑定当前serverEpochId、server monotonic签发点，**不得超过既有3秒**。
3. 同challengeRequestId只取回同一挑战；未知ACK或网络慢不重新发挑战刷新期限。本代次最多一个挑战；过期后原核验失败/保留义务，不在同一进程中换nonce无限采集。是否显式创建新的核验代次沿用既有失败不无限循环规则，另由原义务授权，不重发原preview。

### 4.2 挑战响应及proof字段草案

响应固定包含：`ok, challengeId, challengeNonce, serverEpochId, maximumAgeMs=3000, issuedAtAudit`。没有凭据；challenge nonce只在受认证协议状态里传递，不出普通日志。服务器内部持久保存challenge绑定/状态；monotonic签发点仅在本epoch有效。响应回送不延长deadline；连接RTT、Python管道和实际child close都耗在同一窗口内。

proof保留原binding、verificationId/Nonce/TaskId、两帧真实packagesAbsent/两个固定包名/serialForwardCount=0，另带challengeId/nonce/epoch。每帧保留原始wall审计值及同一核验reader monotonic从**挑战响应接收**到该帧**首项事实开始**的经过值；两帧须严格有序，禁止在完成/上传时重盖时间。原host identity与guard复读继续。

服务端接收proof时：原lease仍有效、任务running/当前代次、host已close、映射未变、无占用冲突，challenge精确匹配/未消费/同epoch，且`0 <= serverMonoNow-issuedMono <= 3000`。第一帧实际首项事实发生在挑战签发之后，因此以签发点计龄只会更保守；无需将Windows wall变成云端时间，也不能加RTT补偿或放宽3秒。帧本地elapsed须有限非负、严格有序且<=3000；Python自己在实际close前仍检查首项事实monotonic年龄<=3秒。包/forward任何未知/残留仍拒绝。原始wall跳变不影响该因果链，但审计值保留。

只有上述条件全通过才按既有同事务提交proof、核验success和精确原业务锁/独立义务release。存储失败恢复原pending；未知ACK同体重放提交结果，不能先开门。已经提交的同体重放使用持久proof相等校验，不能因serverEpoch改变而丢失已提交结果。

### 4.3 性能/可行性门槛

这比原“首项事实至接收<=3秒”保守：新增挑战往返及实际child退出耗时也占3秒。**先本地受控延迟、再获准单机实测；若超时就保留pending，不能为了通过加预算、少查一帧/forward/lease、提前在挑战前采帧或跳过guard。** 如生产RTT/读IO使其不可行，合同必须重新评审；当前只是一种完整保守方案，不称原生可用。

## 5. 服务器重启/时钟跳变

- 使用服务器monotonic实施120秒/3秒年龄，wall只审计。服务器进程epoch随机且不可复用，重启的未消费挑战失效；旧mono不迁移。
- 进程不重启但wall前后跳时，授权预算不得延长；经验证的暂停感知时钟可继续计时，否则连续性守卫使该epoch fail closed。OS birth token仍反映原OS事实；不尝试修机器时钟。不能为了提高通过率容忍无法界定的暂停/回退。
- Windows进程崩溃/Agent重载不会证明child已退出；未知journal不能使下一runtime领养旧host。新核验仍须原机器精确token核对真实退出。
- 旧核验lease跨server重启不得复活；明确失败/过期并保留义务，后续恢复只发独立只读核验新代次，不重新邀请。具体状态持久事务及是否需人工授权由实现评审固定，不以restart自动清锁。

### 5.1 同事务、checkpoint与有限代次

- v2的业务lease/核验lease/challenge记录（epoch、原monotonic起点/预算、challengeRequestId/nonce、状态、代次计数）全部归属原独立义务行，与核验windowsTask一起由同物理设备gate序列化。`challenge`签发必须在原事务持久成功后ACK，不另存不受checkpoint保护的可恢复map。服务器全局epoch本身是本进程标识，持久记录只引用它，绝不借持久化旧epoch恢复旧时钟。
- proof提交在同事务里消费challenge、存exact proof、核验success、精确原业务锁release、独立义务release。事务失败还原全部before-image（包括epoch/nonce/challenge状态/代次计数），gate在实际写完成前不开放。checkpoint覆盖层必须同样包含这些嵌套字段及新任务，不得保存半个issued/consumed/released。
- 任何在事务之前捕获的全量checkpoint不能在事务提交后将v2行倒写回旧版本；实现必须证明当前持久化队列/overlay覆盖所有JSON、结构PG、快照PG和双写入口。若现有队列不能保证，应加限定到v2行的修订校验或保持发布阻断，不能假定before-image自然解决所有延迟写。测试须人为延迟checkpoint捕获/数据库提交，交换完成顺序并重启读取最终持久状态。
- 启动时先以新epoch核对所有未终结v2授权，在同gate/事务将旧epoch未提交核验task标为固定`server_epoch_changed`失败并将义务置maintenance；已提交proof结果不回滚。该启动事务未持久成功前，v2业务和核验派发均保持关闭；不拿恢复的ISO重开TTL。其他业务启动流程不因此改写。
- 每义务自动核验代次最多1次，计数与首次核验创建同事务持久；丢请求只复用同一代次。过期、epoch变化、失败或挑战超时不自动新建代次。后续新代次须单独单机维护授权/接口评审，不能让poll/reconcile/重复verify无限换代。draft.2不增加公共自动恢复接口，43旧义务也不在此机制中。

### 5.2 已核源代码入口清单（固定32c，逐入口验证要求）

| 源码入口 | 当前时间判定/副作用 | v2拟处理与必须反例 |
| --- | --- | --- |
| server/index内部preview提交、acquireAutomationDeviceLock | wall创建300秒普通锁；job/task排队 | 同步持久v2服务器授权起点；不得从lease请求续时 |
| server/index设备目录/activeDeviceLockForTask/expireDeviceLocks | 普通锁expiresAt、job/task活动关联；独立义务优先 | 所有入口仍见未决物理整机隔离；普通TTL早过不能放行 |
| server/index tasks/next领取及capability/queued TTL | task.pickedAt wall、创建独立义务；running TTL | v2能力精确匹配；原领取起点计时，持久失败不暴露配置 |
| server/index preview lease路由与send-claim前后 | lock.expiresAt>cloudNow；previewLease要求>cloudNow+3秒 | v2同epoch剩余值和绑定，claim前后同一授权；无邀请重放 |
| server/wecom-preview.previewLease | 单机server wall余量与业务/锁/手机完整匹配 | 保持所有非时间守卫；只替v2授权时间源 |
| Python wecom_platform_preview.lease_valid | expiresAt>本机time.time()+3 | remaining减完整RTT>3000，真实函数±offset/慢响应测试 |
| Node runWecomPreviewTask/createPhysicalLifecycle/sameAcknowledgement | performance.now 230/245秒、wall()close；两次同体ACK | 同进程连续性/实际close/journal；不得晚ACK放配置 |
| server validateWecomHosts/recordWecomHosts/recordWecomHostClosed | OS born与cloud lock/now；close wall先后 | 最小nonce握手+真实spawn身份；接收因果，不跨wall |
| server createWecomVerification/canPick/verify/reconcile/lease | issued/expires/picked wall、120秒与重复代次 | epoch/monotonic、同代次复用、最多1自动代次，重启失败关闭 |
| Node verificationConfig/validateProof | pickedAt/issuedAt/expiresAt wall排序 | v2严格schema/原绑定及本地事实顺序，不能混v1字段 |
| Python cleanup_verify.validate_config/execute/proof_time/lease | cloud expires减wall；proof与cloud picked及本地wall比 | 20秒monotonic、本地连续性、挑战后开始采事实；原wall只审计 |
| Python physical_verify.verify_empty | 首项事实captured_at、两帧、guard、250ms间隔、3秒 | 保持所有事实/检查与时序；真实路径嵌套在挑战接收之后 |
| server validateWecomProof/completeWecomVerification | serverNow-frame<=3秒、frame>picked/close | 一次性保守挑战同epoch<=3000，exact事实及原子消费/release |
| server recoverStalledTasks/启动恢复 | Agent在线wall与stalled TTL，企微recoverable=false | 断线/重新在线不重排原preview；epoch失效保持maintenance |
| server expireWindowsTasks/expireAutomationJobs | generic300秒/排队1800秒/会话TTL，状态同步和普通锁release | 提早终态仍保留物理义务；v2不能被generic重新授权；只改必要专属分支 |
| server wecomCleanup.transaction/checkpoint、saveState和persistTaskMutation | before-image、结构/快照JSON/PG写入与并行checkpoint | clock元数据与proof同事务、延迟旧checkpoint不倒写、存储失败gate不打开 |
| 归档/手动取消/批量取消/用户任务删除入口 | 业务终态/记录保留和lock释放 | 不能丢v2义务/授权计数；旧epoch不复活，另一手机不受误隔离 |

清单来自当前代码只读审查，不代表所有旁路已实现或测试。实现前仍须按实际调用图补遗漏，尤其generic状态同步/checkpoint真实函数，不能只测试新helper。

## 6. 实现范围与必须补齐的评审项

拟动叶子：server/wecom-physical-cleanup.mjs、wecom-cleanup-service.mjs；Agent专用wecom-cleanup-protocol/preview-task/cleanup-verify，Python专用host/contract/cleanup_verify及日志journal。共享server/index只做v2能力/路由/事务绑定，Agent/index仅声明版本及安全诊断接口；由root协调归属，不整份覆盖查名/XHS/共享生命周期。

实现前须回答：server暂停感知时间源/epoch如何注入并在当前persistence失败时回滚；原300秒业务锁、230秒执行与120秒核验lease首次计时及restart如何精确持久状态；业务lease剩余减全RTT及3秒余量、共享expiry各旁路；challenge请求严格schema/同体重放/过期事务；journal实际ACL、原子写/目录权限与保留上限；为何原parent/child握手足以替代跨机birth比较的威胁模型；20秒/3秒真实延迟可行性；v1剩余义务维护与不可直接旧版回滚。未回答前不提交半个“删比较”的产品补丁。

## 7. 代码与验收门禁

- 正负固定offset至少±300ms/±5min，v2在真实事实相同且预算内时结果相同；wall跳变、宿主/VM暂停、epoch变更/monotonic非法/过期不得延长授权，无法确认连续性全部拒绝。原业务300秒/3秒余量和核验120秒/20秒/3秒窗口均覆盖，固定共享expiry真实函数另测。
- 新host真实OS+私有管道、错PID/出生token/机器/nonce、取消、晚ACK、配置未知、落盘失败；真实close前不终态、不释放。
- 原始首项事实/两帧不重盖；挑战前帧、同帧、旧代次、旧challenge、同请求换body、第一次事实过3秒、网络慢、child close慢、残留包/任意目标forward（含媒体）全部保持隔离。
- 服务端真实HTTP和三种PG路径持久化/重启/事务失败、同体未知ACK、普通TTL/归档/并行checkpoint不得开门；原业务result/claim不变，其他手机仍可派发。
- 共享代码如改动须现有投屏回归，D-075真实宿主只读核验仍是发布门槛。无新ADB/身份/keys/入口动作。
- 固定commit/tag/runtime闭包与hash后root单独批准加载，再单台正式preview至发送前/真实close/新核验proof原子释放，随后双机及双开。当前native冻结未解除，不拿本地合同或模型测试冒充真机验收。
