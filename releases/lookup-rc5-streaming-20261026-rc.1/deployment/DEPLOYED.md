# 完整rc.5＋内存修复已上线

- 版本：lookup-rc5-streaming-20261026-deployed.1。
- 运行提交：64148f3cfd1793f423a1b9d7097746a6ba79fec1；候选标签lookup-rc5-streaming-20261026-rc.1。
- 功能源efdd05fe；内存源e16fc333。运行与下次启动镜像均sha256:5ab68ecbc67dfd4815f3ec93b0d3dd6265acd6a5d044867c3e04904636e80649。
- 维护已获当前明确授权（包含窗口内新增控屏）。10:49:04维护开始，10:52:18 ready成功，10:52:33恢复接单；无活动业务被取消。
- 核对17云端/4Windows哈希；Agent14540、单实例SYSTEM；ADB20316未变，未调用ADB重建/切身份，未改Windows、USB、媒体或宿主机配置。D-075 live前后相同。
- 外网首页/API文档200；health/ready最终复核200约50/60毫秒。最新取样零重启、无OOM，RSS约984MiB；Agent心跳13秒、122/139设备在线（时点数）。
- 查名配置恢复enabled=true/revision105，48登记/42启用；后续看到1轮5台探测。本次没有主动启动探测、提交业务号码或发送飞书。

## 验证边界与异常

发布前1287项回归、check/HTTP smoke、隔离Postgres启动均通过；Windows四文件沿用已通过的专项和候选真机回执。切换后只读核验不能替代新组合外部API到真机、切号冷却、跨机接续、卡片与通知的完整验收。

Windows第一次执行被PowerShell默认脚本策略阻止，文件尚未执行；仅对这一执行进程设置ExecutionPolicy Bypass后执行已审查脚本，未改机器持久策略或计划任务动作。Agent替换回执独立保存。

旧恢复版停服出现“Cannot use a pool after calling end on the pool”及“shutdown timeout”，旧容器退出码1、OOMKilled=false；不能声称优雅退出成功或全部末尾事件已落库。没有恢复旧数据库或删任何业务数据。新镜像启动阶段历史audit扫描耗时约一分钟，整体ready约两分钟；启动后ready又有短暂超时/HTTP错误，最终复核恢复。该延迟与退出竞态另列待验证项，不在本次未经测试继续热改。

## 回退

使用本阶段已备份恢复镜像4669b757与原4个Windows文件，保留当前数据库、现有SYSTEM计划任务和ADB20316；不能回退到已知OOM的旧镜像或覆盖数据库。当前有用户重新接入和新轮探测，任何后续共享重载需另确认维护窗口。本次未推送Git远端；候选标签不移动，部署记录单独提交与标签。
