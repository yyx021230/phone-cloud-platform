# 2026-10-11 更新准备

状态：**本地候选，待验收和发布授权；未上传部署包、未切换生产、未重启服务。**

源码固定为 `platform-api-docs-20261010-rc.5` / `7f695507761b07504a94b7372de0c340befbf33f`，继承查名 `lookup-20261010-rc.2`。本准备版本使用分支 `codex/platform-update-prep-20261011` 和不可变 annotated tag `platform-update-20261011-rc.1`；不改变旧标签。

更新内容：账户限制后的冷却与切号、普通重试直接搜索、姓名提取、按手机编号发送拼图提醒及人工后接续、可靠保存结果；库存 API 文档入口，平台五类业务分别列出，使用“小红书自动登录、支付宝查名字、小红书一键发布”名称。

| 文件 | 用途 | 范围 |
| --- | --- | --- |
| `cloud-update.tar.gz` | 云端最小源码差异 | 16 个 server/public 文件 |
| `windows-update.tar.gz` | Windows Agent 最小源码差异 | 6 个 src/scripts 文件，路径相对 Agent 根目录 |
| `cloud-build-context.tar.gz` | 沿用实际生产镜像依赖的离线构建上下文 | 16 个源码文件、Dockerfile、运行清单；尚未构建镜像 |
| `rollback-code-originals.tar.gz` | 对照生产源码原件 | 9 个原件；不是当前完整配置/数据备份 |
| [MANIFEST.json](MANIFEST.json) | 来源、22 文件前后哈希、22 冻结哈希、档案哈希 | 新增 13 文件另列，回退时不能盲删 |
| [PREPARATION_RESULTS.json](PREPARATION_RESULTS.json) | 本轮实际验证、线上只读核对及未完成项 | 历史和本轮证据分开 |
| [RUNBOOK.md](RUNBOOK.md) | 发布前置、顺序和回退 | 仅步骤说明，不代表执行授权 |

2026-10-11 实际只读核对云端 26 项、Windows 18 项，文件内容/缺失状态与导入生产基线一致；云端镜像仍为 `sha256:907e0c65a50b1d066241e55ce475ac772647a531b582ae2894e25e1adc8ed3dd`，healthy、0 restart。远程 Windows 与内网地址确认同一台机器，Agent 单实例 PID 85936。状态会随时间变化，正式窗口必须重查。

本轮隔离复验：根语法、screen 594/594、Agent 289/289、Python 163/163 与查名 56/56、SDK 4/4、API 文档 9/9通过，各入口覆盖重叠。四个档案解包回读、来源/哈希、重建一致性与篡改拒绝检查通过；不加载真实业务凭据或连接手机。

媒体主机读取的实际二进制、运行二进制、drop-in、8Mbps/2包参数与稳定 PID 符合 D-075，并经现有 `verifyLiveSnapshot` 判定；**主机没有可调用 Node，标准 `node deploy/mediamtx-pacing/verify.mjs --live` 未运行，不能据此放行部署**。发布窗口需先提供获准的主机 Node 运行入口并执行标准检查，不修改媒体配置或重启媒体。

尚未完成：实际生产基底镜像构建/隔离启动、维护窗口新鲜配置/数据与完整回滚点、rc.2 真实再次触限→切号→拼图→恢复组合、两台真机/OEM、自然8小时及24–48小时观察、当前组件配套升级/完整回退验收。全新 npm 安装未测；本构建上下文沿用生产镜像依赖，无数据库 Schema 迁移。

离线复核（仓根）：

```bash
python3 scripts/prepare-platform-update.py --verify releases/platform-update-20261011-rc.1
```

现有脏工作区未用于打包，未修改业务源码、投屏、ADB、USB、媒体或账户/设备状态。未推送本准备版本。
