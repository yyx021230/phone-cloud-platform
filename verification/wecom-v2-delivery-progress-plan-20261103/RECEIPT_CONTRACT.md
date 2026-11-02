# 后续progress独立操作回执合同草案（未实现、待根审）

本合同只处理一次**数据库投影变更**是否持久提交，不授权启动脚本、重发邀请、重建ADB、清物理义务或跨设备admission。物理host/close仍只属于M1原exact状态，不能扩它的操作集合。回执不放可裁剪events/result或仅内存缓存；不能替代journal/native证明。

## 稳定身份与输入

建议可信server owner在第一次尝试前固定独立mutationOperationId；在连接重试、HTTP换请求号及未知提交对账期间沿用它。不能用每次回调newId或变更claim ID，也不能将业务requestId直接视为这次mutation唯一身份。这里只声明来源要求，未提供ID生成器或来源授权。

同一operation绑定完整原claim/obligation/task/job/physical key、server epoch、原device/Agent/serial/slot、动作purpose，以及当前受信执行实例引用。实际执行实例合同由根提供，不能凭Agent ID或一次心跳替代；字段名/来源尚待根确定。owner context变化不得把原operation改绑到新epoch/parent后继续写。

内容fingerprint建议对严格JSON候选envelope规范化后SHA-256，包含version、purpose、稳定operation身份、完整claim绑定、执行实例引用、预期旧task/job完整JSONB与拟写task/job/delivery内容。不得只hash status或电话号码；不得把可变attempt/时间排除后使不同提案撞作同操作。规范须固定对象key排序、数组顺序、数值/Unicode规则、拒绝非JSON/accessor/重复key的入口责任与大小限额，并提供golden vectors；当前没有canonicalizer实现，不可宣称普通JSON.stringify已满足跨语言规范。仅hash保存不等于无需保护原业务数据。

## 原子持久性与重读

建议专用durable receipt域，使用operation唯一约束和不可变内容指纹，关联上述原owner引用。不能复用M1 exact两op状态，不能覆写claim_data来塞新进展，也不能只依赖task最后updatedAt。**此处没有表名、DDL、角色或迁移授权**；是否采用独立表及其精确列、唯一键、FK/retention由根审定后另提DDL。

在同一owned client/transaction内：anchor/full tuple NOWAIT读取与真实权限核验→查operation已有receipt→候选全字段验证→按旧JSONB CAS task/job→写immutable receipt→COMMIT。已有同op同指纹须核原owner一致并返回原已提交结果，不重复DML；同op不同指纹或绑错owner冲突。receipt和所有投影要么一起提交要么一起回滚，不能在另一连接事后补一张“成功”回执。

COMMIT已确认且client释放后可发布known；命令回ROLLBACK不能算COMMIT。连接error/超时/COMMIT回复丢失先退役原client，独立新连接用**原operation和指纹**及相同owner读取durable receipt。确切同op同指纹且原子关联完整才可恢复known；内容冲突/源不可信为conflict或unknown。若receipt缺失而旧事务可能仍未结束，只能unknown；即使确认未提交也仅可在重新授权及幂等合同下重试数据库变更，不能因此重执行手机脚本。对账遇锁/连接异常不得当“没有记录”。

## 输出、保留与未定项

receipt只证明其绑定的mutation，业务success或released不清physical hold/ledger/anchor。回调可在该条durable known后单独发布；发布另需outbox/对方幂等合同，数据库receipt不自动保证对方收到。取消、换请求号或重启不删除原receipt。只有在原物理义务、重试/对账和审计生命周期确认关闭后才能按另审retention处理，不受当前events历史裁剪影响。

尚待根确定：可信执行实例/schema与epoch刷新规则、稳定ID入口、指纹canonical编码、receipt精确schema/权限/保留、与根blob/boot权威引用及发布outbox的关系。未确定前只能known COMMIT窄验证；不得把“claim仍recorded”降格当未知提交已经成功。
