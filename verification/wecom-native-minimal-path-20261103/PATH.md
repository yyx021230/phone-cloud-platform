# 回到主号/分身发送前验收：最短路径只读核对

用户目标始终是空闲手机真实完整预览，停在发送邀请前，不影响查名/在用手机。root bed2a7f后明确暂停通用progress adapter/DDL/runner扩展；保留所有已提交候选。本报告仅本地源码/Git/既有日志，**没有新的线上、Windows、ADB、SDK、设置或手机动作**。旧快照不能当当前空闲证明。

## 现有可运行版本与生产差异

最后已核生产业务源32c0091a534aa7f9038deb91aa33f202f72e0e6b / platform-integration-20261102-rc.1，正式部署platform-integration-20261102-deployed.1。11月2日17:50–17:53只读ACTIVE SHA a5390dcc…、Windows7文件和云端4文件hash仍匹配32c。此次本地逐Git blob核20个发布WeCom Agent运行叶、共享Agent index和5个server运行文件，**26/26运行文件仍与32c相同**，不是新v2可加载补丁。精确完整SHA见SOURCE_AND_EVIDENCE.json。

public/wecom-integration-api.md有先前da8a2c1已提交的发布状态/发送前边界说明，local d4d271dd…、32c/旧线上226c4d47…，未上线；保留这处既有差异，不整仓覆盖。初次将该文档混入全部相等断言时停止，核明后运行文件继续严格比较，无改文件凑通过。新v2 claim/policy/存储/encoder尚未import生产入口，仅是独立候选和验证。

## 上次真机到底停在哪里

|槽位|已留证据|不能推导|
|---|---|---|
|43/main，11月2日正式内部preview|job7b993763-6364-40fb-9599-2af3bb8d9da3，taskd633cc58-318e-41eb-be22-0f300d0c90ee；15:04:07.882创建，08.762 host_unconfirmed失败。wrapper在host ACK前不释放UI配置；零邀请/零send claim，remarkSaveStatus=unknown|未到新版本页面流程，不能称查号/备注失败根因已明；不能换requestId重查或造原host|
|155/clone999，10月28日隔离测试桥|旧7f32118/rc.2同哈希执行器71.063秒到发送前，一次搜索，备注不需保存，0发送，自建Poco/10080/10081清理；RESULTS明确isolatedAdapterPhonesPassed25/155、productionApiRealPhoneAcceptance=false|不是32c新SYSTEM/host协议/API派发验收；155/main也没有相应真实通过证据|
|25/main，10月28日隔离测试桥|同旧候选61.657秒到发送前，同样0发送/自有清理；含精确MIUI及前Poco冷启动兼容|不能核销新版本25完整API验收|

43物理义务52ea12f0-21b9-4c95-898d-757e2f066c47仍awaiting_host、hosts空、无hostClosed/verify/proof。原ready正文/PID/token/HTTP状态没保存，不能重建。后续看到当前child0只支持该次reader退出旁证，**不是手机包/forward物理证明**。43继续单机隔离；不要求先清43才能考虑别的独立空闲手机。

## 手机、槽位与占用（仅旧快照）

11月2日17:50:57缓存目录：23/25/59/93/145 main当时空闲且非启用查名池；43维护排除；155/157在启用查名池排除。唯一已配置clone是155→Android user999（main0也配置），不猜其他手机分身映射。目录available/接口余量2既不是现在的空闲，也不是共享reader容量。

147/52是查名owner原执行/清理未闭合范围，继续排除且不取消/代管；155/157不要只看busy=false就抢占。分身最短安排须查名owner确认155原执行/reader/待回写/清理都结束，并有可靠单机预约防下一条派入；若现有门禁无法可靠协调，等待自然空闲或另由人类提供已配置独立分身。不得私改池、强停任务、清锁或新增Android槽位来满足测试。

## 必需防线与可延期部分

**本次必需**：新鲜生产版本/Agent/ADB固定身份与唯一监听；实际父Agent/本次spawn PID+出生token+绑定握手；全物理设备独占覆盖查名/控屏/其他任务；mode=preview、完整手机号核对、一次输入/搜索/保存及未知不重放；230/210秒预算、300秒原lease/3秒余量；真实child close后对本次单机Poco/forward双帧证明，未知仍隔离。这些不能为快测删掉或伪造。

**可延期**：通用C2 ProgressHead/Receipt/完整后继catalog、一般raw JSON parser与跨语言指纹产品化、通用outbox/对端送达、全池规模化恢复与长期测试。它们不作为一次已独占的发送前预览的统一前置，不删除已有候选，也不宣称生产已具备这些能力。

## 优先已有standalone真实预约路径，区分脚本和正式API

代码已存在`wecom_standalone_preview.py`→真实`ScreenAuthority`→`run_host(authority=...)`通道，明确mode preview/previewOnly，独立配置走stdin、不伪装生产Agent/task。`ScreenAuthority`每次检查实际SYSTEM Agent/ADB路径+出生/5037唯一、设备scan cache与真实screen session/lock/owner/lookupExcluded；loopback broker nonce/代次/完整操作指纹和RTT/3秒证明，已否决代次不可恢复。它可作为**核心脚本真机验收**的更短路径，不把无physicalCleanup字段当成绕过已有义务；43/任何unknown仍必须排除。它不能算正式API→SYSTEM Agent新host协议全链路通过，也未证明standalone worker本身为SYSTEM。

