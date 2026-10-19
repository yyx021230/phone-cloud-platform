# 旧盘识别与启动前核对（阻塞，未启动）

北京时间 2026-10-19 13:20。分支 `codex/windows-newhost-setup-20261019`，接续 `9756b55a48a9e31736fa62b3c62f31ebd1b22d64`。

用户告知旧盘已接好，要求补最后数据后启动服务，并继续禁止切换 ADB 身份。本轮核对结果：

- `Get-Disk`、`Win32_DiskDrive` 和 `Get-PnpDevice -Class DiskDrive -PresentOnly` 均只看到新机 SOLIDIGM 512GB 系统硬盘；分区/卷仅属该盘。刷新一次存储枚举 `Update-HostStorageCache` 后结果相同，没有重新启动 USB、Hub、ADB 或 Windows。手机提供的 USB Mass Storage/CD-ROM 不作为旧硬盘。
- 未读取到旧盘，不能核对或补取最后状态。已请求用户说明旧盘连接方式并检查该盘连接/供电；没有初始化、格式化、联机未知磁盘或修改分区，没有以在线备份替代最后状态。
- 原 Agent XML 在新机 Task Scheduler COM 的内存对象中解析通过，主体 SYSTEM、LogonType 5、最高权限、IgnoreNew、一个开机触发器；Action 仍为原 Node 加 `--require D:\PhoneCloud\agent\adb-auth-env.cjs` 和原 Agent 入口。只解析未注册、未启动，没有修改 XML 或冻结启动动作。
- 云端实际 ACTIVE 仍为 `lookup-round-stop-20261016-deployed.1`，运行镜像 `sha256:4862080e4d6802a45c6f40bed390a05d99f891cf17c964e4d551f9b087140059`；下次镜像 `sha256:7980919cd715cb7d1ebaf819833aab8319121d4292994f13a89a4b066cd751b5`，保留既有前端热补与持久化镜像差异，没有改 Compose 或发布指针。
- 云端容器 healthy，正确端点 `/healthz`、`/readyz` 均 HTTP 200。最初错误访问 `/health`、`/ready` 返回 404，查阅已有 Dockerfile 后纠正，不将其误报为服务故障。
- 媒体真实宿主机只读 `verify.mjs --live` 通过：PID 2503525，SHA256 `d3a9eab65555680f1a7efe6d1746f315e25c69059d49aff40a0a45d292feec35`，8 Mbps/最多2包。宿主机 PATH 没有 node，已有便携 node 依赖随附 musl；用同目录已有 loader/library path 成功执行。未安装新运行时、修复或重启媒体。

新机运行文件和两套原授权保持上一阶段已恢复状态；本轮没有调用 ADB、创建 Agent 任务、启动服务或写入业务数据。当前阻塞仅是旧盘尚未被 Windows 识别，无法完成用户要求的“补最后数据后启动”。继续前先取得实际可读的旧卷并保存差异/回退副本，不虚构迁机或手机在线结果。原脏工作区与其他任务保留，无远端推送。
