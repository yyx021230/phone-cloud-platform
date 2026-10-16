# 完整客户端示例交付记录

- 日期：2026-10-16；状态：本地可交付示例，未发布线上文档/下载包。
- 任务：给外部开发提供只用三接口的完整运行代码；不改变平台、Agent或调度行为。
- 工作区：`/Users/yyx/.codex/worktrees/lookup-version-management/phone-cloud-platform`。
- 分支：`codex/lookup-client-example-20261016`；起点：`e9bdae4e00e46df222e361fbb08203fe328a5dc5`，起点干净；原根仓既有工作保留。
- 交付标签：`lookup-client-example-20261016-rc.1`（annotated tag绑定本次提交）。
- 契约依据：已发布三接口文档`lookup-public-docs-20261016-deployed.1`，运行契约`lookup-readiness-20261016-deployed.16/a479fab`；核对组装候选`server/index.mjs`、`lookup-readiness.mjs`及既有SDK签名，未读取或改变生产状态。
- 规则：沿用已读AGENTS/完整主文档，本轮重读共同流程；共同流程2026-09-30 / SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。
- 范围：本目录4文件及主文档两行；没有改现有release快照、公开页面、服务端、Windows或媒体文件。

## 实际验证

在仓根、Node v25.9.0执行：

```bash
node --test examples/name-lookup/lookup.test.mjs
node --check examples/name-lookup/lookup.mjs
git diff --check
```

13/13通过，语法/差异检查通过。前12项注入fetch/时钟，只访问模拟响应；其中120秒为虚拟时间。第13项真实启动回环HTTP服务并两次启动CLI子进程，验证一次提交、状态落盘、退出码2→0、重启仅GET原结果、签名和不保存密钥/完整手机号。未运行生产API或真机测试；没有将本地验证称为生产全量验收。Node18兼容目标未在Node18运行时实测。

自审：只在completed且name为字符串时返回姓名；空姓名、执行失败、尚未完成有明确区分；幂等键在网络前落盘，重试签名nonce更新，状态绑定客户/地址/号码。文件锁限制同目录并行，异常杀进程留下锁时需确认后清理锁；正式多实例系统使用共享业务数据库。示例没有代替生产应用的持久化/运维设计。

## 文件指纹及撤回

- lookup.mjs SHA256：`3eba93f018a10116ddf46f51ba2f802e5e386b9ece96c4b73e47a7d3776f9f6e`
- lookup.test.mjs SHA256：`09ba267cd73e5e058c104c3ebc0b3899ba99605928578d90dcd5ac97d1525b78`
- README.md SHA256：`cfedf8727b4150dab82574e3141c708d0f5a54d42d156f148f001d53668ea1af`

没有生产变更需要回滚。撤回示例时停止使用即可；已执行业务的状态文件仍需保留，继续按原lookupId取结果，不删除后重新提交。
