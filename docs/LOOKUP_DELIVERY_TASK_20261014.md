# 查名接口交付任务卡

- 目标：合作方仅提交手机号、保存ID并逐条读取姓名；2分钟后换键不重复，一台受阻不堵其他台。修复161冷启动触限与162人工完成未接续，交付可复现API资料。
- 工作区：独立版本worktree，分支codex/lookup-delivery-20261014，起始HEAD 7b2d2d23c0f9f45ab97baa8f92a8ae34af95607a；开始clean。原根仓236既有项不动。本轮27候选覆盖文件和文档，未推送。
- 规则：完整主文档及AGENTS已阅读；共同流程2026-09-30，SHA256 0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b。D-075与投屏冻结继续。
- R2：查名账户/调度/查询持久态；若生产重新加载共享Agent/业务容器则有活动控制中断风险，须窄维护窗口。无数据库迁移；API字段/鉴权不变，新旧Agent错误类型兼容。
- 授权：本地修复/提交/tag已授权；真实测试161/162、原表已授权号码已授权；其他手机使用不可中断，共享服务重载尚未授权。用户已经完成162拼图，不再重复要求完成同一挑战。
- 验证：临时目录 /tmp/pc-lookup-delivery-20261014/runtime，npm run check；npm run test:screen720；Python unittest discover340；sdk-transport Node6/Python9；partner-example5；isolated managed HTTP/PG及独立下载包121秒测试。详细命令对应候选verification/RESULTS.json日志hash。此前失败及修正如实保留。
- 审查：自审生产基线diff、身份/焦点/两帧守卫、ACK先于切号、未知不重放、单设备观测及既有控制hash；无独立审查。模拟5路不是5真机，尚不能宣称完整生产验收。
- 生产事实：两个老Python热补已上线；本候选未上线。162原查询仍受旧观察器限制；18:16实际search_ready报告被旧Agent新unknown覆盖。两机现场与配置收尾以单独生产回执为准。
- 回退：固定旧云镜像及ACTIVE/Compose、Windows变更文件备份；不回滚任务/结果/别名/冷却，不重启ADB/USB/Windows/媒体。发布前后真实宿主机D-075 live；任何失败停止扩容，不自动全局恢复。
- 下一步：完整候选提交/tag、构建隔离验包与备份；取得具体维护窗口后加载云端和Agent，仅161/162灰度，逐条记录原任务与结果，再决定开放合作方测试。
