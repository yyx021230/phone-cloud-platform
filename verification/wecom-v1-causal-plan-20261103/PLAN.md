# 正式WeCom v1跨机器UTC误拒：最小因果补丁提案

基线4ed67ae4e1fbb658fc9694ec99150e776ed138ba，root要求先方案，不改共享入口。延续已有独立physical obligation、原绑定/nonce、实际Node child/PID/出生token、真实close、非到期整机gate、未知不重放和D-075/ADB身份冻结。替换的是v1把不同主机UTC用于出生/关闭/采样因果与lease剩余的判断；不是删除守卫或放宽时间。通用v2 issuer/profile、M3、ProgressHead/Receipt、outbox与raw parser不作为本补丁前置，不移动/清理其既有候选。

## 1. 当前具体问题与保留边界

server/wecom-physical-cleanup.mjs:47–77将Windows host.createdAt/observedAt与cloud now/lock.createdAt比较，:131又将Windows snapshot UTC与cloud pickedAt/now比较。windows-agent/scripts/wecom_platform_preview.py:154–174用Windows time.time比较cloud lease expiresAt；cleanup verify Node/Python也比较cloud pickedAt与Windows采样时间。这些跨域条件可在时差下误拒，本地±300ms反例已成立，43生产失败唯一初因仍缺原ready正文，不扩大为已确认根因。

不能改OS时钟/重盖原出生时间、只删host首关、放宽3秒/300秒/230秒/210秒预算。新连接与实际原ADB进程绑定仍由root协调的原生执行桥小片解决；本时间补丁不代替该身份证明。旧43及147/52隔离不动，155/157查名排除保持。

## 2. 主host登记：私有管道因果替代跨机UTC先后

使用**原binding.nonce**，不改v1 binding的10字段、不另签claim。Node为这一次spawn生成私有pipeNonce，先向刚spawn的child stdin发送小bootstrap（原binding+pipeNonce，**无手机号/备注/业务配置**）；child在真实SystemRuntimeGuard下返回ready，回显原binding nonce和pipeNonce，并报告未篡改的实际PID/创建token/machineId/createdAt。

Node必须核实际spawn child.pid、同机OS出生token、原SYSTEM父子/执行入口/当前ADB连接守卫，以及本次私有pipeNonce。相同PID不同token、旧ready、其他pipe、旧binding一律停；不是相信stderr正文说“我是新child”。然后按原Agent身份向cloud登记同一body。cloud核原running任务、device/serial/slot/owner、binding.nonce与这次bootstrap关联，原hosts只能首次登记或同body幂等，不能替换host。

**只在持久ACK已知、且原child还活着/未取消后才释放UI配置**。ACK未知只有限重送同body，不重盖时间、不新spawn重查。cloud不再将Windows UTC与cloud lock/now比较；createdAt只作原始审计值，格式/与同机creationToken一致性仍核。此处信任边界仍是固定实际Agent/Node执行与其真实私有child，nonce本身不证明进程身份。

## 3. 原host close：真实owned close事件，不用跨机UTC排序

保持原Node owned child的close事件为唯一关闭事实。closed请求带原binding、已登记原hosts、同pipeNonce/hosts关联和原事件类型； observedAt保留原Windows审计UTC，不与cloud now或出生UTC做授权比较。Node同机单调时序确认close发生在本次spawn/ready之后，不能以kill尝试、当前PID不存在、另一个child退出或新代次替代。

cloud只允许已有原host记录且关联完全一致的单向转换；同body丢ACK可原样重送。旧43没有原host/PID/pipe证据，不补造nonce、登记或close，不自动核销。新能力只作用于具备新握手的真实任务。

## 4. 清理双帧：原verification的一次cloud challenge，3秒不放宽

在原host真实closed、原业务terminal、原持久physical hold仍有效且verification已真实领取后，由同Agent请求**绑定原verificationId/nonce/taskId和binding**的一次challenge。cloud服务在自己的进程epoch中记录单调issue时点，nonce/原关联/未消费状态随**现有义务**持久化；不新建通用issuer/表。响应丢失只返回原challenge，不能重签或刷新起点。

challenge必须先到达该次真实verify child，再做两次新的固定包/forward读取；child回显原challenge，输出有序seq=1/2与自身单调duration，UTC只审计。沿原verify_empty和原scope，不发新业务，不碰他人forward。Node在父侧计完整挑战请求RTT、child执行与**真实close**耗时，close后才发原proof。Python和Node都各自核本地单调预算，不比较两进程的绝对单调起点。

可在verify child已完成无手机动作的本地身份初始化、正等待私有管道时才请求challenge，避免把解释器启动当作采样窗口；但第一帧或任何本次固定读取绝不能早于challenge。不能先取两帧再请求nonce替它们补新鲜度。

