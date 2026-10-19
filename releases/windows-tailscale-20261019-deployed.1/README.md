# Tailscale 新机远程接入回执

2026-10-19，分支 `codex/windows-tailscale-20261019`。用户完成原账号登录后，新机 `PC-20261015BZYS` 已加入原网络，地址 **100.100.177.27**。本机管理Mac经Tailscale地址完成SSH认证及远端命令验证。

```sh
ssh Administrator@100.100.177.27
```

## 已完成

- 延续 [安装阶段](../windows-tailscale-20261019-setup.1/README.md) 已校验的官方1.104.1；服务Running/Automatic，`set --unattended=true`退出0，偏好`ForceDaemon=true`复读通过。不接收DNS/子网路由，不设置出口节点或广播路由。
- 先保存Windows防火墙快照，再新增唯一专用规则：只允许管理Mac `100.121.26.69` 经Tailscale网卡到新机 `100.100.177.27` 的TCP22，且限定现有sshd程序；原公司LAN规则保留。没有开放公网路由器端口或修改tailnet全局ACL。
- Tailscale ping成功、TCP22通过，ED25519指纹与新机LAN已核对指纹完全一致；严格指纹验证下SSH认证成功，远端返回新机hostname和Administrator身份。测试走Tailscale虚拟地址，底层当前为同公司网直连，尚未实测回家后的网络路径。
- Agent主进程14508、共享ADB8988保持，SYSTEM/固定SDK/5037单监听及原config/preload哈希不变。未重启原服务、Windows、ADB、USB或媒体；未改变ADB授权。

完整配置、哈希引用及验证见 [receipt.json](receipt.json)。Tailscale节点授权现到期时间为北京时间 **2027-04-17 14:14:23**；保留原账号默认到期策略，没有关闭到期校验。服务自启和无人值守配置已验，没有为测试强制注销/重启正在使用的新机。

## 回退与版本

从原LAN SSH进入后，可单独删除 `PhoneCloud-Tailscale-SSH-Management` 并按需停用本次Tailscale；不要整份导入防火墙快照覆盖后来规则。原安装包与安装日志、启动前防火墙快照保留在 `D:\PhoneCloud-Migration`。

本轮自审仅主文档及回执，JSON/链接/差异检查通过；没有应用代码改动，不重复业务回归。原脏工作区保留，独立分支提交及annotated tag，未推送。配置验收已完成；全量手机在线恢复仍是独立未完成事项，不由本次VPN连接成功替代。

取证中的一次Python默认GBK解码失败已改成显式UTF-8读取，复读得到ForceDaemon=true；失败仅影响检查输出，没有改变设置。
