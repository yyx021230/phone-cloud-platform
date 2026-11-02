# M1 rc.2：Windows身份schema遗漏修正

基线2bae48b706b4d2742c74a6c1624605e2c9908fab、wecom-v2-host-m1-20261102-rc.1；原tag/45绿回执不改。仍在codex/wecom-v2-host-m1-20261102，仅收紧M1新叶与专属测试。未改v1/Agent/Python/service/index/PG，未接线或运行Windows/真机。

root独立发现：request与provider合成事实同时一致地填入reader PID=4294967296、出生token指数+9999导致非finite、createdAt改2000但token未变时，rc.1均准备revision1。fence仍held、durable仍false，因此是schema漏洞，非物理释放；不能据此声称生产被误放开。原黄金fixture的出生token也与2026/2000/2099时间不一致，value-only对照provider遮住了这个缺口。

本轮先在旧产品源追加3个实际入口负例：原45仍绿、新3红（Missing expected exception），完整旧源/带负例测试/exit1输出与hash保留为*.red.txt、RED_OUTPUT/RED_RECEIPT；root原反例源逐字复制ROOT_EXTRA_ORIGINAL.mjs.txt。之后才改产品校验：PID必须0<pid<=0xffffffff；解析hexfloat后必须finite且>0，同一host的token秒值换算毫秒与自己的createdAt差值<=1.001ms，沿用既有Agent容差。完全没有比较cloud now或两台主机时间，没有改写出生数据。

root随后提供固定Git版rc.1反例包，本目录ROOT_FIXED_RC1复制其旧模块、counterexamples.mjs及三例实际接受的OUTPUT.txt，旧模块SHA与2bae48b Git blob一致。历史执行依据是这个固定包和本轮RED回执；ROOT_EXTRA_ORIGINAL中导入可变工作区的脚本仅保留原参考文本，不拿它在修复后的运行结果代替历史证据。

黄金fixture现由各自wall经IEEE754位模式产生合法hexfloat，reader比parent晚1ms；2000与2099仍走真实preparer正路径。错实例关闭反例改成双方一致但与原登记不同的另一对合法出生数据，保证失败原因仍是原实例不匹配，而不是夹带不合法token。

当前61项通过，含原45、reader/parent同源坏PID/token/时间的6负例、DWORD上界、underflow零、±1ms保留与2ms拒绝；原v1清理/Agent protocol/physical readiness50项通过。两新增文件node --check通过。TEST_RECEIPT绑定当前源、实际exit与日志；不将历史45/48红/中间59运行相加，当前源结论以61为准。

旧14产品源hash保持441a不变。依旧只返回未持久nextState/replyCandidate，不提供ACK/放行/释放/时钟或OS权威；真实provider、CAS/journal/pending-release仍未实现，结构校验不替代来源验证。importAllowlist仍仅M1叶与其测试，原43义务与所有隔离/冻结不改。状态为本地候选待root审；没有原生、API或真机通过结论。
