# M3a私有PG运行器待审稿（未执行）

产品固定215fb15b7a66df99dc2b1991c6e9be93d5c103a8 / wecom-v2-claim-postgres-20261102-rc.1。root独立67回归结论8642e42ed376a6b0cd3924379273189a99c3a0ab。本片只新增verification，产品/DDL/主号分身手机和生产均不动。

唯一拟执行入口（**当前没有调用**）：

`python3 -I -B verification/wecom-v2-claim-postgres-20261102/run-owned-postgres.py --execute-reviewed`

无参数/其他参数直接exit2，不读源、不运行PG/Node版本命令、不建目录/端口；本地6项guard已实际验证。允许入口仍须root审当前固定commit/tag/18源manifest与6个既有pg依赖关键源hash，旧M2 runner授权不适用。运行前后源和依赖hash一致才计通过；不自动修manifest/重试。

运行器从M2已审073886ee运行器最小复制为本片专用，不修改原件。新根必须/private/tmp/pc-wecom-v2-claim-pg-*、0700、当前非root用户/非capability；新marker kind owned-loopback-wecom-v2-claim，旧M2根不会通过新guard。唯一外部只读依赖是既有node_modules/pg8.22.0（package/client/query/connection/pg-pool/parser六源hash固定）；不安装依赖，不读DATABASE_URL/PG*/NODE_OPTIONS。

固定二进制/命令与预算：/opt/homebrew/bin/{postgres,initdb,createdb,pg_isready}必须16.15，/opt/homebrew/bin/node必须v25.9.0；仅这些--version在显式入口后、创建根前执行，5秒。initdb -D新根/db -A trust -U wecom_v2_fixture --no-locale，15秒；空测试口令只在新私有库中使用。直接Popen自有postgres -D新根/db -h127.0.0.1 -p随机>=20000 -k新根，socket0700、fsync/synchronous_commit/full_page_writes=on、max_connections12；10秒ready循环只走新Unix socket。createdb只在该socket创建wecom_v2_host_fixture。无pg_ctl、服务、共享5432、PG环境、生产地址。

父进程env只有PATH=/opt/homebrew/bin:/usr/bin:/bin、LC_ALL=C、LANG=C；测试Node另加WECOM_V2_FIXTURE_ROOT/PORT。Node argv为固定二进制--test --test-reporter=tap +本片postgres.integration.mjs，无用户argv/路径覆盖。Node父组总45秒；query_timeout6000ms、连接2秒、每事务lock_timeout2秒/statement_timeout3秒/idle5秒；proxy沿已审64KiBframe/128KiBbuffer/128事件/8连接/10秒idle，记录命令类型与真实COMMIT/ReadyForQuery元数据，不记录SQL/Bind业务文本。

owned-pg入口先检查根lstat/realpath/owner/mode、私有marker、postmaster.pid精确根/PID/口/Unix socket，process.kill(pid,0)仅存在查询；连库后再次核data_directory/port/user/database/fsync/sync_commit，再执行**私有合成表DDL**、M2原DDL及新claim.sql。没有production初始化器，合成设备显式插入并从真实私有device表取投影；合成ready不证明生产映射屏障。

18项独立TAP测试/证据group：basic-main、basic-clone、same-physical、different-physical、mapping-missing、mapping-disabled、mapping-rebind、duplicate、legacy-and-uniques、write-rollback、commit-after、commit-before、progress、regression、old-lock-orders、read-only-reconcile、ddl-negatives、client-context。**18是未执行测试设计，不是通过数量。**部分group内逐写点/字段多个断言，不再累加成更大测试数。原M2 PG14未重跑、也不累加；新legacy group仅验证M2 NULL/host操作窄兼容。

主要证据：不同task主分身相同serial两独立backend同anchor至多一成功，另一busy/NOWAIT拒绝；两个业务原锁只是合成旧记录，本片不验证旧API入队许可。不同serial在另一anchor真实持锁时提交。两旧锁序用实际合成表事务交错，job→task实际等待新叶已持task，新叶NOWAIT job退出释放，让旧第二把锁完成；另一task→job也实际取两把锁。未导入或执行完整生产checkpoint函数，不冒称其所有副作用已覆盖。

五条DML各测实际SQL触发器拒绝，以及RETURNING0行伪响应导致真实事务整体回滚；完整tuple/业务锁释放/状态分歧/M1revision1、2/投影回退或缺失；ledger FK阻止删除不伪造缺行。DDL逐必填/NULL/额外键/日期/类型/binding及两个独立唯一索引反例。COMMIT真实后端唯一COMMIT+I+无ErrorResponse才截回复；新独立backend只SELECT/SET/ROLLBACK对账，五DML仅一次；COMMIT前截断和上下文变化都不重写。typed故障observer只容许first fault client/真实wire/另1个产品listener，非目标错误和idle pool错误仍抛，不能吞错伪绿。

失败保留新库/全部日志/原hash，不重启它、不自动第二次尝试。Node仅操作当前Popen未回收自有session，确认exit/groupAbsent；已回收PID不重杀。PG仅原Popen.send_signal(SIGINT)，等待10秒exit0；不杀未知子进程。仅TAP0+18唯一case+源前后不变+Node组消失+PGexit0时删除**该自有成功db目录**，原件与receipt留存；旧M2失败库/private/tmp/pc-wecom-v2-pg-3mrc7nik不读取/重启/删除。

当前实际只运行6个runner guard、8字节协议+7 typed observer（合15）、JS syntax和只读18源/6依赖hash匹配；未启动PG、连接数据库或执行SQL。本方案不包含Windows、手机、ADB/SYSTEM/密钥/Agent、媒体或生产变更；原43/147/52和155/157池保持。产品输出仍无执行许可，完成该私有库阶段也不算真机验收。
