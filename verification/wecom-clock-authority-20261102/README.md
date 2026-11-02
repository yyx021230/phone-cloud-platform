# 企微时钟授权：离线区间模型

状态：**仅verification，候选产品尚未实现/放行**。基线5d75159182f60f1654bd5976867bf74af45e24e2（合同draft.2），分支codex/wecom-clock-authority-model-20261102。生产源码32c/ACTIVE a539未改；43旧义务、147/52隔离及native冻结保持。

本目录没有OS采样器、网络、文件系统权限操作、Agent/ADB/SDK依赖，也没有连接实际Linux VM或Windows。全部时钟读数、误差参数、暂停/重启是显式合成数据；JSON恢复仅内存模型，不是实际PG/checkpoint/journal验证。前阶段8项OS子进程/HTTP原型没有重跑或并入本阶段测试数量。

## 选定研究的时钟源与尚未建立的依据

| 主机 | 拟用权威经过时间 | 诊断工作时间 | 本机wall（只做异常诊断） |
| --- | --- | --- | --- |
| Linux云端 | 直接clock_gettime(CLOCK_BOOTTIME) | clock_gettime(CLOCK_MONOTONIC) | clock_gettime(CLOCK_REALTIME) |
| Windows Agent/reader | 直接Win32 GetTickCount64 | QueryUnbiasedInterruptTimePrecise | GetSystemTimePreciseAsFileTime |

