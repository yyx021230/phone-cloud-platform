# 组合版准备完成，尚未切换

源码 64148f3cfd1793f423a1b9d7097746a6ba79fec1，功能 efdd05fe，存储 e16fc333。镜像 sha256:5ab68ecbc67dfd4815f3ec93b0d3dd6265acd6a5d044867c3e04904636e80649，基于已恢复4669b757，17云端/4Windows。1287回归、check、HTTP smoke及生产模式隔离PG启动通过；最新数据库备份、当前运行文件与镜像回退点已核对。

当前6路控屏142/181/155/60/154/118，查名活动轮次/队列/任务均0；本次中断窗口待用户确认，尚未pause或stop。平台仍是10:20恢复版，不把它写成rc.5。

回退保留当前数据库：云端使用本阶段rollback/ACTIVE_PLATFORM_RELEASE.json所列Compose链（镜像4669b757），不追加组合compose.pending；Windows用D:\PhoneCloud\staging\lookup-ai-coverage-20261026-rc5\rollback的四个文件，经哈希核对后在原SYSTEM Agent任务停止时恢复，再用同一计划任务启动。ADB PID20316不变；禁止回退到已知OOM的c10e071b或4b70c53b，不恢复旧数据库覆盖新结果。
