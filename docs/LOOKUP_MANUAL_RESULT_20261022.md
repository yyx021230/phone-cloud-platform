# 2026-10-22 四条原订单人工回填回执

## 授权与基线

用户明确要求“订单号码先填上姓名，手机不查这个号码接后面的订单”。本轮只处理112/162/156/181对应的四个原lookupId，依据已读画面逐条对照完整手机号和显示名；保留遮蔽字符，不推断完整实名，不把人工结果标记为脚本识别成功。此前误按恢复重试各执行一次，未解除卡点；用户澄清后停止继续发起重试。

业务部署仍lookup-throughput-20261022-deployed.1/95725513；运行的`managed-lookup.mjs` SHA256 `48e1081af382f1198d1067d6577ae3043950fb10e6bb4beead3ec22aff12f15c`，platform adapter `18854d027d0a4622812a1feea58f9e17ab2545fc129587464a1d476747927d94`，与本地用于验证的既有生产组装版一致。未替换任何业务代码/镜像。

操作代码提交`a25d666`，不可变标签`lookup-manual-result-20261022-rc.1`。发现原共享工作区被切换到另一个分支后，保留全部提交，转入独立`codex/lookup-manual-orders-20261022` worktree继续；未重置/改写其他分支。主文档、共同流程与冻结约束继续适用。

## 方法与实际验证

独立操作脚本默认只预览，通过数据库既有行锁序列化四条修复，不覆盖其他订单/会话/账户。仅写托管原单的姓名、完成状态、人工来源和审计；保留原订单、查询证据和手机号身份。物理任务沿用当前协调器安全停止，旧预约到真实ACK后才释放；不伪造Windows任务完成/ACK，不清锁，不改账户冷却。

14项本地测试通过：输入绑定/忙碌/未知/已完成/取消/轮次停止/重复/缺证据拒绝；原单可读、正常协调器停止一次、ACK前保留预约、迟到结果不覆盖；已安全转交排队的原单要求当前最后attempt精确匹配。命令：`LOOKUP_RUNTIME_DIR=/tmp/pc-lookup-unavailable-verified-20261022 node --test scripts/ops/lookup-manual-result.test.mjs`。节点语法与git diff检查通过。不是全量回归或自动识别修复验收。

四条合并预览首次因162原单已自动增加一次118尝试而拒绝，全事务未写。随后先预览112/156/181三条成功，再以`wx`、0600、fsync保存三条原记录后提交。162最新尝试已失败并回queued、没有物理channel；核对相同原号码及最新attempt/session/device后单独预览、备份并提交。不会把旧画面绑定到其他号码。

## 生产结果（北京时间）

- 16:05:08：112/156/181原单人工完成，既有协调器请求停止各自物理尝试。
- 16:05:33：162原单人工完成；此时已安全转交并回queued，无旧channel，无需再启动号码查询。
- 16:05:56：四条原单均succeeded，原channel均已消失；本轮54条完成、15条排队。112/156/181开始新的准备探测，162为新探测拼图。health/ready正常。
- 16:06:18：四条均已归档；逐项核对姓名与人工输入一致、来源operator_verified_screenshot、证据SHA256一致。
- 16:07:26：完成总数从54增至56，118/112/181正在执行3条不同于人工回填原单的业务，156仍探测、157准备；另4条旧队列已lookup_queue_timeout，剩6条queued。没有自动重开这些已超时请求，也不宣称整轮无异常。

这是人工订单结果和占用修复。未宣称自动页面识别已解决，未把新的探测当成后续业务已查完；仍有拼图与准备耗时。

## 备份、审计与回退边界

原值备份先保存到运行容器私有临时文件，再复制到本机权限受限目录：`/tmp/pc-live-observe-20261022/manual-original-three-backup-private.json`及`manual-original-162-backup-private.json`。包含业务信息，不入Git，不通过文档分享。输入和原图同样只留私有目录。

本次只改四条原单，不存在应用版本回滚。若人工结果发现有误，应凭该原值/原图做新的精确纠正并告知对接方；不能恢复整行旧池状态覆盖后续业务，也不能把已返回外部的结果假定为未被读取。已完成结果保留人工来源，不能改写历史Agent失败为自动成功。

本轮未重启云端、共享Agent、Windows、ADB或媒体，未切SYSTEM身份、未修改ADB密钥/端口/路径/驱动。旧版本和未知未提交工作保留。

## 脱敏证据哈希

- `manual-fill-three-receipt.json`：`dae11148ab3962f9ddae180f18e5d0b424ed2d59c73bf8fbea1ff538d655c564`
- `manual-fill-162-receipt.json`：`55c81a482e3af1312860f46912d03a54b91f6e5bd64a2b95bd4b0daba70dbc36`
- `manual-fill-archive-verification.json`：`dc0334d5d66e404ce435edabaac3d0f923ae8a720cb1b77e703e932401b77384`
- `manual-original-three-backup-private.json`：`66845aa12abb161a1ca083ff002af931a516e575bfee593ee7d25be340b390ff`
- `manual-original-162-backup-private.json`：`1330b7b72d9819fd7e6652def23630ebe76e644a705bab54160c037d7f5b2f82`
