# 外部企微预览合同 draft.1（待评审，未实现）

基线da8a2c133c92c74894fd28375071092343e8a15b/只读矩阵，生产代码32c。本文件延续用户“仍只到发送前”、四业务字段、现有管理员认证、未知不重放和独立物理义务，精化后继customer-previews建议。**不表示新增产品路由/数据库模型已获批准，更没有发布或native授权。** 当前可调用的外部添加接口仍只支持send。

## 1. 路由、字段和认证

拟新增POST `/api/v1/wecom/customer-previews` 与GET `/api/v1/wecom/customer-previews/{taskId}`。body只接受deviceNumber/appSlot/phoneNumber/remarkName，沿用现有类型/Unicode长度/默认备注规则；双开必须选明确槽位。路由在服务器不可变地设为preview，拒绝mode/send/previewOnly/Android用户/ADB身份等额外字段。内部task payload必须为mode=preview、previewOnly=true，不能从请求或旧任务推断可发送。

沿用现有有效管理员Bearer：缺失/过期、普通用户或查名API Key均按现有规则401；不能读取其他管理员任务，统一404而非泄露存在性。owner取稳定userId，不取用户名/token字符串；同用户正常换token不改变请求作用域。两个管理员可有相同key但不能串读，涉及同一手机/账户的真实占用和未知写入保护仍跨管理员生效。不存在匿名公共调用、新增用户/永久API Key或权限扩大。

拟要求`Idempotency-Key`头为16–80个ASCII字母/数字/下划线/连字符，值大小写敏感，不自动trim；缺失/不合法400且未受理。客户端首次请求前生成并持久保存，断线只重用原key/参数，不自动换key。无额外表单业务字段。

旧POST `/customer-invitations`及其GET仍是send合同。新preview GET拒绝send ID，旧send GET拒绝preview ID；客户端遇到preview 404不降级调用send。不得在新路由复用旧publicInvitation投影把ready映成failed或把preview ID包装成send结果。

## 2. 幂等的精确定义与归档

逻辑幂等scope为`stableUserId + external_preview_v1 + key`，与内部preview及外部send分离。首次受理固定规范化四字段、服务器默认值版本、所选物理设备/槽位/Android用户与请求摘要。deviceNumber整数/同值数字字符串归一；仅单槽位时的省略appSlot固定为首次解析结果；备注空白归一沿用当前规则。

同key重试先查原scope回执，再按**首次解析/默认值版本**归一比较，不因今天映射/默认槽位/占用已变化就换手机、换账户或创建新任务。同key不同规范化参数409 `preview_idempotency_conflict`，不修改原请求；相同参数200复用原公共taskId，即使原手机当前忙/离线也只回原任务。重复提交不是重新执行许可。

需要一个独立、持久的preview回执集合，不能仅依赖可归档automationJob/普通锁TTL。逻辑字段至少为scope/key摘要、规范请求摘要、首次解析版本和绑定、publicTaskId/jobId、originalWindowsTaskId、受理/业务/保存状态、物理义务关联、归档标记。具体JSON/PG载体和必要迁移必须单独固定/审查；本阶段没有加集合、建表或宣称现有persist函数已自动支持。

拟定保留政策：

| 数据 | 保留/归档条件 | 旧key或旧ID行为 |
| --- | --- | --- |
| queued/running、任何备注保存未知、未决物理义务/未决提交 | 不按时间压缩/删除，保留原回执与必要关联 | 同key原ID/当前状态；没有自动新任务 |
| 已知终态、保存无未知、物理义务已确认结束 | 完整外部结果至少保留30天；30天仅是可压缩资格，不自动启动生产清理 | 压缩前同key200原ID、GET200原结果 |
| 已授权归档后的完整结果 | 保留独立key墓碑及原publicTaskId、摘要、owner/scope和最终状态；普通业务归档不删除墓碑 | 相同key同body POST410 `preview_result_archived`并带自己的原taskId；GET原ID410；不同body仍409；绝不新建 |
| 命名空间退役 | 需版本化迁移/明确数据处理授权；活跃external_preview_v1中的key墓碑不设自动TTL | 退役scope所有新旧POST统一410 `preview_namespace_retired`；不能删墓碑后在同scope重新接单 |

不承诺无限完整历史；但活跃scope内key不能静默重新成为“未见过”。本版不提供删除/重置幂等key端点。任何归档/清理仍遵守备份、变更预览及授权流程，未决记录不可为腾空间而删除。未知回执及按账户/目标的写入保护不能随job归档消失。

## 3. 受理、taskId和GET映射

