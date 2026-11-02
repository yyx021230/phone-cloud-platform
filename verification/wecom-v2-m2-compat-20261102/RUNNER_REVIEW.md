# M2完整14 + 新claim DDL兼容候选（未执行PG）

基线4d3113367e1722fbed641444614a028c4eea3796；S1纯策略rc.2是独立阶段，本片不改任何产品/DDL。此前旧M2实际PG14是在新claim列加入前验证，新M3实际18里的legacy窄案例不能代替此项。这里只准备两个独立Node阶段和固定自有新库runner，不执行SQL或启服务。

第一阶段postgres.integration.mjs：从073886ee24a8613598d90f68a87ffbdee8b9e460所固定原M2源码逐字复制，唯一变化是在before的原M2 DDL之后追加应用新claim DDL一行。所有imports/helpers/11个test声明（含4组合展开成14案例）字节不变；M2_BODY_HASHES列14个案例hash及shared proxyCase hash，全文去掉唯一setup行等于原件。复制fixture/proxy/observer/readback-child原字节，owned-pg只改专属新root前缀和marker；不改旧目录或产品。不加IF NOT EXISTS/不改DDL来凑绿。

第二阶段claimed.integration.mjs：在同一新私有库、第一Node完整退出且组消失后，再启独立Node。新增合成task/job/device/lock表，原M2/newclaim表已由第一阶段初始化；2项独立主号preview/clone send-data案例，M3真实claim后由**未修改M2产品repository**提交host与host-closed，再由M3完整tuple重读。核原claimData不变/M1revision1→2/所有protocolPermit=false。host事实只是合成数据，不是Windows/SDK来源证明，没有真实发送或手机动作。

唯一拟执行命令（当前没有执行）：

`python3 -I -B verification/wecom-v2-m2-compat-20261102/run-owned-postgres.py --execute-reviewed`

无flag/其他flag exit2，在执行前拒绝；非root且Linux无capability，读21个固定source与6个既有pg关键依赖hash，固定pg8.22.0/Nodev25.9.0/PG16.15；运行后再次核源。没有npm install/依赖升级或运行时路径覆盖。共享pg仅只读载入，禁止DATABASE_URL/PG*/NODE_OPTIONS继承。

隔离根/private/tmp/pc-wecom-v2-compat-pg-*，0700，marker owned-loopback-wecom-v2-compat；新owned helper验证lstat/realpath/uid/mode、该marker、postmaster.pid精确PID/根/端口/Unix socket，连后核data_directory/port/user/database/fsync/sync_commit。旧M2/M3失败库和现有5432不读/不启/不删除。

固定命令：/opt/homebrew/bin/{postgres,initdb,createdb,pg_isready} --version须16.15，/opt/homebrew/bin/node --version须v25.9.0（仅显式flag后版本探测，每项5秒）；initdb新db trust fixture用户、createdb新socket上的专属测试库；自有直接Popen postmaster只loopback随机>=20000和新Unix socket0700，fsync/synchronous_commit/full_page_writes on、max_connections12。没有pg_ctl/服务/全局杀进程。

父env仅PATH=/opt/homebrew/bin:/usr/bin:/bin、LC_ALL=C、LANG=C；Node另加WECOM_V2_FIXTURE_ROOT/PORT，readback子Node沿原14 body的固定清单继承。第一Node固定--test --test-reporter=tap +postgres.integration.mjs，总45秒；确认第一Node退出/组消失后第二Node同flags +claimed.integration.mjs，总15秒。两阶段串行最多60秒Node预算，另init/ready/cleanup有界；query_timeout6秒、connection2秒、事务原2/3/5秒，proxy沿原64KiBframe/128KiBbuffer/128事件/8连接/10秒idle，不放宽。运行器源码确切argv/env在文件中可审。

第一阶段必须Nodeexit0+原14唯一body evidence；第二必须Nodeexit0+2唯一claimed evidence；前后源码/依赖hash匹配及两Node组消失/原PGexit0确认后才算整轮成功，分别记录actualM2PgCases14与actualClaimedCompatCases2，不把它们或历史M3 18累加冒称生产测试数。第一阶段通过但第二失败则保留部分14事实/整轮失败原件，不自动重试到绿。

仅未回收的原Popen自有session可TERM/KILL；已回收PID不重杀；PG仅原Popen SIGINT等待10秒，不全局处理未知子进程。失败保留新库/raw，不重启原失败库。成功只在所有确认后由runner删该成功db目录，保留RUN_RECEIPT/PG_EVIDENCE/CLAIMED_EVIDENCE/两份Node日志及初始化日志。fixture.json中新PG PID与实际根绑定。

当前实际只有4项source等价/反弱化测试、6 runner guard、Python AST/JS syntax和21源/6依赖只读核对；14与2均未运行。原14 source/body hash固定但不把静态等价当PG通过。没有共享writer、配置映射屏障、journal、Windows/ADB/Agent/媒体/手机或生产动作，原43设备义务与查名池保持。