`scripts/qa/wecom_candidate_live.py`已有真实screen POST/WS keeper、固定source导出、one-shot host、scope绑定cleanup-only代次及本地pending-obligation原件。但本次读到三个必须先审的缺口：

- 当前harness白名单只23/25/43/59/93/145，appSlot写死main/user0；155/clone未接此通道。生产映射已有999，不需改设备配置，但harness若扩clone需最小本地测试与新固定候选，不能套main值。
- `wecom_cloud_reader.mjs`只投影status=active锁，未单列cleanup_pending物理义务/worker/outbox/stop barrier。此读取不足以证明该机全物理空闲，不能把empty locks当无需清理。root要从完整只读源补足，不能过滤掉未知义务。
- failure路径保持keeper+broker循环并写本地pending-obligation；正常physical_safe才释放。源码只证明**进程存活时**保活；screen registry在服务启动会释放旧锁，尚无已验证的跨keeper/宿主/服务重启持久全入口隔离。不能把本地文件或活WS当持久清理义务证明。优先审最小真实QA预约/未知义务保护，不借“core script测试”制造无持久隔离的新未知占用。

旧QA SSH参数只有BatchMode，若复用时socket丢失仍可能尝试新连接；本轮不运行该启动器。将来运行必须只走已确认master、无fallback/新登录，凭据不入参数、日志或文件。此次默认旧cloud master `/private/tmp/pc-wecom-diag-cloud-20261102.sock`不存在；只有已知Windows master，未使用。没有当前cloud凭据/连接的安全只读通道，本报告**全部fresh占用未知**，未登录fallback、未发GET或租约。root可沿自己的存活通道补新鲜全占用。

后续补核的严格只读边界：server/index.mjs:1080 的GET `/api/v1/device-locks`会调用expireDeviceLocks并mark运行保存，**不是纯只读**；还只返回前300条、无完整性标记。两条旧QA reader都调用它，不能直接用于本轮“只读完整占用”调查。必须另选已核不维护的canonical/cache来源或另审纯投影；不能因为method=GET就绕过不改生产数据的范围。此发现来自本地源码，本轮未实际调用该端点，也不倒改旧请求证据。

## 当前硬阻塞与最小动作（由root协调，不是执行授权）

1. **共享执行基线**：旧ADB8148消失、11月2日17:52只读27912/SYSTEM/固定路径/5037唯一，Agent19756/SYSTEM/固定Node。新PID来源未知仍留调查，但不应靠重建/切身份来“修”。root先新鲜只读核路径/owner/出生/监听唯一、实际Agent入口/reader预算，核所选实际执行通道的连续guard与cleanup来源。root补充已确认：生产preview用raw socket/既有AndroidRpcClient、adb_identity主要是LISTEN PID/preconnect比较，SystemRuntimeGuard有SID/path/create_time/LISTEN；**单补baseline批准并不足以证明整个执行安全**。本owner不运行会隐式start-server的客户端、不另开SYSTEM入口。旧故障初因与当前guard完整性分开调查。
2. **正式API v1跨机wall门禁**：server/wecom-physical-cleanup.mjs:47–77把Windows createdAt/observedAt与云端now/lock.createdAt比较，:131跨机计3秒proof；platform_preview.py:154–174又以Windows time.time比较云端lease expiresAt。43失败准确来源未知，但±300ms本地反例证实新child可被误拒。只改登记首关、重盖时间、延预算或改系统时钟都不是完整修复。若走正式API，root需先确定最小完整同次spawn因果/lease/close/proof门禁修复与证据；若先走已有真实standalone authority，仍须上述持久隔离/guard合格且不宣称API通过，不把整个v2 issuer/C2列作core script通道统一前置。现有v2真实部署clock/issuer profile未建立，纯模型/Administrator样本/SYSTEM只读stdio smoke不能当原生执行许可。
3. **清理证明与单机预约**：43缺原host保持排除；对新候选只需证明它本身无在途reader/未知义务并取得既有真实独占，不先解决全池历史问题。完整预览结束必须看到本次原host close与真实包/forward proof；无法验证就保留此机占用，不借业务ready解除。确认共享预算至少能容纳新增1个reader，先一台、完成清理后再下一槽位。

## 最短可执行顺序

root取得新鲜全占用/共享baseline→优先审已有standalone真实ScreenAuthority+keeper通道与最小持久未决隔离，缺口先本地修→从当时真空闲main（旧候选23或59，不能直接当空闲）只做一条core script预览、固定尾6441与原执行ID→实际页面/备注/ready_before_send→原host退出和scope cleanup证明→释放自有预约；再审最小clone harness后同样安排155/999，始终由查名owner协调不抢池。正式API验收另补上述v1门禁最小修复/加载后走原请求观察，不拿core脚本通过冒充API。需重载Agent的具体补丁另告影响。任何新不明义务只隔离该机，不继续堆积未知任务。

外部POST `/api/v1/wecom/customer-invitations` **会发送**，不能拿它测发送前。现有内部POST `/api/v1/user/automation/wecom-preview-tasks` 才是本轮入口；外部预览能力缺口另案，不为完成外部三接口验收真发人。是否需要另开对外preview由产品需求单独决定。当前本报告未执行其中任何一步，主号/分身真机验收仍未完成。
