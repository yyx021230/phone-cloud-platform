# 后续fixture断言矩阵（未实现/未运行）

当前没有adapter或SQL执行；这不是通过清单。

|范围|最低断言|
|---|---|
|head seed|仅新synthetic；原M3 known/release/fresh recorded后，同client full tuple校验再head0 INSERT；缺head/legacy/v1不自动补；重复seed失败不吞|
|纯候选拒绝|owner/claim/op/authority、ID/slot/号码/备注、source status/字段类型/unsafe source数值、audit、result额外字段、所有未知字段新增改删DML前拒绝；getter不调用|
|单次known|task/job running→stalled三个字段；完整RETURNING，head0→1和receipt同COMMIT；新backend逐行复读，全部business/physical hold/ledger/anchor/device原样，M3 recorded|
|重复|同op同内容返回同receipt且DML0；同op不同proposal/owner/authority冲突不写，不换op或claim|
|原子回退|真实task UPDATE1后job真实CAS0，目标内task/head/receipt都回退；另一独立目标同TX提交；不能用mock0冒称SQL已测|
|竞争|两独立backend相同head0/不同op不分叉；真实NOWAIT/Lock/唯一约束效果按准确场景记录，不把顺序调用叫并发|
|未知提交|真实driver/wire丢COMMIT前/后回复；原client先退役，新backend原ID读；所有暂定返回都不当known；无receipt/未决仍unknown且无重写/手机执行|
|严格列/JSON|head11、receipt11、task7、job8精确列集合、metadata/Date规范、bigint严格string、owner/完整snapshotFP/receiptFP重新核；未知字段不从提案过滤后强行接受|
|篡改/缺链|相同receipt ID但内容/指纹/prev字段/expected-next链/head/current task-job任一漂移拒绝；无数据库roles时不假称管理员不可改|
|后继|本片唯一running→stalled、revision0→1。rev>1或非null previous保留合同但unknown/待验；不造未授权迁移来测合法后继|
|源与接线|数字只synthetic有界constructor；未测一般raw JSON/JSONB无损来源、stable journal/真实authority/head生产初始化/完整迁移catalog/retention/blob/boot/outbox/native|

未来owned PG必须固定源/tag/deps/实际seed唯一和原超时/原Popen清理边界，根审后单次新库；失败保留原件，不改断言凑绿，不碰旧失败库。无fixture能代替空闲主号/分身真实流程至发送前验收；43/147/52和查名池保持。
