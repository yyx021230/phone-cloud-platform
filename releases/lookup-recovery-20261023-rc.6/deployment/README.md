# rc.6 发布准备（2026-10-23）

状态：已准备，未切换。用户已要求部署 rc.6；当前有外部联调和控屏，维护窗口尚未获得本次明确确认。运行候选固定为 `f97306eddf74cc8d2f212fc4027095201bd1433d` / `lookup-recovery-20261023-rc.6`。发布记录分支 `codex/lookup-rc6-deploy-20261023`；不改旧候选 tag。

新镜像 `sha256:7ecf126b7c6b254eb8e8f6c6b16e57bd7fe1927219771894a8b4dcec3a7ba745` 已通过隔离 Postgres 启动、接口与鉴权烟测，18个云端运行文件哈希匹配。旧生产为 AI deployed.1 / 35cba1db；实际Compose及20个总运行文件的before哈希均核对。云端只改变image，原环境、挂载、鉴权配置不变；Windows只换执行器和Agent入口两个已测试文件。新图标选框实验不包含在发布中。

备份位置：云端 `/opt/phone-cloud-staging/lookup-recovery-20261023-rc.6/rollback`，Windows `D:\PhoneCloud\staging\lookup-recovery-20261023-rc.6\rollback`。保留完整数据库dump、旧镜像、ACTIVE/Compose路径及哈希、对应Agent文件；文件哈希见回执。dump目录校验通过，未进行完整恢复演练。备份含生产数据，只保留在宿主机受限目录，不入Git。

切换顺序：再次核对版本/哈希和本次维护授权；等待当前联调轮次停止、业务及Agent任务清空；云端停接单→既有SYSTEM计划任务停止Agent→替换两个文件→原计划任务启动Agent→新云端镜像启动→health/ready、文件哈希、Agent单实例/心跳与D-075核对→写ACTIVE和正式回执。脚本中的无活动业务门槛不能绕过；不取消当前查询。只有当前控屏维护授权后才能执行activate脚本。ADB PID必须始终为8988且SYSTEM，任务动作、授权文件、媒体不变。

回滚：在同一获准窗口内，按原计划任务停Agent、从此次rollback恢复两个原文件并核对before哈希；使用备份ACTIVE记录的原Compose链（不附加此次pending）重启旧镜像；核对health/ready与媒体后还原ACTIVE。保留当前数据库和业务结果，不恢复旧dump覆盖新数据、不把JSON改回JSONB。若出现ADB身份/进程变化立即停下排查，不尝试重建或切身份。维护窗口外的额外中断须另行告知。

首次Windows执行策略拒绝和Docker基础镜像引用失败已记录；均发生在暂存/构建阶段，没有替换生产或重载服务。详细事实与未验项见PREPARATION_STATUS.json。已有本地全量通过不等于生产真机全部验收；上线后需只针对空闲测试机验证并保留未覆盖项。
