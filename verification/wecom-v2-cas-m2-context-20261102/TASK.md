# M2 rc.2：COMMIT未知后的认证变化必须返回结构化状态

基线4efde08549e9f3d4232a049f7d5eabd7466c753e/rc.1。root独立26+61回归及19manifest后，用固定Git模块实际复现3例：操作提交回复未知+epoch变、初始化同情形、操作提交回复未知+认证畸形。内部reconcile在try外requireContext导致普通throw；原连接销毁、无额外写入是正确的，但不能让调用方误当纯前置拒绝。root固定模块/fixture/原输出逐字复制ROOT_FIXED_RC1，三源码分别与4efde08 Git blob核对相同。

先在未改产品源追加3入口负例，实际原26绿/新3红、exit1；RED源/输出/hash均保留。产品只把内部reconcile的requireContext移入已有try/catch：epoch变返回obsolete_epoch/commitKnown=false，认证不确定返回unknown/commitKnown=false，storedOperation=null、fence held/protocolPermit=false；不从fake已写状态推定实际提交，不checkout第二条连接、不重写、不重新生成操作。COMMIT已确认后的known事实保留分支不变。

公开reconcileOperation仍先precheck，坏输入/认证在任何连接前拒绝，不因内部修正放宽。补齐初始化+操作分别epoch/malformed四种组合，每例同时确认公开认证前置拒绝仍成立。当前M2 30项过，原M1 61、v1/Agent50过；两改动JS语法检查过。仅fake生命周期用例，真实PG/CAS/网络故障尚未运行。

仅提交repository/同名测试、文档和本目录证据，未完成的pg-commit-proxy.mjs及其纯parser测试文件保留在原目录未暂存，不混入rc.2；runner仍待准备/审查。未改M1/v1/DDL/index/generic/Agent/Python，14旧产品源不变。无PG服务/SQL/Windows/手机/部署，原43/隔离/查名池/冻结保持。候选未接线，不宣称真机验收。
