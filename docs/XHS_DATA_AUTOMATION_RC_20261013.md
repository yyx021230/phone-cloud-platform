# 小红书数据采集：自动化模块候选回执

日期：2026-10-13。状态：**本地候选，待发布授权**。风险：R2（任务协议、设备租约、Agent 执行与用户数据隔离）；生产发布和真机集成验收按 R3 单独授权。

## 版本与基线

- 分支：`codex/xhs-data-automation-20261013`；不可变 annotated tag：`xhs-data-automation-20261013-rc.1`，完整提交由 `git rev-parse xhs-data-automation-20261013-rc.1^{commit}` 解析。
- 本轮代码基线：`ff8a64a88792897da11bebc2055a4bf370725ac2`（已验证的独立采集器草稿恢复候选）。其旧业务代码祖先为 `6811aef632eeaaacd6d6ce1effc4afa64bf6d363`，**不是当前生产版本**。
- 共享工作区原分支 `codex/sms-notification-library`、HEAD `6811aef632eeaaacd6d6ce1effc4afa64bf6d363`。既有未提交业务文件全部保留；本轮业务实现位于独立 managed worktree，没有把这些未知改动纳入提交。
- 现行事实依据为共享仓完整主文档，读取时 SHA-256 `61ecfb063022f99c57bde0490960548de03d2cc666f3b777580220aa44f17b0b`；共同流程修订 2026-09-30，SHA-256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。
- 本轮文件清单与 SHA-256 见 [候选 manifest](evidence/xhs-data-automation-20261013-rc1-manifest.json)。该清单代表候选文件身份，不能代替正式发布的线上基线与镜像回执。

## 需求、入口与范围

延续 D-079 手机创作者中心作品列表路径，将此前手动独立运行的采集器接入 Phone Cloud 的现有自动化中心，名称为 **小红书数据采集**。入口：手机详情 → 自动化 → 小红书数据采集。

选择启用的小红书 1/2 槽位后开始任务；没有绑定账号的测试槽位也可采集。页面提供逐篇标题、发布日期、笔记状态、观看、点赞、评论，三项合计、时间窗口、完整性标记、历史快照、取消及 JSON 下载。缺失计数显示“—”，真实零值显示 0。新请求采用会话版本检查，退出或切换用户后不接受上个用户的迟到数据。

采集最近 30 个上海自然日，含当天；自动下滑到可靠日期边界或列表末尾。滑动预算耗尽只保存部分结果并将任务标为失败，不误称全量。只读取帖子外层列表，不进入单篇详情。遇到精确确认的未完成笔记弹窗，沿用用户此前持续授权点击“存草稿”，保留未完成内容后继续。

本轮替换 D-079 的“仅独立脚本、没有 Agent 任务”候选状态，扩展为可审阅的自动化集成；仍未建立 Web 项目账号映射、稳定笔记 ID 或业务导入。原 Web 同步故障根因没有在本轮确认。没有创建周期执行计划。

## 协议、存储与兼容

| 环节 | 候选行为 | 兼容边界 |
|---|---|---|
| 用户接口 | GET/POST `/api/v1/user/automation/xhs-data-tasks`；GET `/:jobId`；POST `/:jobId/cancel` | 登录用户只读取/取消自己的任务，越权详情返回 404；创建时校验在线、启用槽位、占用和 Agent 能力 |
| 任务与存储 | 新 kind/type `xhs_data_collect`，复用 `automationJobs`/`windowsTasks` 的现有持久化和设备锁 | 没有新表或 Schema 迁移；列表返回最近 30 次摘要，详情保留作品；没有 Web 数据库写入 |
| Agent 能力 | health `xhsDataCollect={protocol:"xhs_data_collect_v1",ready:true}` | Python `--protocol` 不访问手机；旧 Agent 不具备能力时创建返回 `xhs_data_agent_update_required` |
| Agent 配置 | `xhsDataCollectionRunnerPath` 默认 `scripts/小红书数据同步.py` | 执行依赖 Python 和现有 ADB/XML，不以 Poco 预检是否就绪作为准入条件 |
| Python guard | `--task-id` 对应 automationJobId；仅接受同 kind/job/slot 的自身设备锁 | 其他任务或实时控制占用仍拒绝；新增 jobId 不允许复用其他占用 |
| 结果 | schema 3、30 日窗口、最多 1000 篇、允许字段与计数校验 | 只有可靠 stop_reason 才保留 complete；串号/槽位/旧输出不一致时失败；不保留未知字段 |
| 超时与取消 | 执行 20 分钟，任务/锁 21 分钟；取消写任务专属 marker，给执行器最多 25 秒退出后只中止该子进程 | Python finally 与 Agent 外层 finally 恢复目标原屏幕超时/距离感应设置；旧任务超时参数不变 |

