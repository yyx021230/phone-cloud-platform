# 六条旧查询收尾复核｜2026-10-30

按用户在协调窗口的直接指令，放弃原6条卡住查询，让手机继续调度。“查名字”窗口作为唯一执行owner，先53验证，再逐台通过现有单条管理取消API执行；根窗口没有并行写生产。

09:37完成逐台复核：53、57、67、101、112、161原请求均cancelled/lookup_cancelled，旧query任务cancelled且deliveryAttempts仍1，原session ended，原channel全部释放。每台真实stop succeeded，proof的taskId/sessionId/generation均与固定的原绑定吻合，未重查旧号码。

09:37:29–31自然调度观察：53/57/67/101已有不同requestId/session/generation的新准备通道；112/161当时无通道、基础health可用。新准备不是新业务结果已通过。永久runtime-loss恢复、154错误XML降级等问题没有因这次收尾被标记解决。

[REVIEW.json](REVIEW.json)保存原ID、stop证明、operator不可变回执来源及逐项比对。本地取消/结果竞争/错代次/迟到证明测试52通过、0失败；测试使用临时JSON和模拟执行器，不连接生产。根窗口只核对本机回执，不冒称独立再次真机执行。

来源commit5f83a295bfda626694664802c76ece1ada8cb445、tag lookup-six-cancel-20261030-applied.1。根复核分支codex/lookup-cancel-six-20261030，独立annotated证据标签lookup-six-cancel-20261030-reviewed.1；未推送、未发布新运行代码。不得将取消的原请求恢复成running或用旧整池快照覆盖当前任务。
