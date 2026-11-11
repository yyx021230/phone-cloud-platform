# 生产版本与代码主线对照

核对日期：2026-11-11。生产事实来自宿主机 `ACTIVE_PLATFORM_RELEASE.json`、容器和 Windows 实际文件哈希；Git 主线合并不等于部署。

| 范围 | 当前生产 | 代码/回执 |
| --- | --- | --- |
| 平台总版本 | `device18-replacement-20261111-deployed.1` | 回执 `2cd85d8e6dd71a1c533f92f052012f7dc792ea03`；仓库补丁 `a661b57`，操作工具 `ff99e06` |
| 企微 CPS | `wecom-cps-send-20261111-deployed.1`，正式接单 `send/production` | `1ca3c4f`；保留原线索、发送去重和回传账本 |
| 主平台运行基础镜像 | `sha256:fc0bb8c3458470ad21397fa16aed8b5207882a0fe112f4107d7b89ef094c52ce` 加已登记热补 | 以 ACTIVE 中逐文件哈希为准 |
| 主平台下次启动镜像 | `sha256:e5b243b5e3b8c7bbd5c014bf059212db704f4d9592e639cbb5c773915f16ca30` | 已登记 Compose 覆盖；本轮未切换 |
| Windows 小红书采集器 | `86aa18abe0a0abd26075ec51392559868fbe7ceb7584147fb4ed39a69093844b` | 对应原 rc.11 发布载荷；现补齐根源码和依赖 |
| 主线归并候选 | `platform-mainline-20261111-rc.1` | 仓库候选，不是新生产发布 |

原先 GitHub `main=3bdb946`，另一个远端 `main=ec37868` 是早期单次快照；企微等后续提交停留在独立分支，导致只看 main 看不到已上线代码。本轮保留两边历史，归并已发布平台、企微和小红书源码及回执。两个远端 main 已同步到代码归并提交 `7ddea8d`，逐项回读相同；随后仅补同步回执，最终元数据标签为 `platform-mainline-20261111-synced.1`。分支为 `codex/mainline-production-20261111`。

主线仍包含原 GitHub main 已提交、尚未在生产启用的设备恢复观察收尾修复（`dccc00e`）。不能据此宣称生产已经运行主线全部内容。未上线的 serial-case 投屏/ADB 健康候选保留在原功能分支和历史中，当前主线采用与生产一致的两个控制模块；范围见候选 `excluded-candidates.json`。

生产 Agent 和共享 ADB 仍为 SYSTEM，保持原二进制、授权与启动方式。此次不重启云端、Agent、ADB、Windows、USB 或媒体，不修改生产配置、任务、占用及查名账户。

本轮仅为源码归并及本地回归。CPS 首条新正式线索的邀请收到与自动回传验收仍保留为未验项，不能用模拟测试代替。合并证据、文件哈希与实际测试结果见 `releases/platform-mainline-20261111-rc.1/`；既有 deployed 标签和部署回执保持不变。
