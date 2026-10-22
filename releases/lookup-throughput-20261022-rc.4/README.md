# lookup-throughput-20261022-rc.4

本地验证候选，未上线。继承rc.3全部组合改动；不移动旧标签。任务分支`codex/lookup-unavailable-20261022`，起点`38c8fd568f3cc14a5513f42a02f76b969405fc9f`，开始工作区干净。共同流程2026-09-30/SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`，AGENTS/主文档沿用连续阅读并核对最新章节。

## 外部可见变化

- prepare新增`acceptingRequests`，不暴露设备数量。ready继续表示本轮曾通过首次两台门槛；当前是否接收新号码看acceptingRequests。零台有效可查返回`code:lookup_no_available_device`和`retryAfterSeconds:30`。
- 已开放轮次零台有效可查时，新增tasks请求返回HTTP503、`Retry-After:30`、`{ok:false,code:"lookup_no_available_device",accepted:false,retryAfterSeconds:30}`，事务不创建查询、不写幂等别名、不续空闲时间。初次门槛未通过仍为lookup_not_ready；prepare已提供容量反馈。
- 健康手机正在执行不等于不可用，仍允许排队。一台恢复有效资格即可接单；不把后续门槛改回两台。
- 幂等键、同号码在途和有效近期结果先复用，不能被容量门禁挡住。旧queued原单GET仍200/queued，并附暂无可用手机的反馈；processing和completed/failed结果不伪装为空姓名，期限/取消/停止/转交机制保留。
- 普通Python requests和Node fetch示例先检查acceptingRequests；503后暂停传号，用原prepare键检查恢复，再用原业务键提交。已保存lookupId只GET；多个调用线程/进程需由对接方共享客户级暂停状态。30秒是检查间隔，不承诺恢复时间。未调用prepare的旧接口兼容行为不扩改。

这是对主文档7.15.20“已开放后零就绪也无限期内继续受理到队列上限”的明确收紧，保留首次两台、后续一台与旧单接续，防止对接方明知无容量仍持续追加。

## 范围与验证

4个云端运行文件、9个公开文档/示例/下载文件、1个单测文件及5个验证脚本，共19个差异文件；474个范围外文件哈希保持，Windows与媒体不改。OpenAPI两份、网页说明、Python/Node与ZIP/校验清单同步。无需DDL/依赖升级/设备池配置变更。

实际1053项Node全量、51项准备专项（包含在全量）、4项真实HTTP回归（包含在全量）、4项Node示例与1项Python示例通过，根语法/文档/ZIP检查通过。JSON及独立本机PG各50条普通API Key HTTP全部完成，最多5模拟设备；全不可用时30条并发新增均拒绝且记录数不增长，旧50条保留；16姓名/34明确空结果，来自真实Python双帧解析的脱敏布局。JSON实际121001ms换Key、PG65001ms越过首次排队期限，原ID/总期限/停止ACK/迟到结果/重启/下轮均通过。不是生产真机验收；Windows原生OCR继承rc.3证据，本轮未重跑。失败及测试夹具纠正记录见verification/RESULTS.json。隔离PG已停止，无残留测试服务。

自审R2：容量检查放在防重之后、事务建单之前；busy计入有效能力、不误阻塞；门禁不删除原单、不制造空姓名、不重置总期限；权限/存储/结束保护保持。当前不可用包括人工、离线、限制/登录、证据过期等，不能把提示当作“所有设备都坏了”或“30秒后必定能查”。已完成结果和其他客户权限不扩展。

## 组装、发布与回退

`python3 releases/lookup-throughput-20261022-rc.4/verification/prepare-local.py --out /tmp/unique-rc4-output`

父层、before/after、范围外和生产差异均校验；首次组装因继承的测试文件hash陈旧被门禁拒绝，修正清单后全新目录组装通过。生产基线仍以最近只读核实的`scheduling-20261021-deployed.1`/9d227688/a9e487ec为准，本轮未再连接生产。

**此前暂存b122d052镜像只含rc.3，不含本补丁，不可称为最新候选镜像。**正式发布必须重建rc.4组合镜像、更新哈希/备份/部署回执并沿用prepared.2的10人权限清单；组合仍有共享Agent变更，需新维护授权。未推送、发布、赋权、触发真实号码/通知或操作ADB/SYSTEM。主仓及旧候选保留。

若尚未上线，可继续选取不可变rc.3但需明确不含本反馈；若rc.4上线后回退，应配套回退本轮4个云端文件与文档/下载资源，按当次生产备份和维护授权执行，不回滚数据库/原查询/用户结果。旧客户端忽略新增字段仍会收到503，需接入方按错误码暂停发送。
