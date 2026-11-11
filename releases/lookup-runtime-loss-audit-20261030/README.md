# 快速Agent重载后六条查名业务未接续｜2026-10-30

09:27对账确认53/57/67/101/112/161六条canonical业务请求、任务与会话仍running，归档无结果、outbox无对应记录、新runtime不执行旧六任务；最后事件均为重载前submit_search。短重载没有触发90秒离线，现有恢复只判断Agent在线状态，不按runtime变化接管。

[REPORT.json](REPORT.json)保存六条原ID/代次/期限与同窗口不可变回执来源。[诊断脚本](verify-runtime-loss.mjs)从实际server源码提取两个期限/恢复函数和activity辅助函数，仅以合成状态和时钟执行：

    node releases/lookup-runtime-loss-audit-20261030/verify-runtime-loss.mjs

本地复现running → 35分钟无活动后stalled → 下一轮Agent在线恢复queued；现有managed delivery函数可再给同task租约并ACK回running，type仍query、没有只读resume标记。因此约09:56的TTL不是安全终止或成功恢复点。没有调用完整next路由、协调者或Agent，没有证明生产已经重复输入；实际其他栅栏/取消/容量与时序仍可能影响派发。

业务总期限约10:18:30—10:19:00，不以等待期限代替恢复。后续应显式处理执行runtime丢失，围绕原lookupId/queryId/代次、迟到执行栅栏、真实清理和只读续取验证；不直接重提已搜索号码。51/52/54已通过真实proof释放与此为独立事实，154错误XML兜底仍未修。

本地证据标签lookup-runtime-loss-audit-20261030.1。无运行源码修改、推送、上线、生产或手机操作；脚本通过只是故障路径复现，不是修复通过。

补充容量复现：新runtime报告0个pinned时，6个旧running任务仍计6个reader claim；再有6个新pinned后12预算满。该保守预约保护未知旧执行，不能仅为提高吞吐直接扣除；需要真实清理及代次闭合。
