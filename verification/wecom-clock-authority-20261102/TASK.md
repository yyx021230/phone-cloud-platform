# 时钟授权模型阶段任务卡

- 基线：5d75159182f60f1654bd5976867bf74af45e24e2/tag wecom-clock-contract-20261102-draft.2，初始干净；新独立分支codex/wecom-clock-authority-model-20261102。
- root review确认前阶段6文件hash/实际8项输出，但未独立重跑，也未授予产品实现或native权限。本阶段仅verification离线clock-authority模型与负例/来源核实；不把官方API语义当实际部署证据。
- 唯一拟动：verification/wecom-clock-authority-20261102和主文档末尾变更/决策；不改server/Agent/Python运行叶、依赖、配置或任何生产文件；保留所有既有候选和标签。
- 完整主文档已连续阅读（含root3b21e0a事故补充），共同流程2026-09-30/SHA 0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b；写前主文档SHA aa80f6b67b4cda204b618666d70ca6ab2cc02c838416b80c02450fd14f66c054。
- 研究资料仅官方Linux内核与Microsoft文档；模型不调用拟定OS接口，BigInt样本/误差/ppm/夹取宽度均合成；真正部署没有上界/VM刻画时默认不能签发。
- 本阶段27项离线测试已通过，覆盖root要求的边界/BigInt/RTT/身份/暂停全任务失效/旧任务不rearm及不可区分VM轨迹；结果另绑固定源码/输出hash。前阶段9反例/8延迟实验没有复跑或挪作新增用例。
- 风险/未验：27项为条件性离线模型，VM全冻结存在不可观测性；生产误差/漂移/暂停保证、OS适配器/权限/journal/真实PG和产品v2仍未实现/验证。原43仍隔离，不补造旧host、不新发preview；不接纳27912新基线。
- 真实副作用：无生产连接、无ADB CLI/SDK、无OS时钟采样/调整、无Agent/SYSTEM入口/keys/ACL动作、无部署/推送/发邀请；当前工作只本地模型、文档和公开资料读取。

## model.2 陈旧采样修订

root review在固定af00/model.1仅运行无IO重现，`observe一次/issue后连续permits`实际true/true；未重跑27项，不倒填为真实3秒超时。7项新增反例在未改af00的model.mjs上实际全部失败，STALE_SAMPLE_RED回执保留原source/test/output hash，旧标签不移动。

本轮在独占verification最小修正：proof/business margin/issue/permits决策入口内部先observe本次sample，缺样本/重复sequence拒绝；纯数学helper明确改名snapshot*，不再被命名成动作许可。暂停/监控断档第一次出现在decision时直接使全部旧授权维护，不依赖后台observe先发现。新序号的相同数值不能证明真正OS现取样，VM全冻结不可区分限制和未刻画VM拒绝不变。

实际36项本地通过（适配原27+7先红后绿+2新增决策边界），JS语法/diff及产品路径相对32c diff核验另记；仅模型和本卡/README/主文档/回执改动，无产品实现/生产/native/权限/系统动作。当前36回执绑定3源文件与输出，model.1原27回执原样保留并明确归属af00。新模型修订提交与model.2标签独立保存，不覆盖既有工作或移动model.1。
