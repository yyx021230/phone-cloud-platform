# B片原business lock四组源码，未执行PG

基线57a3f7a3c8d005472c0c0aa49636c9e27735207c，root33e72941只允许verification-local loader/fixtures/owned runner。新owner-fixture不是生产authorizer、handler或executor，实际caller/OS/journal及跨协议权限仍未实现。未改M1/M2/M3/S1 policy、comparison/SQL提案、产品/DDL/shared。

同一client loader沿anchor→task→job→physicalHold→originalBusinessLock→ledger NOWAIT精确列，另同client读配置device JSON；Date显式规范ISO/null、mapping_revision严格正整数字符串。S1只核给定normalized tuple结构/immutable关联，其writePermit/protocolPermit/canonicalSourceVerified始终false，不能作为授权。合成fixture context逐字段对实际claimData；候选仅可变status/updatedAt/releasedAt/releaseReason，**其余全部已知未知JSON字段完整保持**，不是只挑identity列表放过extra。expiry/createdAt只比本次fresh快照，不声称历史证明。

本地最终31项：owner/ID/slot/state/type/expiry/其他字段漂移、新未知字段/已知未知内容修改或删除等DML前拒绝，未变unknown字段保留。spy只用于验证拒绝前不发DML，不是PG执行。初29pass的源/日志/回执在initial-owner及原OWNER_LOCAL文件，新增两项证明同message driver错误不能冒充自有CAS0错误：私有WeakSet只认自己基于真实0rows/[]产生的冲突，任意driver错误原样传播。31与初29不累加。

四个未执行数据库组：

- unmarked-negative：实际原M3 5DML拦COMMIT，B不足marker UPDATE已发，C真实active/Lock/blocker精确A后提交；原business lock前后确无marker。候选只用合成other-owner制造关联错误，预期1row/M3conflict，全部独立physicalHold/ledger/anchor保留，不说手机真的释放。
- owner-status-known：实际M3已known claim后，B同TX loader→完整immutable/只active→released→whole JSONB CAS/RETURNING5列/row1；真实COMMIT并release后，才新backend复读和M3freshrecorded。原lock不添加marker，持久物理义务不变。
- target-nowait：holder实际锁f original business row；B目标savepoint中按完整顺序遇真实55P03，ROLLBACK TO释放该目标新锁后同B继续g合法CAS/COMMIT；先结束holder，再fresh独立backend核f不变/g released，再M3双重读。未知SQL/连接错误不等于55P03，断言失败使整组失败。
- target-cas-zero：f完整快照读取后由**fixture-only故障注入**在同TX实际加一JSON字段；按原expected JSONB CAS必须真实0rows/[]且识别自有冲突，ROLLBACK TO连注入回滚；g同B继续CAS/COMMIT，新backend复读f exact恢复/g生效，M3两目标recorded/独立义务保持。不伪rowCount，不把注入当线上事实。

已持anchor不能调用另开连接M3：fixture只在同client读取，ownerTransaction要求真实COMMIT tag、事务结束/client release标记后reconcileAfterEnd才开新连接；holder也先结束，避免把自己制造的锁冲突当业务失败。每组完成case与attempt分开，known COMMIT之外不记成功，不将现claim仍recorded当某progress已提交；progress op回执合同仍缺。

唯一拟执行入口（当前未调用）：

`python3 -I -B verification/wecom-v2-original-lock-verify-20261102/run-owned-postgres.py --execute-reviewed`

运行器从已审task fixture最小复制，只有新prefix/marker/expected4组，原Popen/预算不变。无flag/其他flag exit2；非root/无Linuxcap；先固定17 source+6既有pg关键源/pg8.22/PG16.15/Nodev25.9.0，前后hash须同。不安装依赖、不继承DATABASE_URL/PG*/NODE_OPTIONS、不自动更新manifest或重试。

新/private/tmp/pc-wecom-v2-business-pg-* 0700/marker owned-loopback-wecom-v2-business，lstat/realpath/uid/mode+postmaster.pid根/PID/口/socket核对，连接后核data_directory/user/database/port/fsync/sync_commit。只新库建4合成表与原M2/claim DDL，旧所有库不连接/重启/删。

固定/opt/homebrew/bin PG四binary --version16.15/Node --versionv25.9.0各5秒（只有显式入口后才探测）；initdb新db trust fixture15秒/createdb仅新Unix socket；直接原Popen postmaster loopback随机>=20000/socket0700，fsync/sync_commit/full_page_writes on/max_connections12、ready10秒。父env仅PATH=/opt/homebrew/bin:/usr/bin:/bin、LC_ALL=C、LANG=C；Node另fixture root/port。

Node固定--test --test-reporter=tap+integration总45秒；M3原2/3/5秒限制，negative B2500ms/C150ms/32轮800ms/A gate3秒，owner TX2s lock/3s statement/5s idle，fixture wait2/5/3秒，finally有界。仅原Popen未回收session TERM/KILL/已回收PID不重杀、PG原Popen SIGINT10秒exit0；失败保留新db/raw，成功仅Node0+4唯一case+前后源同+groupAbsent+PGexit0全确认后删该自有成功db，原件保留。

当前实际只有31本地候选/错误分类、6 runner guards、2实际六seed命名反例、AST/JSsyntax、17 source/6依赖只读hash核对；4组SQL均未解析/执行。不验证原非参与writer随后覆盖、delivery三path/controlled progress持久回执、blob/boot/lookup canonical/cross-admission、S2/journal/native，原43设备清理义务/147/52和查名池/冻结保持，主号分身真机未验收，无Windows/设备/生产操作。
