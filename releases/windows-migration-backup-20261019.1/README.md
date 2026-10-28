# Windows 迁机备份回执 — 2026-10-19

状态：Windows离机副本校验完成；云端备份在原服务器校验完成。在线备份，未切换电脑、未恢复、未发布；不是Windows整盘镜像。

## 版本与授权

- 本轮分支：`codex/windows-migration-backup-20261019`；开始HEAD：`8b0e44e37141a41e5aa2ff7a8a42aae5a7016dad`，开始工作区干净；其他worktree及企微候选保持。
- 生产ACTIVE：`lookup-round-stop-20261016-deployed.1`；镜像：`sha256:4862080e4d6802a45c6f40bed390a05d99f891cf17c964e4d551f9b087140059`。
- 用户批准备份，另单独批准两份现有ADB密钥仅备份；没有恢复密钥、身份/入口变更、重载或全局维护。
- 共同流程修订2026-09-30，SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。

## 备份位置与时间

- Mac受限目录：`/Users/yyx/Backups/PhoneCloud/windows-migration-20261019-1022`，目录700/文件600；备份包含敏感资料，不进入Git。不是加密归档。
- Windows：`D:\PhoneCloud\migration-backups\windows-migration-20261019-1022-r4`，ACL仅SYSTEM及Administrators；10:26:00—10:27:56（北京时间）。先前同前缀的三次不完整尝试已标记不可还原。
- 云端：`/opt/phone-cloud-platform/backups/windows-migration-20261019-1022`，10:23:51—10:24:43（北京时间）。Mac仅保留云端回执及明确标为不可恢复的传输片段；公网慢而停止的额外副本没有算作完成。

## 完整包校验

| 包 | 字节数 | SHA256 | 完整副本位置 |
|---|---:|---|---|
| windows-runtime-and-data.zip | 1664452110 | 6e7c0615add126604b0db8f83f7aa90e7b4992bf88af90cd4c43c306816290f8 | Windows、Mac |
| windows-logs.zip | 1002581598 | 837adc4c6fb57f854e6db210f93ff2a10d9bbe272c343034926ebe5933ec955f | Windows、Mac |
| usb-driver-packages-reference.zip | 7979488 | 7bc6c32b58aba826d89d6a7e57d76edb89c84981b234b6b32dbbb89fd8d6bbba | Windows、Mac |
| phone-cloud-postgres.dump | 513729418 | 7a958253c69ae6e0d76637318a77bb3327176b77fd166c11469fa662e91082db | 云端 |
| cloud-config-and-state.private.zip | 38518105 | 59fcf2676875c8d1fbac3d4066dec85266ab3062dfaa5021d99cedda947c5c6e | 云端 |

Windows核心25,126项、日志101项均在Mac完整解压读取，逐项大小、CRC和SHA256匹配源端manifest；两份私钥结构有效，对应公钥文件存在，未额外演算公私钥配对；SYSTEM Agent任务XML与当前配置/恢复状态/工具完整性通过。4套OEM INF按内容匹配DriverStore并复制完整目录，Mac归档hash/全部CRC通过。云端全数据库custom dump的pg_restore完整解码通过；没有恢复到新数据库，DB与文件快照不是同一原子事务。

## 范围、失败与边界

包含当前Agent源码/依赖/runtime/tools、配置、状态、有效缓存、日志、启动脚本、原任务XML、USB枚举参考和用户允许的两份现有密钥；排除历史发布/备份/暂存及旧部署缓存。源端原有Appium缓存路径已不存在。agent.log在复制期间继续追加，仅保证捕获前缀完整，其余文件没有观察到变化。

首次任务XML导出超时后改为只读原始XML；早期备份守卫误计ADB临时客户端、旧历史缓存不可读两次尝试均未当成成功包，最终改为5037监听者检查和排除历史部署缓存。Windows SFTP不可用，改用SSH二进制传输；本地验证初次遇Python3.9无file_digest，改为流式SHA256后全通过。云端额外离机复制停止，片段不可恢复。没有以这些失败修改生产服务。

10:33只读核对：SYSTEM Agent PID650400保持，配置hash与备份相同；5037唯一监听PID1086632为SYSTEM及固定SDK路径。初查ADB PID634172随后改变；本轮未调用ADB客户端/重建/切身份，未追查外部变化来源，不能把它写成ADB全程未重启。未重启Windows、USB或媒体，未开展手机查询/发送。

## 正式迁机前必须完成

1. 核对新Windows环境、既有D盘路径、网络及实际USB拓扑，先不要启用Agent或导入全部任务。
2. 在明确维护窗口内停止接新任务、等业务安全结束，补最新配置/状态/日志增量并校验；在线备份不能替代切换时点快照。
3. 确保新旧Agent不同时用相同agentId运行。SYSTEM、既有SDK路径和原授权冻结仍适用；本次仅备份不批准实际恢复密钥或更换启动入口。
4. 不直接启用旧PID锁、旧USB/PnP映射、历史重建任务、注册表或旧驱动；四套驱动只供核对，避免重新引入冲突。
5. 按授权完成单台、两台与扩大验收后才能认定迁机完成。暂不清空旧电脑；回退先确认新端已停且单实例，再按窗口恢复旧端。Windows迁机无需把云端DB备份覆盖到仍在线的数据库。

本轮仅文档/回执进入Git；敏感归档及逐文件私有manifest留仓库外。标签`windows-migration-backup-20261019.1`表示备份里程碑，不是上线版本。未跑业务全量回归，因为没有修改业务代码；迁机后的恢复、Windows原生执行和真机验收均未完成。
