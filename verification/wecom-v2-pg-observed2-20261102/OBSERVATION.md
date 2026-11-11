# 新私有PG单次14项通过（原始证据归档）

root审073886ee/draft.3及88633cc1/M2 rc.3后，在全新/private/tmp/pc-wecom-v2-pg-xeywe54s执行一次固定runner。owner只本地逐字复制7原artifact，逐项hash与原RUN_RECEIPT一致；从已核工作区复制的执行源manifest精确匹配receipt输入hash，13源现字节相符。root独立复核原件JSON也逐字归档。没有重新运行/接库或修改产品。

TAP实际14 tests/14 pass/0 fail，14唯一case齐。7故障case均记录原fault client/真实wire fault/精确断链错误/额外error listener恰1且expected=true，原UPDATE/INSERT次数均1。真实COMMIT后丢回复与独立backend读取、提交前断、初始化/操作epoch及畸形认证的未知分类、并发barrier单revision、约束/回滚、单行锁隔离、新Node旧epoch拒绝等断言实际通过。

Node29303 exit0且自有组消失，PG29291正常exit0/停止确认；本次成功db依原runner清理，日志和回执仍保留。原3mrc7nik失败db继续保留且未重启，其原14项7/7失败/14条body note及原始证据不改。两轮分别保留，不能把首次失败洗成通过，也不累加为28项独立覆盖。

此前8纯协议、6runner安全、7fixture观察器及M2 39/M1 61/v1 50属于各自固定阶段，不因本次通过重新计数或升级成真机。此实测只证明本地PG16.15/pg8.22.0/Node25.9.0与这组代码/故障用例，不证明生产PG、跨实体task+物理hold原子领取、journal、真实Windows父子身份/时钟或API手机流程。

M2结果仍held/protocolPermit=false，存储committed不能当host ACK或手机号配置许可。下一M3只准备任务/物理hold/协议账本原子创建、恢复journal、真实父子facts与v1兼容的具体方案，未审不接共享index/getPool，不开手机或发布。原43/147/52义务与155/157查名池不核销，全部冻结继续适用。

原INITDB输出若带空白EOF，保留原字节/hash，并将完整diffcheck格式警告与代码/文档检查分开记录；不清洗原始日志。状态是本地协议数据库验证通过，真机主号/分身验收未完成。
