# lookup-cleanup-guard-20261030-rc.1

状态：本地候选，未部署、未真机验收。范围7个运行文件+7个测试文件，文档与脱敏证据随包。具体分支、源码commit、生产逐文件基线及候选hash见MANIFEST.json；annotated tag固定封装提交，不移动。

- 最终root check通过，test:screen 1769/1769通过，0失败/跳过；7个运行文件额外node --check通过，测试期间源码稳定。
- 保留guard/cloud/observe-first修复前反例及首次因依赖缺失的全套失败日志。其后所有最终断言通过不等于生产/原生真机通过。
- 实际生产仍3a266d71及platform-integration-20261029-deployed.1；Agent22668/SYSTEM、reader12，ADB17764/SYSTEM、原路径。云目标15/rev141另列，非自动同步。没有DB迁移、生产修改、重启或新查询。
- 48台10:14脱敏矩阵显示基础ready37、lookup health ready12，三台新stopping耗尽。该历史快照不是当前实时状态。
- 云端fence先于/配套Agent；新Agent+旧cloud不安全。Agent回退需保留cloud fence。旧retry2不会自动恢复，需要本轮明确代次范围的真实停止proof；不清锁、不重放查询。
- 共享Agent全局重新加载不是单设备发布。实际R3加载前需保护/排空已输入任务与outbox，核对新鲜基线、真实维护gate、旧不可变云镜像与Agent文件备份，然后按批准范围单/双设备验收。现有历史回退材料只供定位，不代替发布时新备份/校验。
- 不含企微3082c0e compactor候选，未来组合不得整文件覆盖index。ADB身份、keys、启动、媒体、投屏冻结保持，33文件字节一致见FROZEN_SCOPE_VERIFICATION。
- 未解决/未验：底层pidof/传输超时根因、runtime丢失/TTL重排、账户登录/页面退避、AI契约/未找到准确性、全48吞吐；未跑PG全平台烟测/Python全量/新版本真机。Windows细分日志不是UI/API分阶段proof。

详见../../docs/LOOKUP_CLEANUP_GUARD_20261030.md及主文档末尾本轮变更/决策。FINAL/REVIEW日志为本地合成测试，没有生产凭据和完整账号。SHA256SUMS.json覆盖除其本身外候选证据，不用自引用hash。
