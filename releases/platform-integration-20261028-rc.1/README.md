# 全平台整合候选 rc.1

源码提交：`cb3c7e3`。完整模块、冲突处理、验证、未验证项与撤回说明见 [平台版本说明](../../docs/PLATFORM_INTEGRATION_20261028.md)。

- 当前 Git 分支：`codex/platform-integration-20261028`。
- 不可变候选标签：`platform-integration-20261028-rc.1`（最终交付文档提交）。
- 运行源码以仓库根目录为准，文件哈希见 `MANIFEST.json`，不复制另一个可能漂移的 runtime 目录。
- 合并前 main：`ac109ce288e0bc6be34104370309f1bb9465c9d2`，备份标签 `platform-before-integration-20261028`。
- 只推送 GitHub，不推 GitLab；不部署、不启用定时、不操作生产。
- Docker新镜像、组合真机及正式生产验收未执行。生产需要独立维护授权及当时基线核对，不能直接执行历史发布脚本。

若撤回本次源码集成，基于合并前 main 新建回退分支审阅；不要强推 main 或移动旧标签。没有线上数据/镜像/配置需要回滚。
