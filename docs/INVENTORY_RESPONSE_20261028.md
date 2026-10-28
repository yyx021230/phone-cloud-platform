# 库存同步响应压缩候选 — 2026-10-28

状态：本地候选，未推送、未部署。标签 `inventory-response-20261028-rc.1`；分支 `codex/xhs-inventory-transport-20261028`。本阶段不包括候选真机租约适配器。

## 范围与基线

- 整合基础 `b85ed14b9e93e8a4ac65916b744e31c02a4e8775`；直接父版本 `00cfe56f7da24baec40f4ebbcf1f0da84b9f3fbf` 包含 HTTP 接入。主工作区既有改动未写入。
- 运行改动仅 `server/inventory-sync-response.mjs` 和 `server/index.mjs` 的 import、库存成功返回；两份测试与本回执/主文档同步。无数据库迁移、配置、依赖或 Windows 文件改动。
- 今日生产 index SHA256 `b42951d9bec95d368dd381a920a18f53329cab53f85ee5056e3a0d3aa3c8f397`；生产镜像 `sha256:5ab68ecbc67dfd4815f3ec93b0d3dd6265acd6a5d044867c3e04904636e80649`。生产与整合基线不同，不得单独覆盖整个 index。
- SYSTEM ADB PID 20316、Agent PID 14540；本阶段未执行手机动作、共享服务变更或生产写入。共同流程修订2026-09-30，SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。

## 行为与兼容

仅 `POST /api/v1/windows-agents/:id/devices/sync` 鉴权成功响应按 Accept-Encoding 协商 gzip；压缩前 JSON schema、全部设备/锁/身份数据不变。错误、heartbeat、普通库存 GET 不变。1 KiB 至 4 MiB、level 1、最多2个在途、150 ms等待；无队列，容量不足/错误/超时退回原 JSON。deadline 后保留 native 槽直到真实回调，客户端断开不再发响应。

自审结论：鉴权、更新、审计、持久化和锁逻辑未移动；不改90秒库存门禁或Agent25秒传输预算。压缩是可退化优化，CPU过载/超大响应/持续断网仍可能失败，不能承诺所有手机每天成功。无独立审查者。

## 实际验证

- 8项模块和真实本地平台HTTP：编码协商、完整UTF-8解压、拒绝压缩、错误/超时/迟到/断开/并发容量；普通Node fetch自动解压；鉴权/heartbeat/库存接口保持。合成限速回环链路25 KB/s、1.2秒预算：identity超时，gzip完整到达且逐字节一致。
- 39/39相关回归，0跳过：上述两文件、server/xhs-data-collection两测试、windows-agent/src/xhs-data-collection、server/screen-relay、server/device-lock-compatibility。
- 34/34本地PG集成，0跳过：server/xhs-batch/*.test.mjs、server/xhs-data-collection.http.test.mjs、server/inventory-sync-response*.test.mjs。隔离PostgreSQL 16、独立测试库；包括批次重启、持久化、签名HTTP和Python SDK。采集API fixture使用独立JSON后端。
- 根 `npm run check`、`git diff --check` 通过。上述集合有重叠，不相加。首轮HTTP fixture heartbeat路径错误导致1项失败，更正为真实路由后通过，业务未因此变化。
- 未验证：本轮压缩在生产网络上的实际改善、候选真机单/双/五机、最终镜像、生产迁移和定时计划。旧rc.4五机证据不冒充本版本验收。
- 脱敏日志与文件哈希见 [证据目录](evidence/INVENTORY_RESPONSE_20261028/manifest.json)。私有设备/账号与DB连接信息不入仓。

## 只读数据库与目标快照

数据库总存储8,701,115,751字节；phone_cloud_state关系连同索引/TOAST为239,001,600字节，估计活行1，data类型json。不是展开JSON大小；未读整份data、未dump或下载。元数据查询有3秒statement/4秒query预算。批次表尚未出现。100槽位/66手机绑定一致，当时7槽位不可用、9槽位占用，实际执行前必须重新核对。

## 回退与交接

本候选无上线，无需生产回退。集成时仅cherry-pick本范围提交；撤销时反向撤销该提交的两处接入并移除本模块，其他功能保持。直接父版本与旧发布对象保留，不移动标签。正式部署须另保存当前实际镜像和配置、排空后验收；若压缩导致错误/缓存陈旧/其他回归，停止推进并按获准范围切回部署前不可变镜像，不整库恢复、不动Windows/ADB/媒体。此处仅源码回退方案，不声称最终镜像回退演练已完成。

真机适配还需解决：现有正式XHS任务固定运行线上脚本；既有灰度用控制会话获得真实排他占用，但当前采集器只认可同taskId/appSlot的xhs_data_collect。不能删除占用、伪装缓存或放宽正式采集器门禁；应单独验证隔离适配器的实时所有权/失锁停止/清理，再执行空闲目标。

### 10:42 接续核对：现有工具不足以直接完成候选真机验收

本地直接导入当前采集器 `assert_idle` 的6个无手机反例全部符合预期：空闲和同任务同槽位可进入，本次持有的screen会话、其他XHS任务、错误槽位、陈旧库存均拒绝。另直接运行锁兼容函数确认：管理员创建控屏可能与ready且无pendingJob的查名任务共享；因此“创建了screen会话”不能单独证明没有其他活动锁。既有fault-hold/fault-observe仅提供控制会话获取/观察/释放，不是可直接供XHS使用的安全适配器。

仅在隔离候选中验证锁身份在设计上可行，但目前缺以下实现与反例证据，不能调用真实采集器后再补保护：

1. 获取时同时排除现有全部任务锁、托管查名通道与控屏；获取后核验只有本次锁，管理员共享规则不能当作排他成功。记录deviceId/serial/slot/xhsId、候选jobId与真实sessionId的一对一不可变映射。
2. 隔离runner只能接受该映射和当前真实会话、真实锁、90秒内设备库存；直接返回实际设备信息，不改生产cache、不把screen占用改写成xhs_data_collect，不删除其他占用。原任务/槽位/绑定校验须等价保留。
3. 在每次设备动作前及等待中确认本次会话仍有效、没有其他活动锁，失锁/连接丢失/证明过期即取消；原collector部分finally恢复与native临时文件清理未调用guard，新适配器必须覆盖这些路径，不能失锁后继续向他人手机写设置。
4. 仍持有租约时先退出本次runner并完成目标设置恢复，再释放自己的会话。失锁且无法安全恢复时保留独立恢复账本并报告，不能删账本、抢回手机或强行恢复。验证取消、超时、迟到回执、重复释放以及新持有者出现等反例后，才进入单机→双机→五机。

这些是候选适配器工程缺口，不是需要正式部署的理由。未创建真实screen会话，未在候选上跑手机；既有生产任务结果不能代表本轮候选验收。实际生产XHS入口不支持指定隔离runner，且线上尚无批次capability；也不能用本地假capability冒充生产支持。

结束只读核对：ADB/Agent仍为20316/14540 SYSTEM，与开始时间和可执行路径一致；采集器/helper/consumer/Agent index四个hash逐项相同；缓存年龄4.371秒，待恢复账本0。100槽位/66手机绑定仍全部一致，第二次快照为7不可用、8占用（与初次9不同，是正常并行业务变化），不沿用旧空闲列表操作。脱敏接续证据见同目录 `readiness.json`；私人原回执不入仓。
