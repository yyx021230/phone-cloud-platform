# PostgreSQL测试器启动失败诊断补充

2026-11-02；后续测试器修正，不修改产品候选6d2b271及其既有标签/文件哈希回执。

独立复核窗口首次自建集群在pg_ctl start阶段退出1，未进入产品测试；旧runner的finally删除临时目录导致初因日志丢失，不能将该次失败归为服务端产品问题。

现在pg_ctl start失败先把本次独立集群日志最后64KiB输出到调用者捕获日志，再抛出原失败并清理自己的临时目录。日志不存在时明确报告缺失，仍退出失败，不猜测根因。

`python3 verification/wecom-cleanup-v1/test_postgres_runner.py`：2/2通过。两个合成反例分别验证原失败原因在清理前输出、日志缺失明确失败；确认临时目录清理。fake命令不会启动PostgreSQL、读取生产配置或访问手机。没有重跑1858项产品回归，也不改变已有PG通过/未验边界。

独立窗口随后取得初因：macOS PostgreSQL 16在仅PATH环境出现`postmaster became multithreaded during startup`，提示需要有效LC_ALL。测试器现为所有PG子进程显式设置LC_ALL=C、LANG=C，不依赖调用者locale，不修改主机配置。fake负例同时核对locale，2/2通过；仅PATH父环境真实重跑三种PG模式各1/1通过，日志`/tmp/pc-wecom-cleanup-pg-path-only.log`。这是测试环境修复，未改变服务端产品6d2b271或旧回执hash，不重跑1858项无关产品回归。
