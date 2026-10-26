# rc.5 + 已恢复的流式存储组合候选

用户明确指出只恢复旧业务基线不是要求的新版；本候选继续交付原已授权rc.5全部17云端/4Windows更新，保留已恢复的流式内存修复。生产基线现为platform-oom-recovery-20261026-deployed.1 / 4669b757，不能直接启动旧1ea4b9ef功能镜像回退内存补丁。

功能源码efdd05fe / lookup-ai-coverage-20261025-rc.5；存储e16fc333 / platform-oom-recovery-20261026-rc.2。index机械应用已审查31行存储差异，无冲突，独立组合全量1287通过、check/HTTP smoke通过。Windows4文件完全沿用此前15项Windows专项及既有真机回执，非新一轮生产验收。完整内存验证见存储候选722MB读写/613MB启动退出；生产530MB读取17秒且恢复后无OOM。

发布构建基于已恢复镜像，备份当前数据库与精确文件，保持Compose只有image差异。维护前核对实际业务与控屏、暂停接单派发并保留原队列；只重载云端和原SYSTEM Agent任务。不动ADB/PID20316、SYSTEM、Windows、USB、媒体或宿主机配置。回退到4669b757与原4个Agent文件，绝不能直接回到存在OOM的旧业务镜像或用旧数据库覆盖新结果。维护窗口按当前占用另核。
