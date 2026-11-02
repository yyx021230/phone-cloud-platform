# 原业务锁四组隔离数据库验证：4/4通过

根审固定 eb42fc4d34d6353e24fae060e5d81e52efe0ee2f / wecom-v2-original-lock-verify-20261102-draft.1 后，于2026-11-02 23:58 CST在新私有库 pc-wecom-v2-business-pg-8nemqqbt 单次执行。此目录逐字封存7个原件、17源执行清单与根实际审查原件；归档未连接或重跑数据库。

- unmarked-negative：A实际完整5 DML，B实际语句，C服务端观察B active/Lock并精确被A阻塞后才放A提交；旧写更新1行，原业务锁无v2 marker，M3 fresh重读conflict。不能把task marker保护外推到原业务锁。
- owner-status-known：合成owner同一连接加载全tuple，仅四个可变字段迁移，实际COMMIT且释放client后，新backend读取业务锁released，M3 recorded。
- target-nowait：首目标真实55P03，仅回滚目标SAVEPOINT；第二目标同一事务提交，新backend验证首不变、第二released。
- target-cas-zero：数据库内真实注入导致完整JSONB CAS返回0行，注入随目标回滚，第二目标同一事务提交；新backend验证首目标无注入、第二released。

四组物理hold、ledger claimData与anchor均保留，业务锁released不是物理设备释放。Node62313 exit0且进程组消失，PG62301 exit0确认，成功db仅由原runner确认后删除；旧gr_br461失败库保留。INITDB原件第24行EOF空白原样保留并具名列入diff例外，不声称完整diff check通过。

这是验证用合成owner和SQL机制，不证明生产caller权限、共享writer修复或真实设备验收。不累计先前各阶段测试；无产品、DDL、shared、Windows、ADB或生产更改。delivery/progress独立持久操作回执、blob/boot、mapping、journal/native仍未闭合。原43设备义务、147/52、查名池与冻结保持；主号、分身真机验收仍未完成。
