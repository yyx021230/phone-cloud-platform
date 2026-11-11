# 专属clock适配边界：最小本地候选

- 状态：**本地候选，未形成完整可部署运行时修复**。人类真机发送前验收目标持续，但当前没有已审完整安全路径。root协调后先在verification做专属helper/实际本地HTTP与child测试；不更改生产v1路由/Agent index/共享runner，不扩大外部API草案，不加载Windows/SDK/ADB/手机。
- 分支 `codex/wecom-clock-adapter-20261102`，干净起点 `94a48081392ae87e537eecaaa8e431df1393382f`。主文档完整连续阅读、相关最新记录已核；共同流程2026-09-30/SHA `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。原所有版本和材料保留。
- 复用固定model.2数值逻辑，源SHA `e3d55547232f4d121da52b542debbd86fc965f7f21146361c16c413348928121`，没有改模型或把它导入任何产品入口。本目录没有生产路由/Agent接线；authority.mjs的生产factory始终拒绝，不接受profile/continuity/UI/环境字段升级支持。
- fixture factory与production factory明确分开。fixture父进程只spawn固定本地Node脚本、空环境；reader ready用父生成nonce和实际自有child PID绑定，clock每个请求有新nonce、独立epoch/连续序号、唯一pending。旧nonce/不同child/重复/乱序/畸形/无newline超大/残缺/超时/迟到响应均失败，保留首次错误对象，不新spawn重试。对完整行和未完成行都限4096字节。
- register/close/challenge/proof每次即时索取child样本；持久提交后再取新样本决策，不复用提交前快照。真实close由本地自有child close事件观察，不接收caller closed=true；私有frame capability绑定同challenge、顺序与单次消费。并发action或持久未知后，同reader不能在新authority重arm。此处不是跨进程旧任务journal恢复/真实PG或原生host身份方案。
- 正向只返回fixture timingWithinThreeSeconds，同时**始终nativeExecutionPermitted=false、physicalCleanupVerified=false**。两个frame只是时间观察，不包含包/forward不存在的手机事实；不能用于证明清理完成或释放生产锁。
- fixture child的boot/work/wall/误差是显式合成数值，默认静止，仅用advance注入经过时间；不会自动计入实际HTTP、管道或fsync的墙钟耗时。只证明跨真实管道的取样/调用顺序与注入轨迹判定。真实loopback HTTP、实际自有child退出、本地文件fsync及真实ENOENT仅证明适配器执行和失败路径，不证明生产Windows/云VM的精度、暂停、速率或3秒现实时间上界。claimedBy仅进程内WeakMap，fsync文件没有跨进程恢复或真实PG语义。
- clock_probe.py实际只在本机运行observe-only：Linux若有配对API则直接读取CLOCK_BOOTTIME/MONOTONIC/REALTIME，但读数/名义分辨率不能生成硬界，仍unsupported；当前本机Darwin返回unsupported，Windows也未实现/刻画，生产factory不消费probe自报信息。没有生产OS读取、调时钟、权限或新SYSTEM入口。
- 首轮21项20过/1失败：frame输出缺少显式拒绝标记，HTTP断言得到undefined而非false。保留INITIAL输出及当时源码hash，失败源码当时未提交、完整旧快照未保存，不把旧日志绑定最终源码或宣称可从当前文件复现旧hash；后继修正只在本目录helper，并补reader nonce、输出边界/首错保留/单次claim。
- 首阶段28项通过后root独立复跑并注入合法JSON null，发现line读属性的异常能逃出stdout事件回调。已保留root红例、两个修前四源快照；六项新类型反例在旧helper上实跑34项28过6失败，修正为严格非null/非array对象与精确字段、所有解析/协议错误锁存首因。随后2个旧nonce/PID夹具缺sample，被新严格schema提前拒绝，32/34日志/旧child源另存，只改夹具为完整结构再故意错nonce/PID，不放宽helper。
- 最终34项0失败/0取消/0跳过，覆盖本地HTTP+child+fsync、实际文件ENOENT、每phase提交后600ms合成排队、旧样本序号、真正迟到响应、nonce/异child/重复/乱序/畸形/无newline超长/残缺/超时/退出以及null/array/bool/number/string/missing类型、伪frame/反序/重复challenge、暂停/跳钟/监控缺口。200ms反例已构造与同一createdAt对应的IEEE754秒hex token，先经真实Agent `physicalHosts` 接受，再由真实server `recordWecomHosts` 因跨机wall拒绝；这是两个实函数的合成分支，不是全pipeline/OS出生事实或43根因。未重跑原36模型、455脚本或49 Node，也不相加作新覆盖。
- 最终输出/源码/依赖hash另存；JS语法/Python AST通过。原始失败TAP的三个日志含上游生成的空白行尾，完整staged diff --check因此报警；保留原字节/hash，不格式化证据。仅排除INITIAL_TEST_OUTPUT、REVIEW_RED_TEST_OUTPUT、FIXTURE_FAILURE_OUTPUT三份原始日志后，其余全部源码/文档/材料diff检查通过。没有任何产品文件改动或远端连接/手机任务/邀请/配置/部署/推送；43/147/52隔离、155查名排除和27912来源未知保持。

复跑（仅本地）：

```sh
node --test verification/wecom-clock-adapter-20261102/authority.test.mjs
```

下一步只审此固定候选与最小接线差异。真正生产依据、Windows采样/暂停可信边界、真实child出生代次/已连socket peer、跨重启持久账本、PG原子提交、生产v1兼容及旧43维护均未解决。未获得这些条件和具体加载授权，不把本候选接到生产，不将fixture结果翻译成native许可。本候选回退只需停止使用新增verification工具，无生产回滚或迁移。
