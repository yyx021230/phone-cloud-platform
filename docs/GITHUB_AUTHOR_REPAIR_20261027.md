# GitHub提交身份修复（2026-10-27）

状态：邮箱已修正，历史修复分支已按用户明确授权快进合入GitHub默认main；贡献图等待GitHub刷新。不涉及生产发布。

## 范围与方法

用户要求修正提交邮箱、处理历史贡献，并保留已有版本和标签、不动线上。GitHub公开用户信息和SSH握手均确认账号为yyx021230，用户ID为178979636。依据GitHub的ID-based noreply规则，将本仓库共享local配置设为 `178979636+yyx021230@users.noreply.github.com`；不更改其他项目的全局Git配置。该配置供本仓库各worktree使用，独立worktree若另有覆盖须单独核对。

原候选分支 `codex/lookup-preparation-recovery-20261027` 保持 `770560ab61b1a6380d6e9d9c01e13e4dc2e332d5`，原rc.8标签继续指向产品d3ca8c4。没有reset、rebase原分支、强推或移动任何原标签。

在 `codex/github-author-repair-20261027` 建立325条历史提交的邮箱修正版副本，仅替换author/committer中的无效邮箱yuxuan和对应父提交引用，完整保留每个提交的代码树、消息、姓名、作者日期、提交日期与时区。新旧哈希必然不同，映射见[逐提交映射](evidence/GITHUB_AUTHOR_REPAIR_20261027.json)。新副本尖端 `228386b965189d7ea31d4c2d25df07481e5bbbff`。

再用一个附加合并连接原始历史与修正历史：合并后的代码树与原候选完全一致；原main仍是祖先，因此未来不必强推main。两套历史都可追溯，这是保留原发布哈希的代价，不将邮箱副本作为新产品版本，不重新编号发布，不修改清单中历史SHA。原标签、生产ACTIVE和部署回执仍以原始SHA为准。

## 已验证

- 325条逐条核对tree/message/date一致；未遇签名或mergetag需要剥离。
- 建立并验证本地Git bundle备份，包含原候选完整祖先、origin/main、rc.8标签；位于本机私有任务目录，不上传备份二进制。
- 创建历史修复分支后，490个既有ref逐项保持不变。
- 身份修复合并与原候选代码diff为空；本说明和主文档是后续独立文档变更。
- 原分支已经通过上一轮推送前历史扫描；修正副本复用原blob，不引入代码、密钥或运行数据。无业务测试重跑，原因是没有业务变动。

## 默认分支与剩余步骤

GitHub只有关联到账号、位于默认分支或gh-pages等符合条件的提交才计入提交贡献图。独立修复分支成功上传与作者关联正确仍不等于绿格已经补计。

现有main仍为0034b939。纳入此修复分支会同时使main包含当前候选代码与版本材料；不能只为贡献图默默改变项目开发基线。应在明确主分支纳入方案后执行普通快进，保留原分支、原tag及所有旧提交。若暂不合并，则保持此修复分支，后续正常发布合并时带入。GitHub可能需最多24小时刷新，不保证即时或预设贡献总数。

GitHub HTTP私有账号接口当前无有效登录，返回401；SSH已验证账号且可推送，公开提交API可用于核验作者。未修改账号设置、全局邮箱、默认分支或线上服务。

参考：[GitHub邮箱规则](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference)、[贡献缺失规则](https://docs.github.com/en/account-and-profile/how-tos/contribution-settings/troubleshooting-missing-contributions)。


## main纳入回执

2026-10-27用户明确选择“现在合入main，保留旧分支和标签”。实际普通push已成功将GitHub main从0034b939快进到d37f5b0，无force；原候选分支770560a、rc.8原标签对象6088be1及产品d3ca8c4不变。修正历史325条全部为main祖先；公开提交API已验证最新修正提交的author和committer均关联yyx021230。原日期保留，贡献图是否刷新和具体数量仍由GitHub计算，不以推送成功冒充界面刷新。

本回执文档再同步修复分支和main；不存在代码行为修改。后续可在原候选分支继续开发，使用已修正的仓库local邮箱，再正常合并main，无需再次复制历史。GitLab保持原状，生产、现有部署回执、不可变标签及其他工作区均未改动；未执行线上部署或服务操作。