公共`taskId`固定等于该preview的automationJob.jobId；不返回Windows taskId或obligationId来代替。回执持久保存jobId与originalWindowsTaskId，Windows payload.automationJobId必须一致，核验cleanup taskId永不替换公共taskId。

首次HTTP202只能发生在**同一受理事务**持久完成key预留/回执、job、普通物理设备锁和唯一queued Windows task之后。提交持久成功前不向Agent暴露任务。key唯一约束、同key序列化和同物理设备gate都须真正生效，不只依赖客户端列表或单路由内存map。

提交保存未知返回503 `preview_submission_unknown`，不伪装accepted/不返回一个声称已受理的taskId；客户端仅按原key/body核对。若实际已提交，下次同key读回原ID；若已证回滚且任务从未可投递，才允许同key完成那一次有效受理。未知事务期间保持提交/派发屏障，不能用finally清标记后让半个任务执行。

GET按当前管理员+external_preview_v1+publicTaskId解析回执，再核job及原Windows绑定；不触发创建/重试/重新映射。自己的正常任务200；自己的归档墓碑410；其他管理员、send/内部preview错误命名空间及从未受理的ID统一404。存在回执但关联不一致/存储不可确认时503 `preview_mapping_unconfirmed`，不能伪装404或自行重建。202/200响应中的已接受taskId应始终有对应GET路径，除明确归档410或权限失效；未知提交的503与已接受ID语义分开。

物理义务在真实领取时与原Windows task绑定同事务创建；之后任何独立cleanup task都只更新该公共任务的清理投影，不改其原业务结果或ID。

## 4. 结果与两种独立保护

拟定正常响应字段：taskId/deviceNumber/appSlot/status/code/remarkSaveStatus/deviceReleased；reused仅POST回放出现。status为queued/running/ready_before_send/needs_attention/unknown/failed。原业务结果一旦完成不因后续cleanup成功被重写。

`deviceReleased=true`只表示**本任务**普通锁/独立物理义务已确认持久结束（或已证未投递无需义务），且无未决的物理释放持久事务；它不承诺手机此刻没被其他任务占用，也不解除该目标的备注保存未知屏障。调用方仍用设备目录即时available做参考，提交时再检查。false可与ready_before_send并存；unknown业务结果也可在后续物理核验完成后仍保持unknown而deviceReleased=true。

| 实际事实 | 外部status/保存状态 | 保护与客户端处理 |
| --- | --- | --- |
| 已持久受理、尚未执行 | queued / not_attempted | 普通锁保持，未证明释放前deviceReleased=false；只GET原ID |
| 原任务执行中 | running / 原事实 | 不因超时/新key另起任务；所有现有lease/身份/资源/占用守卫保留 |
| 已确认到发送前、备注confirmed或not_needed，0 send-claim/0邀请 | ready_before_send / 原事实 | 业务完成与清理分离；host/工具核验未完成仍deviceReleased=false；不是自动send许可 |
| 备注保存可能送达、读回缺失/传输未知 | unknown / unknown | 保留原请求，新preview自动重试不得换key重复保存；后续新的显式send是另一意图，跨mode是否需额外核对仍待策略决定 |
| 登录/验证需人工，且无保存未知 | needs_attention / 已知原事实 | 保留原ID，不新轮盲重试；真实host/工具未清仍隔离手机 |
| 已确认失败且无副作用未知 | failed / 已知原事实 | 同key永远回原失败；即使以后获准新意图/新key，仍需所有占用/保护通过 |

预览可以真实搜索、打开资料和备注页，按现有preview策略补空备注/描述，已有非空保留；not_attempted/not_needed/confirmed/unknown必须来自原执行事实，不能把“预览”写成零UI副作用。任何路径不得创建send-claim/本地发送凭据或点击邀请；发现payload/job/namespace不一致就阻断，不降级send。

**物理保护**针对整台手机：领取后到实际host close、新核验双帧与目标全部forward为0、事务持久释放之前，全部账户槽位和其他自动化/新控屏均不能抢入。**未知备注写入保护的建议范围**仅是新external-preview请求在物理设备+槽位+目标号码上的自动重复预览/保存；清理成功不将unknown保存改写成confirmed，也不允许客户端自动换key宣称原请求未做。它不等于已存在邀请claim，更不自动禁止后续获授权的显式send；其他目标仍按独立物理gate和当前业务规则处理，不把单目标未知拖成全池阻塞。

新preview重复写入保护需要独立持久回执/屏障；不是把preview加入send的ID复用查询，也不批量迁移全部历史preview unknown为永久send禁用。**策略待定：** 物理义务已真实释放后，针对unknown preview的新显式send是否要求先核对备注，不能仅由源码能到create前推断应该阻断或应该允许。当前建议保留已有send合同，不在本阶段修改其新建分支。若以后决定新增跨mode核对保护，须另列兼容范围、人工核对/解除条件及用户/owner决策，不能偷偷套用新preview规则，或删除sameWecomRecipient现有send过滤造成串ID。本版不新增公开“解除未知”或cancel端点，不自动迁移43旧证据，也不宣称已存在任何人工解除实现。

