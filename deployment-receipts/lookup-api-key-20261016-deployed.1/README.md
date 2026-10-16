# 单 API Key 已发布（真机灰度进行中）

2026-10-16 14:04:52（Asia/Shanghai）完成云端切换。版本 lookup-api-key-20261016-deployed.1，候选 lookup-api-key-20261016-rc.2 / ce5d20b693d84049ca534e8743a3c0cd0aa86566，运行代码9f6951f，镜像33af4227。部署前运行b5479d9c+静态覆盖，下次启动/回滚镜像03b6928a。本轮用户先批准54/60/162，门禁检测138/69新增后停止，追加五路明确批准后才切换；最新备份后再次核占用通过。

## 已验证

- 824本地回归、23客户端测试和121秒换8请求键防重沿用候选证据；模拟不代表真机通过。
- 35个组合运行hash、11个公网静态资源hash与公开下载代码一致；health/ready正常。
- 原客户旧HMAC公开GET未知任务404；新Key坏值401、正确Key未知任务404；混合头、管理API访问401。
- 原客户配置仅追加apiKeySha256，权限、设备池revision55与旧secret不变。实际Key通过受限本机内存生成并复制用户剪贴板，公开代码不内置Key。
- D-075真实媒体宿主机前后live通过、PID2503525不变，8Mbps/2包。Agent未重载，131台总设备/117在线，生产Agent心跳恢复；未使用Windows SSH或任何ADB命令，SYSTEM与授权配置未修改。
- 数据库备份496061359字节，完整pg_restore解码通过；SHA见DEPLOYED.json。未迁移、未恢复整库。

## 回滚

受限生产备份：/opt/phone-cloud-platform/deploy-backups/lookup-api-key-20261016-prep.1；含.env.before、ACTIVE.before.json、14文件/Compose、旧镜像tar及两次数据库备份。恢复前先核当次ACTIVE/配置与占用、确认维护范围。采用ACTIVE.before.json中的完整Compose链（移除本轮pending覆盖），恢复原客户端配置，仅重建phone-cloud到03b6928a；不得使用根旧业务镜像，不重启Agent/ADB/Windows/USB/媒体。若.env有后续修改先停，不覆盖并行变更。回滚撤回单Key，旧HMAC继续；业务任务已落库，不自动恢复整库以免丢后续数据。核health/ready、旧文件hash、D-075 live与实际镜像，并另记回滚回执。

## 未验项

本轮外部HTTP真实prepare/提交/结果测试正在进行；此前冷却/跨机/五台并发等生产缺口不能被本地模拟或新鉴权测试替代。线上全平台验收未宣称完成。根旧脏仓及其他工作保留，无推送。
