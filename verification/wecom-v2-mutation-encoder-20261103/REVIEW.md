# C2 verification tree encoder：64本地通过，未接产品

根审9546c831后仅允许此纯leaf。encoder.mjs实现固定WCMUT1 typed bytes与SHA256，未实现parser、PG/repo/DDL/roles、ProgressHead、authorizer、产品/shared/M1/events或native执行。

直接使用原GOLDEN_VECTORS.json的20个accepted规范bytes/hash，未改原件。原61本地通过的源码/测试/日志逐字留initial61（没有失败）；补3个独立边界检查后最终64/64通过，不把61与64累计。覆盖Unicode scalar排序/不归一化、类型、binary64、安全整数端点、有限小数、-0/nonfinite/unsafe拒绝、无getter/Proxy trap/toJSON调用、prototype/holes/extra/symbol/cycle、对象key计节点，以及深度24/25、节点50000/50001、编码总bytes262144/262145精确边界（含UTF8与域前缀）。JS syntax通过。

输入只接受strict JSON tree。测试加载受信已提交规范JSON用普通JSON.parse，**不是**新增原始JSON输入验证器。原duplicate-key raw descriptor保留待验；不能说“16拒绝描述全部实现/入口通过”。数据库原始数值精度、原始文本已折叠重复键或已损失数字都不能由此encoder恢复或证明。Protocol/caller/canonical source authority仍未提供；函数输出只有规范bytes/hash，没有写/执行权限。

所有product/helper/模型/原spec/goldens/DDL字节保持。实际journal稳定op来源、trusted authority、head初始化/允许迁移、合法后继链/retention/blob/boot/outbox未闭合。无新SQL/PG/Windows/ADB/手机/生产动作，43/147/52和查名池保留，主号/分身真机验收仍未完成。
