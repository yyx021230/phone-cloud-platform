# 155清理占用与旧链路：本地修复回执

阶段：2026-11-03～04。候选 `wecom-recovery155-20261104-local.1`，分支 `codex/wecom-recovery155-20261103`，起点 `e9741209892e7d7acdb976ed0c87a5159b1c0d3d`。**未推送、未上线、未重载、未解除生产155围栏。** 提交由同名不可变annotated tag绑定。

## 修了什么

- 原失败task/job/物理义务完整核对；专门处理legacy preview登记前失败，保留原hosts=null、hostClosedAt空、原失败及备注unknown。不伪造reader PID、不删除任何锁、不重放UI。
- 具名管理员、原指纹、旧SYSTEM Agent精确出生代次、明确维护确认和新Agent能力门禁；同一手机排队，不占用其他查名手机。旧管理员token原单owner为空按事实保留，新维护不能用无userId静态token发起。
- 新SYSTEM Agent私有只读worker验证旧producer退休、主机/身份/实际ADB TCP对端、无WeCom/未知Python、155两帧Poco与forward为空，120秒租约/3秒challenge；真实child close后才提交。无UI或ADB/身份/安装/转发清理动作。正常查名/OCR worker允许存在。
- 独立维护proof原子落库后标记released并保存维护审计。PG事务内回读防止旧upsert无写入却返回成功；失败或未知时围栏保持，同份proof可确认原提交，失败代次不自动刷新。
- 后续新任务必须配套采用此前因果协议；本轮没有声称已修复155的唯一根因。32c的跨机wall风险能复现，但原ready未留存，不能据此确定155此次原因。

## 已验证

| 范围 | 最终结果 |
|---|---|
| 定向服务/因果协议/真实HTTP/Agent入口和子进程 | 143通过 |
| 独立真实PG事务、回读、失败/未知与原记录/其他设备不变 | 1通过，临时PG已停止 |
| Agent check | 680通过 |
| Python企微 | 556通过 |
| 投屏相关screen-client/server/Agent | 183通过 |
| CPS外部HTTP客户端 | 14通过 |
| 原失败查名HTTP/设备扫描/子进程组 | 14通过 |
| 保护的查名轮询入口 | 13通过 |
| 根check、隔离平台smoke、diff检查 | 通过 |

组间有交叠，不能相加。实际155归档原记录只在本地校验为eligible，未派发新任务，不是真机proof。132保护文件hash不变；Agent入口移除三条新增企微行后与起点逐字一致。审查由本线程完成，无其他聊天或子代理。

## 失败和实际限制

首轮整套test:all的Node阶段2513项，2498通过、8失败、3取消、4条件跳过，未进入后续Python和烟测步骤。新增轮询参数引用常量使已有VM抽取测试缺依赖，已用与既有企微参数相同的固定协议字面量避免新增自由变量，专用入口测试校验新协议值；原查名保护文件没改。其余失败和级联场景在原断言/原超时下分组复测通过。后两轮整套经历逾100万毫秒中断，已终止自有测试进程；没有单次完整test:all全通过记录，不能据分组通过宣称完整全量通过。

新增测试初轮还暴露了同步throw断言方式、合成HTTP短secret和缺previewStatus等测试准备问题；原日志保留。对照155原归档发现非空owner新校验不兼容旧管理员token，已删除非空要求、保留原job/lock owner精确相同，并补空owner与具名新操作者反例；没有填造旧用户或PID。

收尾时两条原安全SSH master缺失，cloud/Windows BatchMode密钥认证拒绝；没有密码参数、凭据落盘或绕过登录。未能再次核验当前ACTIVE、正在使用的手机及155现场，报告只引用最后已知32c/原pending，不能称当前生产已复核。原生SYSTEM worker、真实Windows性能/3秒预算、真实155解除仍未验。CPS生产映射及正式主号/分身真机API仍待后续，不因本候选而改变状态。

## 后续与回退

详见[维护方案](../../docs/企微155清理恢复候选与维护方案.md)。先恢复安全连接，核对实际生产与原四条记录；准备配套协议闭包/备份，待在途查名安全结束、确认控屏影响后另获维护授权，才允许云端/Agent重载。此轮没有新表迁移或生产配置修改。D-075真实媒体宿主发布前后只读verify仍必需；不重建ADB、不切SYSTEM/Administrator、不动key、Windows、USB或媒体。

回退只退经核对的组件与部署配置，不倒退业务数据库、不删除原义务/recovery审计或已提交proof。未有已知有效proof时155继续保持围栏；有残留则只报告，不能自动force-stop/remove-forward或扩大维护。