Agent 复用已有目标设备隔离和取消调度，仅在新任务启动时停掉目标的空闲 Poco worker 以独占 XML。新任务结束不触发全机库存扫描。原扫描、ADB daemon、USB/PnP、投屏生命周期和调度并发参数没有修改。

## 本轮实际验证与审查

| 验证 | 实际结果 | 证明范围 |
|---|---|---|
| 根 `npm run check` | 通过 | JavaScript 语法 |
| `npm run test:screen` | 524/524，通过；0 失败/跳过 | 现有投屏回归及本地服务/前端/协议模拟；不是生产真机验收 |
| `npm run check --prefix windows-agent` | 273/273 及语法，通过 | Agent 回归，与根同名命令范围不同 |
| `python3 windows-agent/scripts/test_xhs_data_sync.py` | 25/25，通过 | 弹窗、自然日、完整性、自身锁与取消 marker 等 |
| 本地 HTTP 集成 | 通过，纳入上述全量 | 新任务创建/领取/结果、拒绝旧 Agent、槽位、占用、跨用户隔离、非法结果、部分结果、取消后迟到回执及临时 JSON 持久化重启恢复 |
| Agent 模拟 | 通过，纳入上述全量 | 状态序列化不丢作品/零值、退出码 2、输出身份/旧输出拒绝、取消与目标设置恢复 |
| 本地浏览器 | 创建→排队→完成、查看、取消、JSON 下载通过；控制台 error 0 | loopback 隔离服务与 fake Agent，展示当天 102 实机已有 12 篇快照，353/1/0；**不是再次真实采集** |
| diff 自审与 `git diff --check` | 通过 | 范围、权限、失败、取消、迟到、敏感输出及回退；没有声称独立双人审查 |

浏览器预览证据保存在共享仓忽略目录：`windows-agent/data/xhs-data-automation-preview-20261013.png` 和 `xhs-data-automation-result-preview-20261013.png`；真实用户帖子数据未纳入版本库。浏览器验证服务使用隔离临时 JSON 库、合成账号与设备，无真实数据库或真实 Agent 外联。

前一阶段 74/102 独立采集器已有实机证据；本轮平台队列到真机的集成、真实 PostgreSQL 持久化、当前生产入口最小合并，以及取消时真机恢复尚未验收。测试没有失败或豁免项。上述本地通过不构成上线或全机兼容保证。

共享 Agent/前端入口存在旧基线：本轮 diff 不修改已有投屏函数、共享 ADB 活动追踪/健康模块；`public/vendor`、`screen-client/src`、`windows-agent/src/screen*`、`windows-agent/whip-publisher`、媒体目录相对本轮父提交均无变化。没有声称旧祖先自带当前 D-075 媒体基线。

## 发布、灰度与回退材料

1. 按 AGENTS 与共同流程先取得指定候选、云端/Windows 目标及允许 Agent 更新窗口的明确发布授权。当前没有正式发布、推送、服务重启或生产数据修改。
2. 发布前只读取得实际线上源文件/镜像/组件哈希和上一版；基于实际生产版本审核并最小合并本候选的新模块及明确插入点，保留后续 owner、发布协议、查名等既有修复。**禁止将本 worktree 的旧入口整文件或整仓覆盖生产**。生产合并差异需形成新提交/递增 rc，并重新执行适用验证。
3. 云端与 Agent 协议成对更新；新服务遇旧 Agent 明确禁用采集。保存云端文件/镜像和 Agent 配置/入口/runner 的原版及哈希，登记独立回滚点。当前生产备份与部署回执未创建，不能伪称已准备实物回滚包。
4. 先在获准的 74 号单设备验证平台入口、真机结果、持久化与取消恢复，再扩至获准的 102 号，最后另行授权扩大。保持单设备锁，未知弹窗/账号限制/未确认时间范围时停止并保留证据。
5. 正式更新与回滚均保留 D-075 自定义媒体二进制和 drop-in、8Mbps/最多 2 包预算；不重启媒体、Windows 系统、ADB 或 USB Hub。若实际发布涉及媒体宿主机，须按主文档在真实媒体机前后只读执行 `verify.mjs --live`，失败停发，不自动修复。
6. 未部署候选回退为父提交 `ff8a64a...` 的已验证独立脚本；此前 Windows staging 回退文件仍为 `D:\PhoneCloud\staging\xhs-sync-draft-20261013\collector-before.py`。生产若回滚，只恢复此次实际记录的业务/Agent 变更集合，不覆盖媒体或其他任务版本。

下一步：取得发布授权后收集生产基线，形成最小集成版本和真实回滚点，再执行 74→102 灰度验收。
