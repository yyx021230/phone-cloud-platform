# 原查询自动恢复与有界跨机（本地候选，未上线）

用户要求修复164公开API一直处理中，普通异常自动恢复或保留原ID转交；先本地，再外部真机；在用手机避让，ADB/SYSTEM不动，维护需告知。基线为实际线上lookup-account-offline-20261016-deployed.1 / 64e09fb / 63193b6f，详见BASELINE。分支codex/lookup-auto-recovery-20261016，开始1768a905，干净。共同流程2026-09-30/SHA256 0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b。R2调度状态变更，真实发布R3维护另确认。

## 已确认原因

50条外部真机批次中164已经提交搜索，观察预算耗尽后返回alipay_lookup_result_unconfirmed。云端reconcile只置needs_recovery，公开GET不会触发管理retry，故原查询一直processing。325秒换键仍同ID/1attempt证明防重有效，但不是查询完成。具体页面/OCR为何未读到确定结果尚未确认，本候选处理云端收尾缺口，未修改OCR/点击脚本。

## 本次最小变更

只发布server/managed-lookup.mjs和managed-lookup-platform.mjs。对prepared-v1异步业务，必须同时证明同queryId的automation job和Windows task均failed、没有在途/未知/拼图/掉线，才进入普通自动恢复。对首次终态异常，且账户/Agent身份仍与本次attempt一致，按原queryId运行一次query_resume，沿用已验证账户，不插入探测，不重新走首次输入路径。既有执行器可能在明确输入为空或人工验证后的准确页面条件下继续提交，不能承诺上游“恰好一次”；外部换键重提不会创建新逻辑请求。

同一手机恢复后仍终态失败，或账户身份变化，不再在该机反复操作：先stop并等ACK，再保留lookupId排队到另一台就绪手机。本请求永久排除已失败的该物理机，该机临时退避30秒、后续正常探测可恢复；这不是账号8小时冷却，也不冒充账户掉线。预算持久化，最多3台物理机、每台1次原查询恢复；均失败则停止确认后明确lookup_recovery_exhausted，不能把异常伪造成name空。无可用机沿用既有排队/执行截止时间，不重置deadline。接收成功结果优先于清理/异常；取消不再转交。

自动恢复/停止共享原5执行名额，避让实时控制、离线和其他任务。执行未知、未确认终态、拼图仍保留原独立流程，旧单机/同步接口不自动改行为；账户掉线仍通知/单轮隔离并转交。原API三接口、Key和返回结构保持，无SQL迁移；automaticRecoveries、recoveryExcludedDevices只是原持久JSON的新字段，旧版忽略它们。没有Agent、ADB、身份/密钥、Windows、USB、媒体、依赖变化。

## 本地验证与边界

851/851完整回归、check、14新专项/27恢复+掉线专项通过。实际回环HTTP+5模拟机通过：原queryId恢复、第二次终态失败stop后同lookupId跨机、账号掉线业务同ID跨机、其他任务独立完成、换键防重、新轮重探和服务重启。HTTP最初仅测试夹具误把云端resultId当作Agent payload字段，修正为对账原池queryId后通过，失败日志保留；没有为通过降低运行保护。193冻结文件哈希不变。模拟不是真机，尚未验证本候选生产/PG/164原请求。

复现：python3 releases/lookup-auto-recovery-20261016-rc.1/verification/prepare-local.py --out /tmp/UNIQUE；使用已有兼容node_modules缓存；npm run check、npm run test:screen、node verification/automatic-recovery-http.mjs。不从根仓旧业务启动。只读前置哈希核对，代码自审完成，无委派审查。

## 发布和回滚准备

以实际63193b6f增量构建两文件镜像；核对ACTIVE、37运行hash、完整Compose链、最新数据库和旧镜像/配置备份，真实媒体宿主D-075 live。云端需要重载，Agent不重载；确认当时在用控屏影响后再切换。用户已授权后续外部API验证，先保留164原lookupId观察自动恢复，再有界原表号码与掉线/触限分支，故障不能人工伪造。原任务到期/运行状态需切换前复核，不能改截止时间续命。

回退旧63193b6f镜像与原完整Compose链，保留新增查询及预算字段，不恢复整库。旧版会恢复needs_recovery待人工路径；若新任务在执行先排空，在维护授权内回退，不盲目重放。严禁顺带重启Agent/ADB/SYSTEM/USB/媒体。候选标签不可移动，真实发布和回执后续分开；远端未推送，根仓既有修改保留。
