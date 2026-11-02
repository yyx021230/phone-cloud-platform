# S1b最小task EPQ三对比 + target SAVEPOINT（4组未执行）

基线ad4bc2ec55b35f77755ba2bf3361e5a5c633e0cf，root24b8d5b限定只verification。未改comparison-queries或任何产品/DDL/shared writer。这里只准备新fixture/owned runner，不是SQL修复已上线或真实writer共存通过。

4组：unsafe-not-exists、guarded-update、guarded-upsert、target-savepoint。前3组用**实际未改M3 repository**领取，adapter只在底层COMMIT发送前暂停，原6步读/5DML/完整RETURNING均照旧；捕获5DML数、A backend/xid/snapshot和COMMIT尚未转发事实。B与控制C预先预留，均是本cluster实际独立backend。

B发送原comparison查询及绑定参数，候选updatedAt固定2099，严格晚于A真实候选时间，排除只靠旧timestamp条件拒绝。第三C必须观察B active/Lock、pg_blocking_pids精确包含A，带backend_xmin/query_start/读次数/耗时，才放行A COMMIT。没有sleep或事件循环猜测；C最多32次/800ms且每查询150ms。backend_xmin是服务端观察值，不声称完整导出了B statement snapshot；语句开始→真实等待→A提交的顺序由实际阻塞及控制门保证。

负例明确期望B旧NOT EXISTS覆盖1行/返回1行，最终JSONB等于旧候选、M3 fresh reconcile conflict；如果实际不同则测试失败保留，不改断言“绿化”。两正控制必须rowCount0和rows[]，最终task JSONB深等A已审纯claim候选、wecomV2Claim/physicalCleanup完整、原claimData不变、M3 reconcile recorded。记录SQL hash、三个PID、服务端proof、返回行关键字段/JSONB规范hash及最终值/hash。原始完整业务字段不打日志；均为合成数据，无真实手机号。body case与attempts分开，未完成断言只留attempt，不当通过。

target-savepoint组：holder实际锁device1 anchor，writer BEGIN/SAVEPOINT后NOWAIT SELECT必须真实55P03；仅ROLLBACK TO/RELEASE该savepoint后，同一writer backend继续device2 anchor/guarded UPDATE、RETURNING核值并确认真实COMMIT。再新建独立Pool/backend（PID不同于writer/holder）复读device1未变和device2已提交。只接受具体55P03，其他SQL/连接错误或COMMIT未知测试失败，不假称其他目标成功。此组不创建v2 claim，也不证明完整业务coordinator。

唯一拟执行入口（**当前未调用**）：

`python3 -I -B verification/wecom-v2-task-epq-20261102/run-owned-postgres.py --execute-reviewed`

运行器最小复制已审M3 owned runner，仅新prefix/marker和expected4 case；不修改原runner。无flag/其他flag exit2、非root/无Linuxcap、先核12固定source+6既有pg关键依赖，固定PG16.15/Nodev25.9.0/pg8.22；唯一只读外部依赖现有node_modules，不安装/升级。前后hash相同才计通过。无DATABASE_URL/PG*/NODE_OPTIONS继承。

新/private/tmp/pc-wecom-v2-epq-pg-*，0700，marker owned-loopback-wecom-v2-epq；owned helper精确lstat/realpath/uid/mode、postmaster.pid、PID/根/端口/Unix socket，连后核data_directory/port/user/database/fsync/sync_commit。只在新库建4个合成表并应用原M2/claim DDL，无IF NOT EXISTS，不连接任何旧失败DB或生产。

固定/opt/homebrew/bin PG四二进制--version须16.15（各5秒），node--version须v25.9.0；initdb新根db trust fixture用户15秒、createdb只新Unix socket、postmaster直接原Popen loopback随机>=20000/socket0700，fsync/sync_commit/full_page_writes on/max_connections12、10秒ready。无pg_ctl/5432/服务/global kill。

父env仅PATH=/opt/homebrew/bin:/usr/bin:/bin、LC_ALL=C、LANG=C，Node另两个fixture root/port；Node固定--test --test-reporter=tap +本片integration，总45秒。M3沿原2/3/5秒事务限制，B语句2500ms，C150ms/最多32轮800ms，A gate3000ms，fixture wait2/5/3秒并有finally释放；SAVEPOINT writer3秒。任一失败保留新db/raw，不自动重跑；原Popen子session退出/groupAbsent确认、原PG SIGINT10秒exit0确认，只有Node0+4唯一case+前后源同+cleanup全确认才删该成功db。旧库全不读/重启/删。

当前实际只有6 runner guards、2真实seed命名/旧namespace碰撞反例、AST/JSsyntax与12源/6依赖只读核对；**4组SQL未解析或执行**。本片未测试job/hold/business无marker/custom delivery/control-owner进展、blob/boot、lookup wait canonical、跨协议admission、S2/journal/native；不得把task窄marker控制称完整门禁或真机验收。原43设备清理义务/147/52、查名池和所有冻结保持。
