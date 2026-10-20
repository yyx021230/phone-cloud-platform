# 企微发送前预览：默认备注候选

基线 `360bf9997d17553fdc821fcb89ba4fa2d1241c24`，分支 `codex/wecom-default-remarks-20261020`，初始工作区干净。共同流程2026-09-30、SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`已核对。本阶段优先稳定，不再以提速为验收标准。

新入口 `wecom_remark_preview.run_customer_preview(PocoRemarkDriver(existing_poco, foreground, real_lease), request)` 默认补填空白备注名“测试客户”和描述“接口联调测试”。已有非空值、企业、电话及其他编辑框保留，只支持67实际观察到的备注页组合及资源名。旧 `wecom_invite_preview.run_preview` 保留无备注模式；基础模块仅补保存后资料页的已观察csu/描述/设置标签组合，完整号码仍必需。新模块未注册生产Agent/API；宿主须提供真实独占、有界RPC和既有Poco连接，禁止安装型默认构造器。

操作前重新核对页面、唯一控件、当前属性、前台、真实租约及原截止时间；输入后精确回读全部编辑框。保存最多尝试一次，返回同一手机号资料后重新打开核对持久值，再返回邀请页，仍不发送。未知保存、错回读、失锁、前台变化、取消或超时停止，不重放。结果增加 `remarkSaved`（只在确认持久值后为true）、`remarkSaveStatus`（not_attempted/unknown/confirmed/not_needed）、`remarkPrepared` 和脱敏步骤。原加人频率限制暂存，不绕过、不重试发送。

本地实际验证：`python3 -B windows-agent/scripts/test_wecom_remark_preview.py`14项、`test_wecom_real_elements.py`17项、`test_wecom_invite_preview.py`35项、`automation_runners_test.py`20项，共86项通过。覆盖默认/已有值、电话和其他字段保护、持久核对、未知保存不重放、重复控件/有界等待、错目标、取消、实际适配器合成全路径与写入前失锁/页变/预算。旧测试未删改，仅自审。未跑广泛Node/投屏回归：没有共享Agent、控制或媒体代码变化。

67首轮新版实际补描述并单次保存；保存后资料页不再有“设置备注和描述”，原判断停在profile_phone_mismatch，保存标unknown。已补csu描述行及设置标签/完整号码的窄识别，新增反例旧14项有1失败、新全过。随后同一目标不重新搜索/输入/保存，脚本重新打开备注页核对默认描述持久化，再返回并到发送前，20秒结束，真实租约和SYSTEM/SDK/ADB8988、Agent14508不变。原姓名保留，故备注名默认值只在模拟空白场景验证，真机没有覆盖姓名。最终补丁没有再跑一轮从首页空白保存的全程；此边界与首次失败保留，不能称长期稳定性通过。详见 `VERIFICATION.json`。Windows隔离staging测试不等于生产部署；无生产文件替换、共享服务或ADB重启、身份/密钥/驱动变更、冻结媒体变更或推送。其他机型、无人值守生产接入、长期稳定性和真实邀请成功未验收；其他工作区既有改动保留。

回退停止使用新入口，将基础模块恢复到不可变rc.5并使用旧无备注入口，无服务或数据迁移。停止引用不会删除已保存的测试备注；撤销须只针对原测试用户按原值恢复，不重发邀请或批量改数据。
