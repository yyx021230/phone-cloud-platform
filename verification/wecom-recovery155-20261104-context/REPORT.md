# 155 pending上下文历史窗口修复（本地，未追加上线）

基线：刚上线wecom-recovery155-20261104-deployed.1，运行源码462eaf3，镜像aba0ddc3；部署回执提交b0be5e1，ACTIVE绑定后SHA256 9afc29aee37eec07c4049cea3c9c776926d7b01c830b314deca0e3e25c705648。本轮开始工作区干净，已有提交及生产回执保留。

现场：155原job/task分别有5311/5343条更新记录排在前面，数据库四条原件完全未变、离线严格提案校验成功；在线GET409。生产启动只加载最新5000条task/job，单独pending义务载入却缺关联上下文。没有POST恢复或删锁；服务及查名已恢复。

修复：只按未released的WeCom物理义务提取原task/job/普通lock、普通验证task及维护验证task ID。启动执行最多三组有界、参数化主键ANY查询（各5秒超时），原有5000 pending上限不变；数据库原件优先，缺失记录不伪造。日常pruneState对这些精确引用保留，不改变其他lookup/XHS历史策略；义务released后自动恢复正常裁剪。3个cloud运行文件，无Agent、控制、查名调度、媒体、配置、schema或依赖变更。

验证：定向57项通过；扩大企微/查名/仓储/维护回归541项，539通过、0失败、2个独立PG条件跳过；这两项在独立回环临时Postgres真实执行2/2通过，fixture已停止/删除。真实PG放入5005条更新记录，原task/job/ordinary lock仍被正确补载，严格恢复提案与原件一致、所有原数据逐字段保持。实际pruneState验证数量+年代双重裁剪、释放后恢复默认、无关查名记录仍按原规则裁剪。root check与platform smoke通过。首轮新VM测试遗漏maintainTaskHistory依赖，补齐测试上下文后通过；一次shell glob无匹配未启动回归，改用实际文件清单执行后成功，不改产品超时/断言。未重新重复test:all；已发布rc.1完整测试回执保留。

仍未验：155原生SYSTEM只读worker、3秒challenge真实耗时及手机Poco/forward事实、维护恢复proof持久化、新企微业务预览。模拟/PG通过不等于真机恢复。不得直接清锁、改原日期、注入原内存、扩大历史上限或重复换requestId。新补丁不追加到当前运行；未来只需云端重载，无需再次重载Agent或动ADB。新窗口须排空当前任务、保留结果、媒体宿主live前后验证，成功后先GET原提案再具名POST同一恢复请求，只核验155。

回退：保留当前aba0ddc3和ACTIVE/36份Compose；新增候选仅三文件COPY覆盖，回退用当前image/Compose，不回滚数据库或删除义务。原维护观测的旧SYSTEM producer19756引用保留（不是原reader）；新Agent15224保持。若不能在固定3秒内取得新鲜证明，围栏仍保留，不能放宽预算或自动开新attempt。
