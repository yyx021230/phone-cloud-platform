# 私有PG运行器/COMMIT代理：待审固定源码，尚未启动

基线M2 rc.2 3c37362ec071caf050628636d44c73afabfdd46a；分支codex/wecom-v2-pg-runner-20261102。先前两个未跟踪proxy/parser源属于本任务，完整保留并在此补齐，不混入已固定rc.2。当前只新增verification源码/证据与主文档，不改产品模块、M1/v1/DDL/index/Agent/依赖。root审下列具体源/manifest后才执行。

唯一实际启动入口（现在**未运行**）：

```sh
python3 -I -B verification/wecom-v2-cas-m2-20261102/run-owned-postgres.py --execute-reviewed
```

不带精确参数返回2，且在任何目录/版本命令/服务启动前停止。普通server测试不会匹配postgres.integration.mjs，模块import本身不监听代理端口；只有上述私有fixture启动后才会调用实际连接。RUNNER_SOURCE_HASHES固定11源（含runner自身、M2 rc.2、M1、DDL及fixture），共享pg package hash/8.22.0和本机Node精确版本；源或依赖变化先拒绝，不更新manifest自救。无安装/升级或共享node_modules写入。

## 环境、作用域与进程归属

- 非root；Linux若有/proc还要求CapEff=0。固定Homebrew PG工具16.15、固定Node，版本变化拒绝。仅minimal PATH/LC_ALL/LANG传子进程，Node额外两项是本次新建root/随机端口；不继承DATABASE_URL、PGHOST、NODE_OPTIONS、用户凭据或配置。没有HOME/CODEX_HOME改写。
- mode0700的全新/private/tmp/pc-wecom-v2-pg-*，不存在的db目录，initdb仅该新目录/fixture角色；不用旧库/共享5432，不自动启Docker/Homebrew服务。PG为直接Popen自有子进程，stdin DEVNULL、新session；listen127.0.0.1随机>=20000端口及该私有目录Unix socket。fsync/synchronous_commit/full_page_writes显式on；bootstrap isready/createdb仅走私有Unix socket。
- 核Popen PID与新postmaster.pid的datadir/port/socket，创建fixture marker。Node再查root uid/mode/非symlink及marker；只用显式loopback/fixture数据库配置，DDL前实际核PG data_directory/port/user/database与fsync设置。这些是测试入口误用防护，不是对恶意同用户代码的OS安全认证，也不赋予生产身份/时钟权威。
- Node测试单独新session/Popen，45秒上限；自有命令先记录argv/PID后等待。只有原Popen child尚未reap才给其自有新session发信号，PID保留期间避免复用；已退出group只探测、不再杀。Node readback child在该自有组里。PG只向原Popen postmaster发SIGINT并等待，禁止pg_ctl共享操作/pkill或未知后代清理。
- 只有测试exit0、14个唯一案例证据、Node组消失和PG exit0全部确认，才删除本次db目录；原始日志、PG_EVIDENCE、命令/PID/清理回执留在私有root。任一步失败/超时/清理未知均失败并保留本次目录和原始日志，不删除失败数据库、不猜已恢复、不影响既有数据。没有全局进程/USB/ADB/Windows动作。

## 真正的COMMIT丢回复证据

pg-commit-proxy只监听loopback随机端口并转发到本实例的>=20000固定端口；最多8条连接、每帧65536/缓冲131072、最多128条有限元数据事件、socket10秒空闲界。日志不保存SQL/Bind/凭据，只计固定命令类型和连接号。模式仅fixture before_commit/after_commit，无产品fault开关。

after模式转发真实COMMIT后拦住其全部返回字节，必须实际收到唯一CommandComplete(tag=COMMIT)、ReadyForQuery=I、0个ErrorResponse，才记commitConfirmedFromBackend；ROLLBACK、E、T、无C或多个C都不能成为正例。随后断开自有socket；产品得到未知，必须销毁旧client、在max1真实池新checkout/新backend对账。独立直连查实际行并核原operation，代理计数确认只有1次原UPDATE/INSERT。初始化与操作各配epoch/malformed四场景，在真实后端确认后、断回复前改变合成provider，产品仍返回commitKnown=false，不能借代理知道的结果伪造产品已确认。

before模式在COMMIT送到后端前断自有连接；独立读取旧revision，结果仍unknown且不重新写。代理close等待自有监听关闭和所有自有socket真实close事件，不能只看destroyed=true。这里只是隔离PG故障注入；不模拟手机/OS/时钟事实。

## 计划真实PG案例（14项均未运行）

基础初始化/归一去重/close/迟到host原结果；两独立backend在SELECT前barrier后同ID仅增一次、异ID同revision一胜；自有trigger拒写回滚；直接SQL的缺JSON字段/重复槽ID约束拒绝；一条行锁有界超时且另一义务仍提交；真实COMMIT后丢返回、COMMIT发送前断链、初始INSERT丢返回；操作/初始化各epoch/malformed四组合；新Node child读取已持久行但旧epoch在checkout前被拒。全部合成身份，不触发业务任务/号码/手机/发送或设备释放。

## 本轮实际验证

8项纯PG字节解析/COMMIT判定测试、6项runner入口/环境/源hash/已退出组不发信号安全测试通过，Python AST与新增JS syntax检查通过。没有监听测试代理、没有启动PG、没有执行DDL或真实CAS/断链用例；8/6不能当14真实PG通过，M2 30/M1 61/v1 50也不能相加冒充PG覆盖。两项普通argv拒绝子进程仅执行无参数runner并返回2。

实际源hash、工具命令/退出码见RUNNER_SOURCE_HASHES和RUNNER_UNIT_RECEIPT。审核通过后若运行失败，先固定该次原输出/回执，修成新候选再申请协调单次运行，不自行循环改参数直到绿。本候选没有上线、原生或主号/分身验收结论；原43/147/52、155/157查名池及冻结保持。
