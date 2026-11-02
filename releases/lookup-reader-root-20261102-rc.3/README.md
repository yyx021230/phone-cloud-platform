# 查名停止入口绑定候选 rc.3（仅本地）

基线 `7957e07d27f86cbb6cbddb0849d7ef4ffab5a0f7`，分支 `codex/lookup-reader-root-20261102`。延续 L03/L04，不新增 legacy 数据迁移，不重新操作线上四台，不启动第三轮真机。风险 R2：仅云端 stop 入口与本地验证；Windows、共享 Agent、ADB、SYSTEM、媒体及宿主机不变。

## 已确认的调用链

51/52/54/154 的已保存只读记录均为 session stopping、pendingJobId 空、lookupStopFailure 存在、channel retry2，session/device/generation/client 仍完整。旧任务没有 runtime。生产旧代码耗尽后跳过；候选 L03 的 stopUnconfirmed 分支在 runtimeLoss 之前，**不需要旧 runtime 就能安排新的停止清理**。

“旧 runtime 缺失所以无法清理”是不准确的概括：缺 runtime 阻止的是 L04 对旧 running 是否已丢失的推断，不能用当前 runtime 回填旧投递。L03 为明确失败的停止新建一个 task，等待这个新 task 的实际清理证明，是另一条已有路径。本轮四种旧状态的正例在修改前即通过；没有开发新的历史迁移系统。

## 本轮最小修复

1. stop 原来只按 sessionId 查 session，旧 channel 可能指向新代次或异设备的会话；pendingJobId 错关联时还会先取消别的 job/task。现在在任何取消、建 stop、字段更新前核对 session 的 device/generation/client/source，以及 pending job/task 的 device/session/generation/job/type/source/client。缺关键关联则拒绝，保留占位供核对；不猜测补元数据。
2. 离线检查提前到取消前，设备不可达时不先污染运行任务。
3. 保存失败时原 Object.assign 回滚不能删除取消操作新增的 completedAt/result 等字段。现在按原副本精确还原 session/job/task，新增 job/task 由原 checkpoint 回滚删除。

不改变 API 返回契约、已有重试间隔、并发预算、物理停止证明格式、数据库 schema。新停止仍保持原 generation，只产生新的 task/job，不复活取消请求，不把旧终态改成成功。

## 本地验收与演练

`server/lookup-legacy-stop.test.mjs` 使用实际 adapter、调度服务、文件 store、租约函数和从实际 index 提取的 cancel/sync/finish 函数。任务执行/通信与存储失败为合成；不是原机或隔离 PostgreSQL 验收。

- 初始14项在基线运行：2通过、12失败（11种错绑定未拒绝，1项回滚残留）；修复后14通过。随后扩为22项。
- 17种错绑定均在任何写入/取消前拒绝；有效 pending 可撤销，旧租约不可再领取/ACK；设备离线无副作用。
- 四旧形态（前三个关联已取消探测，154关联查询缺失）导入临时文件库，通过实际 scheduler tick 创建4个全新 stop。提交前不可派发，提交后新任务可租约/ACK；旧任务的 runtime/ACK/终态完全不改。
- 重开文件 store 不重复创建 pending stop；旧已失败 task 的伪迟到成功不能释放。仅新任务严格匹配的模拟清理证明能结束会话/释放 channel；无业务复活或新 start/query。
- 新 task 提交不匹配 proof 时保留占位；保存失败后会话和旧任务完全还原。
- 详细实际通过数、回归入口及环境失败另见 TEST_RESULTS.json，不以旧数字代替当前结果。

## 将来真实验收（本轮不执行）

1. 取得具体部署/维护及单机灰度授权；新鲜核对 ACTIVE、占用、相同 session/device/generation/client、pending 与旧 stopFailure，不直接清锁或改取消结果。
2. 先一台原故障空闲机观察新 stop 从持久化、领取、ACK 到实际 worker 清理；保留原任务和新任务各自证据。没有有效清理证明就仍占位，按已有退避重试；人工控制中暂停。
3. 核对新 task/device/session/generation 全匹配且 readerCleanupConfirmed 来自实际清理，才允许原预约释放。冷却、既有结果和其他手机状态不变。
4. 分别验证失败继续保留、迟到旧事件无效、正常恢复后重新探测与下一条；再扩大到其余原故障机。共享 Agent 重载与旧 running 丢失属于 L04，须另行有界验收。

本候选没有这四台的新 stop proof，也没有新 adapter 的真机/生产验收。149/152 native.2 只绑定旧固定代码 dfa4102，不能挪作本补丁真机证据。永久清理失败、自然底层失响应、共享主循环/outbox/runtime、自然触限冷却与全池吞吐继续开放。

## 版本、审查与撤回

本地候选，不推送/发布；保留已有标签及未跟踪 releases/lookup-natural-observation-20261030。代码文件仅 server/managed-lookup-platform.mjs；新增测试、主文档/台账和本材料单独提交。旧字段与证明协议兼容，无 SQL 迁移；未部署时撤回只需不采用本候选，不能因此恢复生产数据或删除清理待办。若将来已发布，回退旧应用须保留所有新增 stop/清理证据，并知晓旧版可能重新出现 retry2 跳过，不能把回退当作清理完成。
