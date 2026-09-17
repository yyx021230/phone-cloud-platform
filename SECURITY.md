# Security

请不要在公开 Issue、提交或日志中包含生产密码、令牌、Cookie、私钥、真实手机号、设备序列号或内部网络地址。

部署时应：

- 为数据库、管理端、Windows Agent、设备 Agent、媒体签名和 Open API 分别生成独立随机凭据；
- 只通过 HTTPS 暴露平台接口，并限制可信来源；
- 将 `.env`、`windows-agent/config.json`、签名 keystore、日志、状态数据和证据目录保留在私有环境；
- 定期轮换凭据，并在疑似泄漏时立即撤销。

公开报告安全问题前，请先通过仓库维护者提供的私密渠道联系。
