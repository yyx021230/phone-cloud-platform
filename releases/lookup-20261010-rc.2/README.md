# 查名候选 rc.2

基于不可变 `lookup-20261010-rc.1`，修复“切号后遇拼图/普通异常丢失账户状态”和“原号码恢复后切号次数归零”。运行代码仅改3份；此前17份生产差异、31个Python兼容方法与22份冻结文件继续保留。仓根旧业务文件不属于本候选。

实际通过：定向35项，完整回归594项、Agent289项、Python163+56项、SDK4项及语法；各入口有重叠。隔离真实PostgreSQL验证失败事务/原报告重传、两次同结果恢复与进程重启后累计次数保持2。该故障组合尚未在rc.2真机重演，生产未发布。

[版本](VERSION.json) · [更新说明](RELEASE_NOTES.md) · [测试](verification/TEST_RESULTS.json) · [文件哈希](verification/MANIFEST.json) · [生产最小差异](verification/production-to-merged.patch) · [相对rc.1差异](verification/rc1-to-rc2.patch)

复验：`python3 verification/verify.py /Users/yyx/ztqc/phone-cloud-platform`，参数为已有依赖目录。脚本在临时副本清除业务环境执行；不加载真实账户、设备或通知凭据。沿用原依赖，未验证全新安装。

只交付源码候选，不整目录覆盖生产。发布需云端和Agent配套，混版不保证修复；保留数据/回滚点与D-075。rc.1标签和源码未改，rc.2新增提交/annotated tag，尚未推送或发布。
