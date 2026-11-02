# 企微物理清理服务端候选 rc.1

2026-11-02。本地候选，未上线、未推送、未访问生产、未操作手机。
分支 `codex/wecom-cleanup-obligation-20261102`；独立工作区 `wecom-cleanup-server/phone-cloud-platform`；基线 `2b5e932b3b96076808387b9d89dfb8aebb087229`。
本次延续查名停止证明原则，但这是独立企微服务端修复，不能计作查名原机根因已全修。
共同流程2026-09-30，SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。

## 问题与改动

旧真实loopback HTTP反例：原企微任务failed且cleanupConfirmed=false后，同机另一槽新业务仍201受理；独立基线重放期望409实际201（退出1）。业务终态释放普通锁并不证明原读取器退出。

- 新独立物理义务在任务领取前持久化；失败/取消/过期/归档、锁TTL和重启不解除它，同机所有槽和仅serial派发均受阻，其他手机正常。
- 原reader精确PID/creationToken/machineId登记并ACK才允许业务lease；父Agent真实close后另开全新verify-only任务，两帧新鲜物理证明才解除。缺旧host身份只保留maintenance，不造ACK、不杀进程或移除forward。
- 同Agent轮询补排一次漏掉的首代verify；失败/过期不无限重试原代，不重放原业务。proof迟到状态不降级，原业务结果及send claim保持不变。
- 精确旧锁/义务/验证任务同事务保存。写入失败503并回滚，独立checkpoint看不到未提交release。支持实际Postgres结构写、快照写、双写；未决义务超5000拒绝启动，不截断后放行。
- 卡片展示固定“企微清理待确认”和安全阶段；不暴露host/nonce。新控制受占用门槛约束；媒体、点击映射、现有控屏传输及Agent文件未修改。

## 实际验证

- `node --test server/wecom*.test.mjs server/postgres-repositories.test.mjs server/device-occupancy.test.mjs server/lookup-chain-reliability.test.mjs server/lookup-legacy-stop.test.mjs server/lookup-stop-proof.test.mjs`：最终130/130（全量后补充复测）。
- 后续legacy无job及serial大小写复核：物理helper+真实JSON HTTP 35/35。
- `python3 verification/wecom-cleanup-v1/run-postgres.py`：真实本地一次性PostgreSQL，三种持久化模式各1/1；包含真实HTTP、进程重启、实际归档、注入数据库写入失败及事务回滚、旧协议启动maintenance、业务过期再重启仍阻断。不是repository mock。集群只监听loopback并在finally停止删除自己的临时目录，不读取生产凭据。
- 真实JSON HTTP：同机409、另一机派发、host未登记无许可、重启归档、文件写入失败、fresh proof、迟到failed不能降级；原任务不复活。
- 本地helper覆盖错误绑定/代次/Agent/机器/host token、残留forward/Poco、过时/未来/单帧/缺字段proof、写入期serial-only派发和checkpoint、精确原锁回滚/错归属、不循环失败代。
- 根检查及全量屏控/服务端/Agent自动回归的最终结果见本目录 `RESULTS.md`；这些不等同真实手机验收。

首轮失败保留：原业务HTTP测试未声明新能力、VM提取函数缺新依赖，已更新测试接线；隔离worktree缺Agent本地依赖，复用已存在node_modules链接，未改锁文件/依赖版本。实际PG快照模式曾暴露核验领取只存快照而结构行仍queued，已补同事务核验任务并三模式复测。不能隐去这些失败或将退出0当真机证明。

## 未覆盖与上线条件

- 新协议真实Windows SYSTEM Agent主循环、父reader实际close经HTTP登记及双帧证明的真机全流程未验；由企微窗口实现Agent，当前本分支不含其改动。原149/152查名、188新stop证据不适用于本企微协议。
- 生产数据库、真实Agent重载/进程崩溃、生产混合版本与时钟偏差、真实scrcpy forward共存、全池长期运行未验。合法媒体forward会拒绝核验，不为通过删除。
- 未逐路径注入通用cancel端点的真实PG失败；当前有真实过期/重启、独立持久义务及局部取消回归，不能宣称所有取消旁路已验。
- 原业务已终态但历史完全无可信host/义务的记录不批量修复；maintenance不会凭空变可用。旧host关闭ACK丢失且父进程已消失仍需明确单机维护方案。
- 全量部署必须同时匹配Agent协议、重新核对ACTIVE/文件哈希、备份、D-075真实宿主只读核验及明确维护授权。本阶段没有发布授权。

## 回退

本地可直接保留候选分支并回到基线，不移动旧标签，不覆盖原工作区。
若未来部署后产生未决义务，旧应用不能安全忽略它们；回滚须保留义务并关闭企微新派发，不能删除锁或伪造清理成功来恢复接单。生产回滚执行不在本次范围。
