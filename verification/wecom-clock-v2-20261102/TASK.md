# 企微时间域后继合同评审

- 当前状态：合同draft.2待root评审；未实现产品、未部署、未做新真机操作。draft.1固定在ab4c9a6，不移动旧标签；自审补入业务lease跨机wall、原300秒锁/3秒余量及暂停/跳时failclosed边界。
- 分支：codex/wecom-clock-contract-20261102，从失败观察37a954fd6a3ec750e70466be99ed7a46ae09605a建立；生产参照32c0091，ACTIVE a539，不把新ADB PID27912写成授权基线。
- 用户原目标：空闲手机正式API预览，仅到发送邀请前，不真加人、不影响线上查名/其他手机。新原单43登记失败且独立义务保留；root统一冻结native后，只允许既有日志只读与本地反例/合同。root明确允许企微owner负责后继本地候选，要求先合同评审；不扩大到生产或43旧义务恢复。
- 共同流程2026-09-30/SHA 0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b；主文档已连续阅读，其新记录按owner最小合并，不整树覆盖。
- 风险：时间域改动涉及授权/新鲜度/持久隔离，是R3合同；本阶段只写文档与既有日志的脱敏技术短语证据，不修改实际guard。合同明确保留230/245秒、20秒、120秒和3秒预算，旧义务不自动迁移。
- 前阶段9项护栏/反例仍按原观察提交归属。本阶段新增离线延迟原型8/8通过：真实本机OS child/HTTP/实际close、调用未修改产品verify_empty的实际两帧顺序；所有Android旧host/包/forward事实为显式合成回调，不创建ReadOnlyAdb/SDK/socket。覆盖固定±5分钟audit offset、错PID/旧pipe nonce/挑战前事实、真实close3000ms、challenge响应2700ms+close250ms、单读600ms、模拟epoch变化。证明3秒超限保守拒绝，不减检查/重盖时间。结果/源hash见LATENCY_TEST_RECEIPT.json；未验SYSTEM、Windows、暂停连续性、journal/PG事务或产品v2实现。
- 既有日志07:12–07:15仅匹配kill-server及daemon not running短语，不证明执行人/初因/成功启动。受限原查询结果保留私有目录，入Git只脱敏技术短语与hash。所有人工ADB CLI/SDK/重建/身份/keys/入口/NTP/部署动作均为0。

root合同审查的6点均已在draft.2给出明确合同或实现前阻断项：逐入口时间清单（含原业务300秒/3秒余量、generic TTL/恢复/归档/checkpoint）；同事务epoch/mono/challenge消费与延迟旧checkpoint防倒写、重启maintenance及最多1自动核验代次；必需的无业务最小bootstrap nonce/私有管道绑定；受限journal ACL/原子write-through/fsync及有限完整记录/receipt摘要轮转，未知记录不删；服务器/Windows暂停与clock continuity未知failclosed；真实Python首事实在挑战后且3秒包含网络/身份/两帧/真实close的离线原型。尚无root合同通过或产品实现放行，不从本地8项通过推导可以上线。

已完整阅读root新增主文档事故记录3b21e0a724b6a1c08026d411e643618c9fc11039：原8148退出/中间daemon来源仍未知，27912同SYSTEM不自动更新基线，147/52 disabled及43原隔离保持。root自有Windows只读SSH已关闭，本owner/查名的既有连接与共享cloud master不擅自关闭；没有后续真机动作。
