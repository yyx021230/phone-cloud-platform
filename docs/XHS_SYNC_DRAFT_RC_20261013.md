# 小红书数据同步：草稿保存兼容候选回执

日期：2026-10-13；状态：单设备真机验收完成，独立 staging 候选，未发布为生产任务。

## 范围与身份

- 分支：`codex/xhs-sync-draft-20261013`；不可变候选标签：`xhs-sync-20261013-rc.1`。
- Git 起点：`6811aef632eeaaacd6d6ce1effc4afa64bf6d363`。该起点不是当前生产身份。
- 仅导入共享工作区此前已验证的 `小红书数据同步.py` 与 `test_xhs_data_sync.py`，不导入其他用户未提交改动。
- 共同流程修订日期 2026-09-30，SHA-256：`0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。
- 共享工作区本轮读取的主文档 SHA-256：`99f752fd14f3664537778b90a8e8b7b3f08dd8b5399680d623082d7a527a8411`。本 worktree 旧主文档仅追加本任务 D-079 与日志；其他旧现状不作为本轮生产证据。
- 改动授权：用户明确要求以后每次遇到“继续编辑图文笔记吗？”都点击“存草稿”。权限仅扩展该采集器的草稿保留动作；其他账号、发布或投屏行为不改变。

## 文件哈希

| 文件 | 导入前 SHA-256 | 候选 SHA-256 |
|---|---|---|
| `windows-agent/scripts/小红书数据同步.py` | `8427ad0bec695539460b83a4ae3688981f541bc3bb26679b2fc4425e05eaa21a` | `85964946854dfc2b2f4d9e41eeb1b61eca16c19af57947740d4901a465d04866` |
| `windows-agent/scripts/test_xhs_data_sync.py` | `3a1b4bc9c4d8fcca8d73f95032ef455497fa05f40feb6876ea4131dca545e1c4` | `76704b7ef80e546d8d4bf4cd81491a7d034706a284f332f774119a82e7193976` |

## 实际验证

- 首轮旧脚本在 102 号失败为 `could not prove the Creator Center works-analysis path`，未输出 JSON；XML 显示精确未完成笔记问题、“存草稿”和“去编辑”。另一次现有 Back 恢复后同一问题仍在，确认原兼容不足。
- `python3 windows-agent/scripts/test_xhs_data_sync.py`：23/23 通过。覆盖唯一启用按钮、父元素定位、缺失/禁用/异包/重复按钮、没有问题文案时不操作、点击后弹窗仍在时停止及原有 18 项。
- `python3 -m py_compile windows-agent/scripts/小红书数据同步.py windows-agent/scripts/test_xhs_data_sync.py`：成功。
- 102 号 app1 测试账号：候选独立运行成功，事件包含 `draft_saved_before_collection`；2026-10-13 10:34:43 上海时间的快照，时间窗 2026-09-14 至 2026-10-13，12 篇、滑动 2 次、`complete=true`、`stop_reason=list_end_visible`，观看/点赞/评论合计 353/1/0，各篇三项计数无缺失。
- 74 号：本次原同基线脚本成功，1 篇、0 次滑动、`list_end_visible`，合计 12/1/0。两份私有快照保存在共享工作区忽略目录 `windows-agent/data/xhs-sync-*-30d-20261013.json`，不提交账号数据。
- 审查：本轮自审；未宣称独立双人审查。脚本导入整体与相对已验证旧采集器的补丁分别核对，改动集中于精确草稿恢复和相应反例；其他采集逻辑沿用旧版本。
- 未验证：未来所有机型、全部小红书弹窗版本；稳定笔记 ID 去重、Web 导入、周期运行、Agent 集成仍不在本候选范围。

## 暂存运行与回退

候选只在 `D:\PhoneCloud\staging\xhs-sync-draft-20261013\小红书数据同步.py` 进行单机验收。验证后更新日常独立调用的 staging 脚本；不替换 Agent 生产执行器、不重启服务或修改冻结链路。

旧 staging 文件的备份为 `D:\PhoneCloud\staging\xhs-sync-draft-20261013\collector-before.py`，哈希为表中导入前脚本哈希。回退只需在没有采集进程时将该文件恢复到 staging 原路径并重新核对哈希；已产生 JSON 保留。该回退只撤销草稿兼容，无法撤销已按用户授权保存的草稿。

标签随本轮范围明确的本地 commit 创建，不推送、不移动既有标签。候选提交可用 `git show xhs-sync-20261013-rc.1` 复核。
