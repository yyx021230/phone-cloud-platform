# rc.5组合发布准备（2026-10-26）

用户明确要求上线。源码已提交 `efdd05fecc4dbd5c196c0341e1c1e1beca794c27`，不可变标签 `lookup-ai-coverage-20261025-rc.5`。准备分支 `codex/lookup-rc5-release-20261026`。采用生产c10e071b镜像加已提交rc.1–5最小叠加，17个云端文件、4个Windows文件；不从根仓打包业务。

## 基线与预检

生产仍 `lookup-final-20261023-deployed.1` / 源2f18514 / 镜像c10e071b；Agent27236、ADB20316均SYSTEM、路径5037基线不变。D-075真实媒体宿主live通过，8Mbps/2包，PID2503525。21个生产文件hash核对；3份镜像内API文档比候选记录的文档基线更旧，经完整差异核对只补已有离线结束/动态并发及本次准备键约定，回退hash已改用实际镜像文件，不伪称旧记录是线上值。

本次操作前云端RestartCount为2，StartedAt为UTC2026-10-25 16:01:04；目前healthy、health/ready200。两次重启来源未确认，指定时间段日志/事件没有返回相应记录，不归因本次部署，不写零重启。切换后新容器独立计数。

本地1287 Node、568 Python、163 runner，Windows专项15通过；真机五并发及10号码9姓名/1空见上级回执。最终外部API→真实Agent→持久化冷却/自动转交→卡片通知要在发布后单机/双机灰度验证，112网络根因仍待证。用户在这些边界已说明后授权上线；不宣称所有生产分支已验收。

## 顺序和授权

1. `prepare-cloud.py`只构建、备份、隔离PG烟测和媒体只读核验；Windows4文件独立staging/备份/激活脚本语法已通过。不中断服务。
2. 镜像与备份均齐后核对当时业务/控屏，申请实际共享云端+Agent维护窗口，包含窗口内新控屏。此前维护不复用。本轮尚未取得中断授权。
3. 获准后通过配置revision临时暂停查名接单/派发，保留原队列与结果，等正在执行任务/AI结束；有其他实际业务则停止切换。
4. 只在该窗口执行 `activate-cloud.py stop --approved-current-maintenance`，运行Windows原SYSTEM计划任务的激活脚本，再cloud start。不执行ADB客户端命令、不改SYSTEM身份/密钥/任务动作、不重启Windows/USB/媒体。
5. 云端/Agent哈希、单实例/新鲜心跳、health/ready和D-075前后核对，`finalize-cloud.py`写ACTIVE与部署回执，恢复维护前enabled值。按需单机/双机外部API灰度，不用历史缓存当新真机结果，不改原有业务结果。

生产文件尚未替换；准备脚本本身不是已发布证明。具体镜像、备份与隔离结果以PREPARATION_RECEIPT为准，切换后另记回执。

共同流程修订2026-09-30，SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。本工作区开始干净；旧4d0b工作区及其他既有改动保留。不推送。
