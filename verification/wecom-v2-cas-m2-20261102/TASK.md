# M2初始本地候选：真实PG仍未验

基线85f5cc3f417d476a111978434514e8983d466ac3，分支codex/wecom-v2-cas-m2-20261102。root接受专属账本方案及M1两个纯导出后，本片只实现新repository、独立DDL、无服务单元测试。未启动PG、执行SQL或建立真实连接；后续固定runner/代理须交root审隔离和故障留存后才启动。共同流程2026-09-30 SHA256 0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b。

## 代码边界

- M1仅新增normalizeWecomV2HostRequest/validateWecomV2HostState两个包装导出，冻结新副本；原preparer/状态函数行为不改，原61回归通过。新API的非法字段、结构损坏、深冻结输入/输出在M2单元测试里验证。
- repository显式要求getPool、readAuthenticatedBinding、readParentInstanceFacts三个函数；无默认环境、预先prepared/UI权限布尔。原始请求/schema/认证/readyNonce在连接前拒绝，getPool异步返回后再次验认证再checkout。
- 单义务事务SELECT FOR UPDATE+revision CAS；重复action/opid按M1规范化全内容对照，返回持久的原操作候选，不能用当前close结果冒充原host结果。新操作实际调用M1及父实例provider，缺/错事实拒绝，不从数据库倒造新OS事实。跨epoch记录不改写。
- COMMIT仅command=COMMIT才确认，ROLLBACK标签拒绝；未知时client.release(Error)销毁原连接，先退役再独立checkout/对账，max1 fake验证顺序；无ROLLBACK推断或原写重放。缺行/旧revision/等锁错误保持unknown；异内容对账明确conflict。COMMIT已确认后认证变化保留commitKnown及原操作事实，输出obsolete_*，不假装rollback。
- 所有结果protocolPermit=false/fence=held，M1 replyCandidate仍durable=false/requiresPersistence=true；storage committed不是HTTP ACK/配置下发许可。无proof/release、原task/lock接线或统一调度变更。
- SQL只新增专属表DDL文件，未挂载init或调用；未改generic upsert/现v1/service/index/Agent/Python/包锁/依赖。扫描未发现产品入口引用新repository或DDL。

## 实际证据及限制

M2最初21项fake生命周期用例通过后，自审追加3真实repository入口反例：readyNonce错误仍checkout、getPool等待期间认证变化仍checkout、同ID异内容对账仅unknown。原21绿/新3红（24项/exit1）已保存完整产品/测试红源、输出与hash；修正后当前26项通过。UNIT_INITIAL记录初21历史，PRE_REVIEW_RED记录3红，当前源以M2_UNIT_OUTPUT与TEST_RECEIPT为准，不把历史运行次数相加。

另实际运行M1原61、v1 server cleanup/Agent protocol/physical readiness原50，均通过；新增/改动JS语法检查通过。均为本地fake/自有fixture行为：**没有验证PG真实CAS、行锁/约束、COMMIT网络或断电语义**。fake pool只是调用序列/返回值控制，不是PG替身验收；测试名称中的CAS零行仅验证产品如何处理零行返回。PG16.15与既有共享pg8.22.0可用来源已在方案固定，本轮没有安装/修改或启动它们。

完整staged diff --check报告原始PRE_REVIEW_RED_OUTPUT.txt内6行TAP空行缩进尾空格（137/139/159/161/182/185）；原始失败输出与hash保留，不trim伪造干净记录。只排除此一个固定原始日志的代码/文档diffcheck另行记录，不称完整检查通过；该证据格式例外交root审。无其他路径豁免。

实际隔离PG验证仍须包含并发两连接barrier、直接约束负例/触发器拒绝、代理后端COMMIT tag且ReadyForQuery=I/无ErrorResponse后丢回复、提交前断、独立读、重启、初始化缺行/旧epoch等。runner/代理尚未编写/审查/执行，不能用本单元绿兜底这些未验项。

## 版本与导入

本片交root审核固定源码/DDL/测试和manifest后，再准备固定runner。可导入仅M1两导出、新repository及独立DDL（DDL不自动执行）、专属测试/fixture；运行时index/generic持久化/旧v1不在导入范围。14既有产品源与方案基线一致。无生产回滚动作；撤回候选不清任何记录，未来新表已写数据必须保留，不能DROP/重置revision恢复旧状态。

状态为本地候选待审、真实PG未验、native主号/分身未验。原43/147/52、155/157查名池、SYSTEM固定身份、媒体/控屏冻结全部保持，无Windows/手机/ADB/发布。
