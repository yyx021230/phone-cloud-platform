# A片job/hold正负四组源码，PG未执行

基线c15a85aecd7af499709ecbdc595072f1ede919b8，仅本verification+文档。4组job-negative/job-guarded/hold-negative/hold-guarded；不改已验comparison/新提案SQL、产品/M1/M2/M3/DDL/shared。沿已验task fixture的A实际M3完整5DML拦COMMIT、B raw查询、C第三owned backend真实active/Lock/blocking PID后放提交，保留预算/有界finally清理。

job负例逐当前generic列/SET/旧timestamp谓词，alias/RETURNING仅为验证；同jobId的旧queued JSONB没有claim，updatedAt2099严格晚A，预期1行覆盖/M3conflict。正例用已固定guardedJobUpsert，必须0行/rows[]、最终full JSONB深等A automationJob/claim完整/M3recorded。

hold负例使用同binding/obligation/immutable关联的A真实hold候选副本，仅statusreleased/updatedAt2099；expiresAt仍空串、SQL expires_at绑定NULL，不造v1 binding或过期时间。预期冲突INSERT等A后1行更新released/M3conflict。正例沿原guardedHoldUpsert，必须0行/rows[]、最终完整cleanup_pending/nonexpiring/binding/M3recorded。每组都核SQL行status与JSONB一致、ledger claimData和anchor active义务未变；负例不等于物理手机真的释放。

hold等待可能是unique/transactionid锁，不假设row锁细名；只接受真实active/Lock与pg_blocking_pids含精确A。保存A/B/C PID、A xid/snapshot、B backend_xmin/query_start、控制顺序、RETURNING值/规范JSONB hash、最终role/status/binding/SQLexpiry与M3重读；没有sleep猜测，backend_xmin不冒充完整B snapshot。失败仅留attempt，只有断言结束才有case，最终仍以TAPexit0为必要条件，不拿note计通过。

唯一拟执行入口（当前未调用）：

`python3 -I -B verification/wecom-v2-job-hold-epq-20261102/run-owned-postgres.py --execute-reviewed`

运行器从已审task EPQ原字节最小复制，仅新root/marker/expected四组；无flag/其他flag exit2，非root且无Linuxcap，先核13固定source与6既有pg关键依赖及固定PG16.15/Nodev25.9.0/pg8.22。前后hash需同，不自动更新/重试。无npm install、DATABASE_URL/PG*/NODE_OPTIONS继承。

新/private/tmp/pc-wecom-v2-projection-pg-* 0700、marker owned-loopback-wecom-v2-projection。owned helper精确lstat/realpath/uid/mode、postmaster.pid根/PID/口/Unix socket，连后核data_directory/user/database/port/fsync/sync_commit。只在新库建4合成表和原M2/claim DDL，无IF NOT EXISTS，不连接任何旧库/生产。

固定/opt/homebrew/bin PG四binary --version16.15与Node --versionv25.9.0（各5秒，只有显式入口后才探测）；initdb新根/db trust fixture15秒、createdb只新Unix socket；直接原Popen postmaster只loopback随机>=20000+新socket0700，fsync/sync_commit/full_page_writes on/max_connections12、ready10秒。父env仅PATH=/opt/homebrew/bin:/usr/bin:/bin、LC_ALL=C、LANG=C；Node另fixture root/port。

Node固定--test --test-reporter=tap+本integration总45秒；M3原2/3/5秒事务，B2500ms，C150ms每query/32轮800ms，A gate3秒，fixture waits2/5/3秒，finally有界释放A/B/C。仅原Popen未回收session可TERM/KILL、已回收PID不重杀、PG仅原Popen SIGINT等待10秒exit0；失败留新库/raw，不碰旧库。只有Node0+4唯一case+前后源同+组消失+PGexit0全确认才删该成功db，日志receipt保留。

实际只6 runner guards、2实际四seed命名/重名反例、AST/JSsyntax及13源/6依赖只读核对。四组SQL尚未解析/执行，不与task旧4/M3 18/兼容14+2/策略64累加。本片不验证原business无marker、delivery/controlled progress持久op回执、blob/boot/lookup canonical或跨业务admission，更不是真机；原43设备义务/147/52、查名池与所有冻结保持，无Windows/设备/生产动作。
