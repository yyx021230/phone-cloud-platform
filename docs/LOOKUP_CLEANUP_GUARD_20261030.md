# 查名清理栅栏候选与48台复发分析（2026-10-30）

状态：本地候选，未部署、未进行新版本真机验收。本次延续主文档2026-10-30错误XML降级调查、停止proof和原ID合同，不替换ADB/SYSTEM、D-075或投屏冻结。分支 codex/lookup-cleanup-guard-20261030，起点2c23ba1bde5797a8ce73b68894fb52cc7ab34a2e，起步工作区干净。共同流程2026-09-30 SHA256 0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b。

## 事实与界限

- 当前生产业务来源仍3a266d71ba861f8e81d6ec3a173d7efc12d5b245、platform-integration-20261029-deployed.1。此次只读采样的6个既有运行文件SHA256与本地起点一致，新helper在线上不存在；逐文件基线见候选manifest，不将起点HEAD或0.1.0作为生产版本。
- 09:52:39 CST核对Agent22668/SYSTEM、ADB17764/SYSTEM及原二进制路径。Agent实际reader上限12；云端09:37:46配置revision141目标15。容量上报单向，未自动协商应用。此次未调整配置或身份。
- 09:24成功释放的是旧51/52/54通道；09:35后再次卡住的是新session/generation。10:14:58 CST三台仍stopping、stopRetryCount=2，均readiness_probe；原六条已取消业务没有被重新查询。
- Windows对应停止日志显示首轮等待Python退出5秒后SIGTERM，手机Poco absence命令失败，三台总耗时约9.04/9.13/9.05秒；两次无host重试约4.03秒后失败。旧代码吞掉具体阶段，不能据此确认HANS、驱动、USB或ADB server故障。
- 09:59/10:04在先核对原SYSTEM server/原session不变后，分别通过既有5037 socket只读pidof两包与目标forward：51/52两包均报告absence，forward为0。两个时间点并非原子快照，不是Agent stop ACK，不能释放云端预约。首次本地结果解码使用错误codec导致未保存，修正后仅重取一次，以保存结果为准。

## 全48台，避免只盯51/52

09:50基础就绪40台、冷却5、投屏2、离线1；这不等于40台业务健康。10:14:58的新快照如下，各层是不同统计口径，不能相加：

| 层 | 分布 |
| --- | --- |
| physical基础 | ready37，accounts_cooling7，screen_control_active3，device_or_agent_offline1 |
| lookup health | ready12，accounts_cooling7，account_login_required5，preparation_backoff3，page_preparation_backoff11，lookup_device_unavailable9，preparation_failed_round1 |
| 15个channel | stopping3，human4，querying5，idle1，starting2 |

querying没有据此认定都是真实业务；readiness proof、准备成功和新业务姓名成功分别记账。完整脱敏48行见候选STATE_MATRIX_1014.json（移除账号、设备序列号和查询身份，只保留设备编号/状态/原代次）。

新自然失败还包括147的postinput visual_after ReadTimeout（两次resume/三次rebuild）、138 TransportDisconnected、146 old_worker_exit_unconfirmed、172 screencap timeout、188页面HTTP、192 bootstrap、142 picker。当前候选只封住清理未确认后的危险后继及补证据，不宣称这些原始错误、登录/页面恢复、AI契约或全池吞吐已修。

## 已确认源码缺陷及最小修改

1. 清理/旧worker退出/forward未确认曾可进入XML fallback，或被app-recovery及query_resume wrapper覆盖。新增精确5种执行器marker识别，仅解3种既有wrapper最多3层；在实际task入口、恢复后、fallback和page-restart策略统一阻止。code-only错误先规范成marker；取消/投屏优先保持原语义。
2. 两处cold-start重试忽略stop false/throw；共享ready-timeout对查名也吞掉失败；旧protocol0自动换账号会在停止未确认后进入XML。要求stop返回严格true，且重建/切换前再次检查取消和投屏。其他workflow保留原ready-timeout行为，托管protocol1不走legacy换号。
3. 云端adapter过去对已匹配的清理失败仍canResume=true，新Agent单独加载不安全。新cloud识别清理标记，canResume=false，并归device域；同任务仍由既有停止proof/物理预约/交接状态机收尾，不直接删锁或补写结果。
4. 无host的清理重试过去先重复force-stop。现在仅查名无host路径先取得两包严格absence；已明确absence可省去该包force-stop，读失败不当absence，仍走原停止和fresh absence，最后只清本serial的Poco forward再验证。默认有host/其他工作流不改，总8秒/每命令2秒预算不放宽。
5. 清理错误增加有限stage/component/outcome到Windows日志，保留原error和bool返回。不是UI/API分阶段stop proof，也不是对原始pidof失败根因的结论。