cloud按自己的同epoch单调经过时间，在受信接收/验证原proof时核issue→proof的整个窗口**不超过原3秒**，并核两帧/顺序/固定包absence/serial forward0、原nonce/代次/同机host关闭事实。网络、排队、读取和close都不能从窗口中扣除；本地预算也须计入，不只核“最后一帧还新”。不能等过3秒再给旧事实重盖接收时刻。精确接收/验证判定点与存储耗时边界由root先审；不得把异步排队后的旧授权回溯为有效。

消费challenge与原proof/任务终态/physical hold解除，沿**既有每device事务、committing fence和checkpoint**原子持久化。存储未知继续原义务，不拿回包缺失当已清理；已提交同原proof仅幂等回原结果，不启动新核验或业务。服务重启丢单调上下文时，旧challenge不可从wall重建或自动续窗：原义务保持maintenance/unknown。后续若需新verification代次，沿另审的既有有限恢复策略，不由此隐式授权。

## 5. 原业务/核验lease：server剩余量，Windows扣完整RTT

保留业务300秒、执行父230/子210秒与3秒余量；verify原120秒及原worker预算也不增加。创建真实业务lease/verification时，server在本服务epoch登记原单调deadline，不能首次Windows请求时重启300/120秒。lease reply增加固定协议的remainingMs/epoch/原scope；expiresAt保留审计与旧合同显示，Windows不再用自己的wall减它。

Windows在请求前/后取本地单调点，保守deadline=`请求开始点+server返回剩余量`（等于收到时剩余扣**完整RTT**），再与原执行deadline和此前已知保守deadline取min。余量不够3秒就拒绝；每次实际动作仍重新核原lease，不缓存valid，不加回RTT、不延续已否决代次。server用原单调deadline计算剩余，重启后无原上下文拒绝/maintenance，不从旧UTC重新授予。

这里只给特定WeCom v1执行/verification的因果和预算，不宣称解决任意虚拟机全部时钟同时冻结等不可观测情况。真实SYSTEM/部署时钟与连接行为仍需实际验收，不能把已有模型或Administrator样本当该证据。

## 6. 产品影响面与兼容门禁（仅拟动文件）

|范围|拟最小改动|
|---|---|
|server/wecom-physical-cleanup.mjs|原host/close/proof validators替换跨机wall条件为固定nonce/挑战/同代次因果；原绑定/包/forward/未知保护不变|
|server/wecom-cleanup-service.mjs|特定义务的单调epoch/deadline与一次challenge；复用原transaction/checkpoint/commit fences；不接M3/ProgressHead|
|server/wecom-preview.mjs与server/index.mjs窄hunk|原lease剩余字段、创建时登记原deadline、能力门禁/既有cleanup路由增加challenge动作；shared入口由root所有者合，不整文件覆盖|
|Agent wecom-preview-task.mjs / wecom-cleanup-protocol.mjs / wecom-cleanup-verify.mjs|一次bootstrap私有nonce、实际spawn/ready/close关联、挑战往返与close全预算；原结果与有限同bodyACK重试|
|Python wecom_platform_preview.py / wecom_host_identity.py / wecom_cleanup_verify.py及必要contract叶|bootstrap先于UI配置、原始OS身份保留、lease RTT下界、双帧单调duration与原challenge回显；实际读取/搜索/保存/发送算法不动|
|Agent共享index窄能力声明|仅协商此握手/挑战能力，root协调；旧Agent不得领取需新能力的新任务|

具体wire字段/能力名另随小合同审定，不能把本提案直接当已实现。避免与此前未接入的v2 binding schema同名；旧v1有未决义务不自动升级/重跑，不兼容就明确maintenance，不静默降级到跨机器wall守卫。无需DDL、媒体/屏控/共享ADB生命周期/身份/keys/入口或手机设置变更。需加载Agent时仍先说明影响并取得该次维护授权。

## 7. 本地最小验收与后续真机

先固定host/close/bootstrap/lease/proof小合同与代码，再用原真实OS子进程/loopback平台、原JSON/PG持久化三模式验证：±300ms/±5分钟审计偏移不改变因果；错nonce/旧pipe/PID复用token拒绝；ACK丢失不放UI/不换body；双帧、网络、真实close、排队合计在3秒边界及超界拒绝；旧proof/重启epoch/错误scope不释放；完整RTT/原300秒不延；存储失败/回复丢失保原义务；其他手机与既有屏控回归不变。不得用模拟结果抵消SYSTEM/SDK/手机未验。

root核准具体候选后，重新核版本/身份/完整占用，只选当时空闲主号1台正式内部preview、固定尾6441，原ID到发送前和真实close/proof；其后才下一台/分身。外部customer-invitations POST会真实发送，仍不得作为本轮入口。此提案没有改产品、跑新测试、发布或操作手机。