## 5. 取消、错误和持久失败

| 场景 | 业务投影 | 锁/回执处理 |
| --- | --- | --- |
| 已证未领取/投递且无未决提交，后台取消与派发事务互斥成功 | failed，code=preview_cancelled_before_dispatch，保存not_attempted | 原ID/幂等回执保留；普通锁持久释放后可deviceReleased=true，不造host/proof |
| 已领取或无法证明未投递，收到后台取消 | 按原任务请求停止；已知无保存未知则failed，否则unknown | 等真实close与独立核验；取消不是kill成功/手机安全证明，不清物理义务 |
| 备注confirmed但取消发生在到发送前之前 | failed，code=preview_cancelled_after_confirmed_save，保存confirmed | 不重新保存/不自动继续；清理独立；原key不重跑 |
| 备注可能保存、取消/超时/断线 | unknown，保留remarkSaveStatus=unknown | 目标未知写入屏障持续，物理proof成功也不清此屏障 |
| 业务结果持久写入失败/ACK未知 | 对外unknown或503明确未确认，不伪造ready | 本地/云端原ID outbox/屏障保留，不可普通success解锁 |
| 物理proof/释放事务失败 | 原业务status不变，deviceReleased=false | rollback含回执/义务/task/proof/普通锁；checkpoint不得提前保存released |

普通TTL、任务归档、手动/批量取消、服务重启均不删除未决物理义务/未知写入屏障或重发原业务。确认清理的事务必须与设备释放投影一致，迟到旧代次/旧ID/错owner不能释放；失败维持原保护，其他手机仍可走自己的gate。JSON/PG/结构/快照/双写及延迟旧checkpoint必须实际验证，不能因为合同写了“同事务”就认为现有存储已满足。

## 6. 当前源码反证与精确边界（不是产品修复）

最初仅看到index prior未显式mode，曾怀疑旧preview会被send复用、随后send GET404。实际真helper sameWecomRecipient已内置other.mode=send限制，原怀疑未成立；原错误怀疑的源/hash/失败输出保留REJECTED_HYPOTHESIS，不将其当作产品缺陷。

六项当前32c源代码分支/真实helper内存核验（停create之前、无HTTP/Agent）：

1. preview保存unknown，同备注/异备注均不进入send prior；存在physical pending时均409清理待确认。
2. send未知且同备注可200复用自身send ID，并能通过同owner的send GET谓词；复用早于physical gate，但只回原单、不新建或解锁。
3. send未知、不同备注409参数冲突；claim存在仍不重发。
4. 其他管理员不能GET原ID，已有claim会阻止新任务且不泄露他人ID。
5. 原提交保存pending返回503，不给新任务受理许可。
6. **若合成fixture明确不存在physical pending，旧preview-only保存unknown本身不构成send-recipient hold，可到create前哨兵。** 这只说明现有pre-create守卫的模式边界，不证明真实手机已释放/已创建/已发送，不算原跨ID怀疑成立，更不是自动认定旁路bug：preview无发送能力，之后的新显式send与重复邀请不同。预览非空备注保留，旧send按自己的明确请求语义处理，不把两种备注规则混同。跨mode是否新增核对属于待定策略，当前保留现有产品行为。

初轮六项夹具准备错误（缺synthetic agentId、备注超20码点、把已publicPreview结果再投影）日志另存；只修夹具，不改产品。最终用例/源和实际输出另外绑定，不能把夹具红误报生产故障。

## 7. 实现前验证清单（尚未执行）

新外部preview须有真实隔离HTTP：接受202后同ID GET200、跨mode/跨owner404、30天归档压缩前后200/410且原key不重跑；同key并发/不同参数、同body换key未知屏障、旧send claim/未知保存保护兼容；受理各记录持久失败/丢响应/服务重启；领取/未领取取消竞态、结果与物理proof独立/事务失败、晚到proof/旧checkpoint、主/分身互斥、查名/控屏/容量与reader预算。手机UI保存语义另用原执行器夹具，再获准真机验证。

当前只有合同和上述六项源分支核验，**没有新增产品路由、表/集合、迁移、真实HTTP/PG/OS或新机型验收**。共享runner/退出回执仍归查名owner，server/index未改。先固定候选影响/数据模型与回滚、独立审查和加载授权，再评真实逐型发送前测试；不以补合同解除native/43/14752冻结。