Linux文档说明BOOTTIME包含OS suspend，MONOTONIC会暂停；这只是API语义，不是当前云VM的实际保证。[Linux内核时钟说明](https://docs.kernel.org/core-api/timekeeping.html)

Microsoft说明GetTickCount64包含睡眠/休眠时间，分辨率通常约10–16ms；“通常”不是任何部署的误差硬上界。[Windows Time](https://learn.microsoft.com/en-us/windows/win32/sysinfo/windows-time)、[GetTickCount64](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-gettickcount64)。工作时间诊断源不计睡眠/休眠，但也不能单独当作过期计时源。[QueryUnbiasedInterruptTimePrecise](https://learn.microsoft.com/en-us/windows/win32/api/realtimeapiset/nf-realtimeapiset-queryunbiasedinterrupttimeprecise)

模型拒绝把process.hrtime/performance.now直接替代暂停感知源，也不选择.NET Environment.TickCount64包装。拟定API并不意味着已建立采样实现、当前内核/Windows版本可用性、硬件校准或超管暂停保证；没有真实上界的生产profile**不能签发**。本模型只接受带`synthetic-offline-assumptions-only`标记的合成profile，不能部署后默认使用这些数值。

## 合成参数与读取模型

读取顺序拟为本机wall_before、boot_before、work、boot_after、wall_after；所有值转为BigInt微秒。Linux纳秒转微秒、Windows tick毫秒/100ns转微秒产生的舍入误差须包含在真实误差上界中，不能悄悄丢掉。当前无实际适配器/读数。

| 参数 | 本模型演示值 | 来源/性质 |
| --- | --- | --- |
| Linux每读boot/work绝对误差 | 100us | 合成假设，非clock_getres测得、非文档保证 |
| Windows每读boot/work绝对误差 | 20000us | 合成假设，不能从“通常10–16ms”推导硬上界 |
| 每读wall误差 | 20000us | 合成假设，仅用于同机异常检测 |
| 每钟相对速率误差 | 100ppm（测试另含0/10000） | 合成假设，未校准任何硬件/VM |
| 单次夹取区间宽度上限 | 100000us | 合成策略；包括两端误差后的区间宽度 |
| 两次监控最大间隔上界 | 500000us | 合成策略，不是产品已经有的监控线程 |

boot在work读取瞬间的真值区间为`[boot_before-Eb, boot_after+Eb]`，work为`[work-Ew,work+Ew]`。wall用其前后夹取区间。每读误差、读数夹取宽度和速率上界全部必须显式有限；缺失、负数、越界、使用JS浮点/NaN代替BigInt均拒绝。文档中的名义分辨率不是上述误差或ppm的证据，不能从模型默认值生成生产配置。

对初始区间I和当前区间J，读数差下界`max(0,J.lo-I.hi)`，上界`J.hi-I.lo`。速率误差为d ppm时，真实年龄上界取`ceil(delta_hi * 1e6 / (1e6-d))`，下界取`floor(delta_lo * 1e6 / (1e6+d))`。全部BigInt整数运算，向不利方向取整，不用浮点临界值。

- 首项事实年龄上界<=3000000us才可过3秒门槛；恰好3000000接受，3000001拒绝。
- 剩余授权下界=`budget-age_upper`。收到云端剩余时间后，再减Windows**完整RTT上界**；不能加回半个RTT或比较两机wall/uptime。业务还须严格>3000000us；恰好或略少均拒绝。
- 两端读数基准可以相差任意固定offset，绝不比较两台机器的绝对boot/wall，只传已绑定且保守的剩余量。
- 速率/误差/夹取宽度只扣预算，不增加任何230/245秒、20秒、120秒、300秒或3秒预算。

## 从数值计算连续性，而非continuity=true

每个采样携带host/boot/process epoch/time-domain/source身份指纹和连续sequence。同机boot/work任一读数回退、指纹变化、序号缺口、夹取过宽即失效。boot经过区间与work经过区间严格分离且boot更多，表示可观察的OS暂停；wall经过区间与boot区间不相交表示本机跳时/不一致；监控间隔上界过大表示连续性未知。任何一种都毒化当前模型，后续正常样本也不能自动恢复旧授权。

该算法不能证明任何实际采样器如实提供指纹或硬件误差已被界定；这些都需后续适配器/部署证据，当前没有。添加`continuity:true`是非法字段，不能使未刻画VM profile通过。

`OfflineTaskBudgets`只用真实合成数值触发上述判断，随后使该模型中**全部未消费任务**转maintenance。JSON往返/新process epoch后，旧任务只有维护状态，没有可恢复的进程内stamp；同taskId禁止重新issue，不能换新epoch/新时间起点偷偷复活。它没有清锁/rearm接口，不是实际持久化层实现，不覆盖不同taskId的业务去重（仍由原合同负责）。

## 必须保留的VM不可观测性反例

设轨迹A是真实经过10ms，轨迹B是在虚拟机所有客体时钟同时冻结10秒后再工作10ms。若两者暴露的boot/work/wall/sequence/epoch完全相同，任何只看这些输入的确定性算法都无法辨别真实年龄。本测试保留相同输入的双场景，证明条件性“OS语义成立”模型会对两者给同一答案，**不是万能暂停检测器**。

因此`uncharacterized-production-vm`无论看起来多正常、是否额外声称continuity=true，一律不允许创建授权模型。只有合成的“物理OS语义”或“计入暂停的超管语义”假设可用于离线正向计算；这些标签不是可复制进生产的认证字段。当前Linux VM未获得实际超管/暂停边界证据、真实误差/漂移上界，故实际生产仍不能据此启用v2。也不能以测试主动调用一个poisonEpoch方法冒充真实检测：本模型未提供该方法，OS暂停由输入区间计算，但全冻结反例仍明确无法检测。

## 实际验证与未验项

27项离线测试覆盖两种拟定源配置、数值暂停、监控断档、5种身份切换、同机wall前/后跳、固定offset、回退/宽样本/序号/伪continuity、缺界与错误API、未刻画VM、不可区分轨迹、外来stamp、完整RTT扣减、45组量化误差网格、精确3秒/余量边界、BigInt负值/超界、速率/夹取扣减、全任务维护及JSON重启不rearm。

验证命令：`node --test verification/wecom-clock-authority-20261102/model.test.mjs`。实际源码/输出hash与回执另存本目录。不把45组参数网格额外加成独立测试总数。

仍未验证：实际Linux/Windows API调用与精度、原生休眠/VM暂停、生产source指纹、采样监控调度、Windows journal权限/断电/API、真实PG与旧checkpoint顺序、业务与物理义务的产品v2实现、43旧义务恢复及真机API完整验收。本阶段不需要也没有OS/ADB/Agent/权限/生产动作，合同仍待review，产品实现仍未放行。
