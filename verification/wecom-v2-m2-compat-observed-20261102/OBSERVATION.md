# 原M2 14/14 + 新claimed-row 2/2分别通过

根固定23d781d353acd9ea12b69366546c2cc7de0f40f3 / wecom-v2-m2-compat-20261102-draft.1，在新pc-wecom-v2-compat-pg-w57mcq87单次串行运行。此处9原文件逐字复制/hash核RUN_RECEIPT，执行21源manifest与14body hash固定Git核对，root actual-review原件单独保存。归档过程没有PG连接、重启或重跑。

第一阶段原M2全文仅before增加新claim DDL一行，原14TAP/14唯一body全部通过；第二阶段独立2TAP/2body通过，已领取主号/分身合成记录经未改M2产品host、host-closed推进M1 revision1→2，原claimData不变且M3两次完整tuple重读通过，protocolPermit始终false。只验存储兼容，host事实为合成，不是Windows进程来源或真实发送。

第一Node49655exit0/组消失，第二49679exit0/组消失，PG49643exit0confirmed；前后源匹配，成功db仅原runner所有确认后删除，旧gr_br461失败db未操作仍保留。原INITDB第24EOF空白保持，完整diffcheck原件例外具名列出，不洗成全绿。

14与2分别记录，不与M3历史18或纯策略64累计。补齐了“原M2全套+新DDL”和“已claimed行经原M2推进”的本地兼容缺项，不代表共享writer SQL/EPQ、full-state blob/启动overlay、设备映射屏障、journal/native或主号/分身真机验收完成。原43设备清理义务/147/52与查名池、ADB/SYSTEM/媒体冻结保持，线上未动。
