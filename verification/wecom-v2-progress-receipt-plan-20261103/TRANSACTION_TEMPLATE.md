# C2事务与未知提交模板（文字，不执行）

本模板只给未来verification fixture，真实caller权限/DDL/journal未实现，不是应用可调用的事务器。

1. 第一次尝试前从可信持久journal取得原operationId及完整proposal，计算固定fingerprint；校验严格输入、原claim/context、purpose允许集和所有未知字段保持，拒绝项不写数据库。不根据本次HTTP requestId另生成操作。
2. 取得owned client，注册自有first-error observer，明确READ COMMITTED及原2/3/5秒预算。每次await后重新核同一owner authority，不改变上下文继续写；连接error后不再向它发SQL，准确移除自有listener并release(error)。池本身error健康由根另管。
3. 同client按既定anchor→task→job→physical hold→original business→ledger顺序NOWAIT读完整规范tuple和映射，再读ProgressHead/本operation Receipt，校所有关联/类型。不能持anchor另开M3 reconcile连接自锁；未知源/缺head拒绝不初始化。
4. 如果同op已有完全相同content/owner的receipt：核指纹、revision链与head，返回历史已提交事实，不重做DML；不同内容/owner确定冲突。head存在更晚合法后继时不要求task仍等旧next，但必须验证链与当前投影指纹；claim仍在不代替这步。
5. 新operation要求head revision等expectedProgressRevision，实际完整task/job等expected快照，immutable/context/purpose迁移全部成立。先task CAS，再job CAS（delivery purpose的job不变也必须核其原关联/快照），再head CAS并INSERT immutable receipt，全部同TX。任一0行返回/RETURNING不符不能留半更新；真实错误与局部冲突类型严格分开。
6. 目标局部NOWAIT55P03或自有明确CAS0才ROLLBACK TO目标SAVEPOINT，保留其义务；同事务下一独立目标可继续。任意SQL错误/连接error/COMMIT回复不可信不能标局部成功，先前目标的未提交RETURNING也不得发给调用方。
7. 只有实际命令COMMIT确认且原client已释放，所有此TX mutation才可逐条发布known。原命令回ROLLBACK或SQL error不能算COMMIT；COMMIT尝试后失去回复，将此事务涉及的每条operation标unknown（即使此前task/job/receipt INSERT都RETURNING了）。不在失信连接补ROLLBACK探结果，不根据当前claim推断成功。
8. 原client退役后新checkout/独立backend按同operationId、contentFingerprint和固定owner读取。完整immutable receipt+head合法链+原tuple校验通过可返回recorded；读取错误、锁未决、来源/owner失信或链不齐继续unknown。receipt缺失且原事务未确定结束，仍unknown；即使确知数据库未提交，只可按另审幂等/重新授权规则重试该数据库mutation，绝不重跑手机脚本或发送邀请。

## 后续验证矩阵建议，当前全部未执行

|场景|需要真实观察|
|---|---|
|task+job+head+receipt成功|完整RETURNING、真实COMMIT/release、新backend四域关联与物理义务不变|
|同op同内容重复/不同内容|相同返回原receipt且无重复DML；不同稳定拒绝不写，不能重生成op|
|task已改但job CAS0|整个目标rollback，head/receipt均不出现，另目标同TX可提交|
|head revision争用|真实独立连接竞争，唯一链不分叉；不能把调用顺序称真实并发|
|COMMIT前连接丢失/COMMIT已提交但回复丢失|真实受控wire/driver故障、原client退役，独立backend原ID读取；手机执行次数不由DB fixture冒称|
|旧epoch/旧执行身份/来源变化|拒绝不改原owner；已知提交后上下文变化保持历史known但不授新权限|
|合法后继后对账原operation|旧receipt仍证明历史已提交；完整链连到当前head与投影，不以当前task不等旧next误判未提交|
|坏目标/整TX未知|目标结构异常或明确NOWAIT/CAS0局部回退；连接/COMMIT未知覆盖全TX，不能先外发其他目标的暂定成功|
|重启/blob/retention/outbox|单独根协调；纯DB原件不能替代启动或实际回调送达验证|

执行前还需根审精确schema/源/tag/依赖/seed/预算及原Popen owned runner，未经授权不写可执行DDL、不跑PG，更不执行Windows/ADB/手机。所有旧失败证据保留，主号分身真机未完成。
