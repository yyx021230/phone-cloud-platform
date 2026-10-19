Phone Cloud Windows 迁机包 · 2026-10-19

当前可以做：把本文件夹完整复制到可靠的移动硬盘或新电脑，运行校验和暂存检查。
当前不要做：直接关掉并清空旧电脑、启动新旧两套Agent、导入旧恢复任务或批量安装旧驱动。

已包含
1. 当前生产Windows Agent、Node/Python/Java/ADB/FFmpeg、Python依赖、OCR环境与模型。
2. 配置、业务本地状态、设备编号映射、启动任务原始XML、当前网络/环境参考。
3. 两份现有ADB授权密钥的受限备份，以及驱动参考包。
4. 完整包和逐文件校验工具、新机只读检查/隔离暂存工具、最后状态采集工具、运行环境烟测工具。
5. 完整迁机、验收、回退步骤：CUTOVER_RUNBOOK.txt。

重要状态
这是在线备份，最终增量尚未采集，新电脑尚未准备/验收。
旧电脑真正关机前，要安排任务安全收尾、停止旧Agent、补最后状态并复制到旧机以外的位置；这些动作本轮都没有执行。
数据包里的密钥仅获备份授权，没有执行恢复。新机实际恢复/启用按切换窗口确认，不自动改身份或重新生成密钥。
云端服务不换电脑：数据库已在云端备份，路径和哈希见CLOUD_REMOTE_BACKUP_RECEIPT.json。该文件不是数据库本体，本迁机包没有云端dump。
本包不含Windows整盘镜像、Windows安装介质/许可证、Tailscale/SSH主机身份、旧历史发布备份。

核验方式
Mac/Linux已有Python3：python3 verify_bundle.py 本文件夹绝对路径
新Windows管理员PowerShell先只读检查：
  powershell -NoProfile -ExecutionPolicy Bypass -File .\Prepare-NewHost.ps1 -Bundle "E:\PhoneCloud-Windows-Migration-20261019"
需要暂存时，增加 -StageDirectory "D:\PhoneCloud-Migration-Stage"；目标必须不存在且至少20GiB空闲。
暂存只解出D/PhoneCloud程序树，不复制C盘授权密钥，不导入任务，不启动ADB/Agent。
暂存后可使用附带Python完整核验：
  D:\PhoneCloud-Migration-Stage\D\PhoneCloud\tools\python39\python.exe .\verify_bundle.py "E:\PhoneCloud-Windows-Migration-20261019"
以上E盘只是移动介质例子，请按实际包路径替换；不要运行旧的install-service.ps1、start-agent.cmd或start-agent.ps1。

请保留原文件夹结构。归档含私钥/客户数据，目录需限制访问；它不是加密压缩包，不要公开分享。
