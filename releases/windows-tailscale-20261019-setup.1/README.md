# 新 Windows Tailscale 安装阶段

用户明确要求建立Tailscale，目标是迁机后通过原tailnet远程管理新Windows。当前阶段：**已安装，等待用户账号登录，尚未打通远程SSH**。

- 分支 `codex/windows-tailscale-20261019`，基线 `3d45ee90b9a9b2047019444f441a38e2dda451d9`；仅本轮文档和回执提交，原工作区保留。
- 采用[官方Windows安装包](https://pkgs.tailscale.com/stable/)1.104.1 amd64 MSI；Windows数字签名Valid、发布者Tailscale Inc.，退出0，服务Running/Automatic。完整SHA256见[receipt.json](receipt.json)。
- 新机下载成功并验证签名；Mac两次下载超时，未使用不完整文件，第一份明确改名partial。原SSH master失效后按原指纹重新认证连接，未修改SSH账号密码。
- 登录命令有界25秒后因NeedsLogin结束，属于等待SSO授权，不能算已连接。一次CLI帮助输出到stderr被PowerShell当错误，未造成配置变更。登录地址只在当前会话交给用户，不写入仓库或回执。
- 当前偏好已核对：不接受Tailscale DNS及子网路由、不配置exit node、不广播路由。公司LAN SSH原规则保持；未增加新的SSH放行规则。
- 安装后Agent PID14508、共享ADB PID8988均SYSTEM，与之前一致。没有重启Windows/Agent/ADB/USB/媒体，没有修改密钥或共享ADB配置。

登录完成后，按[官方无人值守说明](https://tailscale.com/docs/how-to/run-unattended)启用无人值守，再限定管理Mac的Tailscale地址放行SSH，核对新IP及实际登录。服务自动启动不等于无人值守已验收；不为测试强行重启正在使用的Windows。

保留安装包与 `D:\PhoneCloud-Migration\tailscale-install-20261019.log`；若需回退本轮，删除本轮新增的专用规则（当前尚未新增），从LAN管理停用/卸载本轮Tailscale，不触碰原业务。当前仅自审文档/回执，JSON、链接和diff检查；没有业务代码变更，不重复应用测试。尚未推送。
