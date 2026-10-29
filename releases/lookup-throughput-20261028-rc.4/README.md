# 查名读取器退出后清理核验 rc.4（2026-10-29）

本地候选，未上线、未推送。基于 rc.3 / ba8f4921ee08d9762853b69b54c2c7371c6f95d2，分支 codex/lookup-throughput-accuracy-20261028；旧版本和标签保留。

## 已确认与未确认

- 09:55前后51/52的元素RPC超时，同时普通shell、短信、电量及控屏启动出现失败；库存device不等于命令通道健康。02:05:37Z两台生产短信读取恢复，51后续只读echo为31–47ms。本轮没有重启或切换共享服务。
- 52 Android events/main/system日志显示，09:54:57创建的Poco进程3731在09:56:41、09:58:27仍有内存采样，直到09:59:54才被force-stop。该时段Android其他服务仍在记录日志，没有足够证据判整机死机。09:59:54的“Crash of app ... running instrumentation”紧随force-stop，不能倒推为09:55首次自发崩溃。
- **确认代码漏洞**：exit/error回调删除Windows worker对象之后，stopAirtestWorkerImpl因查不到对象直接返回true；recycle也会跳过停止。这不是手机端instrumentation已消失的证明。
- **仍未确认**：最初为何两个设备命令通道同时停滞。两台位于同一USB控制器下的不同Hub分支只是相关线索；另一控制器下的153也有同期短信失败。Windows有限System事件查询未命中USB/PnP故障，不能据此排除硬件或传输问题。stdin对照也未重现。不能声称本补丁消除了首次命令通道异常。

## 修复边界

仅查名恢复：Windows worker对象已不存在时，也执行既有8秒总预算、精确serial的手机端Poco服务与forward清理核验；无法证明清理完成则不启动接续读取器。recycle在exit已删除对象的竞争时序也执行核验。没有增加业务超时、重输号码、重启支付宝或修改ADB身份/路径/端口。

screen_control、XML、小红书及普通resident/idle停止路径的无worker行为不变，不修改实时投屏代码。清理仅限原有Poco包及精确serial下Poco forward。风险：真实命令不可用时明确阻止接续，不以“成功”掩盖；该补丁不替代调度层后续退避/跨机策略，也不声称覆盖所有并发退出时序。

## 验证

- 真实Agent函数提取回归覆盖：host对象已删除、Android服务仍在/普通命令超时均拒绝新reader；清理确认后仅原task的query_resume、禁止重输；无worker的非查名路径不新增命令。
- 专项51项通过；首次新增测试有run参数顺序错误，修正测试适配后通过，未改产品逻辑来迁就测试。
- server、Windows Agent、screen-client、scripts串行合计1504项通过，0失败；根npm run check通过。
- 本地HTTP+真实Windows脚本仍未完成业务恢复验收，见API_EVIDENCE.json。不能将模拟恢复/账户核验/人工验证页识别计作完整业务通过。

## 真机调查与隔离

本轮使用既有SYSTEM ADB17764与Agent26488，生产文件/池/业务接口/结果不写。只对重新确认空闲的手机取得独立测试控屏租约；控屏租约实际启动视频通道，因此它是测试环境变量，不能据此声称测得纯无视频负载性能。读取、停止与释放均限定自己的serial/租约。释放后51被用户控屏、142被生产任务接走时立即避开，没有抢回；后续再次确认51/52空闲才开始新轮。

测试适配器补充失败时的get-state/shell/exec-out只读诊断，以及逐步清理用时，保留原始错误，清理不确定不能作为成功。该诊断在隔离staging中，不是已上线诊断。共享Agent的常驻worker管理仍不是这个SSH适配器的完整覆盖范围。

## 版本与回退

生产比较基线仍platform-integration-20261028-deployed.1 / baca5721214658b46f24c974c9147490b0bafada / sha256:fca45ec32e72b0787e4375fd6812a5ac97d3aebec4b830b6393b03117554b45e；ACTIVE SHA256 4bb61c39a8a5cd912069ed494d84dba1af4cf3cc37adbac8285db935586b995a。本轮没有发布，没有生产回退操作。

完整候选包含此前rc.3；未来若批准发布，须按实际ACTIVE重新备份、核对配套Agent文件和维护范围，不能只覆盖入口遗漏此前模块。回退到rc.3时按版本管理恢复本轮入口改动；不移动旧标签、不改生产数据。最初命令通道根因、真机业务超时到结果/去重/结束、实际吞吐仍未验收完成，不具备“所有问题已解决”的结论。