## 验证与未验

真实task函数、账户wrapper、runTask、compactor、JSON、server sanitize和公开job结果边界均有合成回归；反例覆盖false/throw、code-only、各wrapper、旧worker/forward、取消、投屏优先、managed/legacy隔离。实际server adapter→managed service用例验证不resume与无proof保留预约。生命周期验证两包/forward和deadline、只读失败不能当absence、非查名行为不变。

最终root npm run check通过，npm run test:screen 1769/1769通过、0失败/跳过，运行源码在最终测试前后SHA256一致；命令/源码稳定校验见候选TEST_RESULTS.json与原始日志。首次全套因缺少@yume-chan/adb依赖3项失败，接入已有本地依赖后重跑；另有本地夹具依赖/断言/导入修正，不能把失败记录删除或当生产失败。Node v25.9.0，测试环境不传生产凭据；没有真机、模型调用或生产数据变更。未运行PG全平台烟测、Python全量回归、新版本单/双设备或全48真机验收。

33个冻结文件与起点逐字节一致；Agent index只修改taskAlipayNameLookup、runXhsAirtestPocoWorker、stopAirtestWorkerImpl三个函数及helper import。共享函数对非lookup路径的行为有回归；冻结文件hash及现有投屏回归只证明本地行为边界，不代替生产投屏验收。

## 后续发布与回退限制

本轮R2本地候选；生产加载、真实stop和手机操作为R3，须按共同流程绑定具体已提交版本/目标/窗口/预算。既有维护或三台单次收尾授权不是本候选新部署授权。

- 云端清理分类/canResume栅栏须先于或配套新Agent。不得新Agent配旧cloud。回退Agent时先保留cloud栅栏，再按批准的兼容矩阵处理，不能把清理失败恢复为可resume。
- 本候选不含企微compactor候选3082c0e，双方修改同index文件；未来组合必须按源码最小合并、重新验证，不能整文件覆盖对方。
- 旧51/52/54 retry2不会因为加载新verifier自动重试。真实恢复须重新取当前session/generation/锁/在途任务，获得本轮明确范围后只追加有界停止证明，按原ID核对后让原状态机释放；不重放查询，不直接清库/清锁。
- Agent重载前必须核对并排空/保护已输入的在途业务及outbox。09:21快速重载造成的六条未接续已证明，不能重复假设快速重载无损。运行时丢失与TTL重排永久缺口不在本候选内，原六条已取消不可重开。
- 单设备、双设备到全量按步骤观察；没有多实例/逐设备代码加载机制时，不把全局Agent重载称为单设备发布。只读成功或health200均不能算姓名成功/停止proof。
- 不修改ADB、SYSTEM、keys/启动、媒体或投屏。D-075媒体宿主发布仍须实际live前后核验，repository-only不算生产核验。
- 发布前重新核对实际7文件hash、上版不可变包/镜像、当前维护gate是否存在且真正生效。若需要入口门禁，沿用受限nginx隔离工具，不使用root nginx -t/-T，不假设旧flag有效。

## 观察接续

与查名字窗口联合自然观察，root负责候选源码，peer只读复审和线上证据。后台观察automation-2曾显示暂停，后续本地配置路径不可达；未得到用户恢复答复，不能宣称后台轮询正在运行。前台观察按实际快照时间记录。持久检查点位于用户本地observations目录，不写凭据、账号、手机号码或截图内容。
