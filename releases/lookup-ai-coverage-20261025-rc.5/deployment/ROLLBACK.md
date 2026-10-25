# 组合版回滚

上一版为c10e071b，原ACTIVE及Compose链在云端staging/lookup-ai-coverage-20261026-rc5/rollback保存；运行文件与主机旧源码分开备份。Windows四个原文件按WINDOWS_PLAN.before校验，位于D:\PhoneCloud\staging\lookup-ai-coverage-20261026-rc5\rollback。

无数据库结构迁移。回滚保留发布后新订单、冷却和幂等记录，不能整库恢复旧备份覆盖新数据。当前新prepare别名包含创建/到期元数据，旧代码兼容读取但旧1000上限/换key重探问题会恢复，须告知对接方复用原准备键；不清理业务数据规避。

若候选启动/健康/哈希或SYSTEM核验失败：维持查名暂停，等无手机执行，恢复Windows4原文件并用原SYSTEM任务启动；使用ACTIVE.before中原Compose链执行phone-cloud单服务up，确保镜像仍为c10e071b。检查前后ADB20316不变、D-075 live通过，再恢复原enabled值。Windows激活脚本提供失败恢复原文件分支，云端失败后不自动扩大操作。

回滚只在获准维护窗口内操作共享服务；超出窗口或影响范围先告知。禁止重建ADB、改身份/密钥/驱动/USB/Windows/媒体来兜底。尚未正式发布，当前无回滚动作。
