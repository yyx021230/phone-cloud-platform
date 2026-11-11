# task EPQ三对比 + target SAVEPOINT：4/4通过

根固定496a44ae3cacba400ee161be043c25ead3a26166 / wecom-v2-task-epq-20261102-draft.1，在新pc-wecom-v2-epq-pg-5imxqwro单次执行。此处7原件逐字复制/hash核RUN_RECEIPT，12执行源固定Git核对，root actual-review原件保存。归档不连接/重跑/重启PG，旧库未操作。

真实4TAP/4pass/0fail，4完成case与4attempt齐、前后源匹配。每个前三对比A由原M3完整5DML在COMMIT前暂停，B raw查询已发，第三C真实active/Lock/blockers包含A后才放提交。负例NOT EXISTS等锁后确覆盖1行、marker丢失、M3重读conflict；guarded UPDATE/UPSERT各0行/rows[]，最终完整JSONB/claim保持、M3重读recorded。新候选2099时间戳严格晚于A，排除旧timestamp单独保护。backend_xmin/顺序是实际观察值，未完整导出B语句snapshot。

SAVEPOINT第一目标真实55P03，仅回滚该savepoint；另目标同writer transaction实际COMMIT，新backend复读第一未变/第二stalled。没有把连接失信或未知提交当成功。事实详原PG_EVIDENCE/ROOT_REVIEW，不用body note数量代替TAP。

Node53663exit0/组消失、PG53650exit0confirmed；成功db仅原runner确认后删，旧gr_br461失败db仍保留。原INITDB第24EOF空白逐字保留，完整diffcheck例外具名记录。

只验证比较SQL的窄当前row marker行为，**不是原生产故障根因证据，也不是共享writer已修**。没有修改生产产品/DDL、没有Windows/手机/发送或上线。job/hold/business无marker/custom delivery/controlled owner、full-state blob/boot、lookup canonical及跨协议admission尚未验证，S2/journal/native未闭合，原43设备义务/147/52与查名池/冻结保持，主号分身真机未验收。
