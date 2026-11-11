# 43正式预览失败：时间域与后续修复边界

状态：调查/设计建议，**不是已实现或已发布的修复方案**。延续主文档v1独立物理义务、原ID对账与首项事实3秒计龄；建议后继协议替换跨机器绝对时间的因果判定，不能临时删一个比较绕过门禁。

## 已证实与未证实

15:04:07.882至15:04:08.762（北京时间）43/main正式预览失败，code=`wecom_cleanup_host_unconfirmed`。只新建1个job，同键重放返回200、reused=true、原jobId。没有调用真实发送入口或claim。独立义务处于awaiting_host，hosts未登记、无close、无verify。原remarkSaveStatus=unknown不改写。

15:08:58只读进程中无企微preview/verify子进程，Agent19756和共享ADB基线不变。已发布wrapper只在实际child close后结束这条错误路径，且host登记ACK成功前不下发UI配置。因此支持“本轮reader已退出、UI配置未释放”的容量交棒判断；不支持物理proof或解除43保护锁。精确原child PID、creationToken、ready正文及登记HTTP状态没被持久记录，既有进程创建事件不可查询，不能追补。Agent固定日志保留原错误码；直连应用请求在已查Nginx有界日志中无记录，不虚填HTTP409。

15:06只读时钟测量：Windows相对本机在[-421,-156]ms，云端相对本机在[16,90]ms；这些是包含往返延迟的界，不是精确offset，也不证明失败当刻offset恒定。生产唯一根因仍待精确原请求证据。当前实现的跨时钟假阴性已由本地6项反例复现，包括真实本地Python child/HTTP409/实际close/未下发配置；它们不是Windows SYSTEM或真机验收。

## 必须一起处理的时间边界

| 当前路径 | 时间来源 | 问题 |
| --- | --- | --- |
| host.createdAt >= lock.createdAt 且 <= serverNow | Windows OS出生时间 vs 云端 | 几百毫秒时差即可拒绝合法新child |
| host-closed.observedAt <= serverNow | Windows vs 云端 | Windows快钟仍会卡close |
| proof首帧 > verification.pickedAt | Windows首项事实 vs 云端领取 | Windows慢钟仍会卡proof |
| frame <= serverNow 且 serverNow-frame <= 3s | Windows vs 云端 | 正负offset均可误拒绝或错误计龄 |
| Python验证预算/lease.expiresAt | 本地wall vs 云端期限 | 不能用本机wall直接推导云端剩余授权时间 |

精确creationToken与OS create_time比对是同一机器上的进程身份校验，必须保留；不能把真实host时间重写成云端now。现有nonce/任务/设备/slot/agent/机器绑定、原任务终态、真实close、双帧包不存在及目标serial所有forward=0也必须保留。

## 建议后继协议（待评审，不修改v1线上合同）

1. **明确两种时间。** OS出生时间和原始观察wall只作不可变审计及同机身份核对；云端同一时钟的领取/接收/到期时间负责授权。预算用各进程monotonic，不修改系统时间/NTP，不扩大230/245秒、20秒、120秒或3秒边界。
2. **任务因果与真实child绑定。** 由已认证任务中的不可重用启动nonce，以及原Agent实际spawn的唯一child PID/出生token建立ready因果。若引入启动握手，只传无手机号/凭据的绑定，手机操作配置仍在持久host ACK后才释放；SYSTEM/父进程/路径/listener校验继续。服务端必须使用任务running/原execution/新nonce和服务端接收顺序，不以两台机器的wall大小证明先后。不能接受任意已存在PID或把Agent当退出集。
3. **首项事实新鲜度的保守挑战。** 可评审由云端在已确认原host close且verify已领取后发一个一次性观察挑战，挑战绑定原义务、核验代次、task、nonce，云端签发到接收proof不得超过现有3秒。reader收到挑战后才采两帧；原始wall不重写，本地monotonic记录实际首项事实和帧间先后。由于挑战先于首项事实，接收deadline若成立，首项事实只会更年轻；网络/子进程close耗时计入同一预算，不能续期来让旧事实过关。该思路尚需实际延迟可行性、重启/时钟跳变、nonce持久化、未知ACK同体重放测试，不能直接当作已通过设计。
4. **拒绝也需可审计。** 在原Agent持久留最小安全生命周期事件：原task/obligation、实际child PID、原始出生token/机器摘要、ready收到、配置是否已释放、host登记HTTP状态与固定拒绝码、实际close；禁止原始UI/手机号/凭据。落盘失败必须保持保护，不能靠补造旧host恢复。仅补诊断不能宣称已修时间协议。
5. **43旧义务单独处理。** 当前原host正文已丢失，不得自动迁移补齐、restamp、重排preview或删除锁。后继协议不能默认消除它。需另行评审有明确真实证据、只针对43且不影响其他手机的维护核验入口及授权，或继续隔离。原业务失败永久保留；缺少可验证证据就不能宣称已清理。

## 后续验收门槛

- 本地真实HTTP+OS管道覆盖正负offset、时间跳变、过期/旧代次/晚到ACK、持久化失败、close未证、残留包/forward、同键重放、错误child与另一手机继续运行。
- 固定源码和运行包hash，再经批准加载；不能在生产热改首关或新增SYSTEM启动入口试错。
- 单台正式preview完整走至发送前，再核对真实close、全新验证双帧、持久原子释放；然后两台串行/并发兼容及其余空闲合格手机。155/157等启用查名池手机仍排除，其他占用实时重核。
- 对外POST目前是实际发送语义；本轮明确只用内部preview。不得为了“外部API全流程”调用会真实发邀请的入口。

本轮可以交付的是原始失败回执、本地可复现反例和修复评审边界；完整真机验收仍未完成。
