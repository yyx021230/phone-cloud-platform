# 发布顺序（准备中，尚未切换）

当前用户已授权本候选上线，但共享服务中断窗口尚未确认。所有脚本只对应已提交候选和生产c10e071b基线；不要用根仓旧代码部署。

1. 完成MANIFEST/PRODUCTION_DIFF、全量回归、JSON和隔离Postgres外部HTTP50条、真实原图AI及Windows隔离回放。准备绑定Git提交的构建上下文。
2. 运行prepare-cloud.py只构建/备份/隔离PG烟测并执行真实宿主D-075 live。Windows候选及原Python脚本备份置于独立staging目录，保持线上原文件。
3. 核对最新控屏和任务，取得当次5分钟云端+共享Agent窗口（包含窗口中新控屏）；暂缓查名接单/派发，保留原队列、人工等待和查询ID，等已派执行与AI读取完成。其他业务仍占用则不切换。
4. activate-cloud.py stop --approved-current-maintenance，Windows脚本 -ApprovedCurrentMaintenance，仅替换查名Python文件并通过原SYSTEM计划任务重载Agent；核对ADB PID20316/路径/身份/5037未变，不执行ADB命令；activate-cloud.py start --approved-current-maintenance。
5. health/ready、文件哈希、单实例、媒体live、原队列/结果/控屏恢复检查通过后finalize-cloud.py更新ACTIVE/回执，恢复维护前enabled值（使用配置revision，不覆盖调度/名单）。单机/双机观察当前对接方任务，核对原请求AI接续；不重写旧空结果、不追加未经限定的新批次。
6. 每步失败保持证据按ROLLBACK.md恢复精确旧版本；不以重启ADB/USB/Windows/媒体兜底。发布回执及验证记录另作范围明确提交和不可变部署标签。
