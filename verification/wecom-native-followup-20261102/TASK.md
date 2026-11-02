# 发送前真机验收：本轮预检与阻塞

- 人类本轮明确授权：选空闲手机完成主号/分身真实流程，仍停在发送邀请前，避开线上查名和其他在用手机；不是发布、Agent重载、ADB重建/身份/密钥/启动方式变更授权。目标继续沿用本线程授权的尾号6441，未提交号码。
- 从干净 `fca7650c78ad613a09cb08f0f97fc16eaf37307a` 建立分支 `codex/wecom-native-followup-20261102`；本轮仅新脱敏只读材料/记录，不修改业务代码。主文档完整连续读取并核本轮相关增量；共同流程2026-09-30/SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。rc.1/rc.2与全部既有改动保留。
- 只读云端旧socket已过期、BatchMode密钥认证失败；沿用人类已给凭据通过SSH隐藏stdin开本线程独立只读连接，密码不进入文件/命令argv/报告。Windows沿用既有共享master，只做CIM/5037监听/文件哈希读取，不关闭他人通道。没有新增SYSTEM启动入口。
- 初次PowerShell `-Command -`没有可解析正文；其次全量GetOwner因短命进程退出返回`HRESULT 0x80041002`，一次本地UTF8解码失败。改为逐项保留失败后识别出5037唯一listener，再只核稳定Agent/listener。本轮有效JSON已保存；CIM stderr有未分类字节，不宣称整机无错误。其他adb.exe客户端及短命进程不算多个server，也不由GetOwner失败断言身份错误。
- 17:50:57北京时间，目录141台/online124。23、25、59、93、145主号平台空闲且不在启用查名池；43仍原清理待确认；155是唯一配置clone的手机，155/157仍在启用查名池，本轮排除。企微API余量2不是共享reader物理余量的证明，目录available也不是原生执行许可。
- 17:52:13 CIM：Agent19756和5037唯一listener27912均SYSTEM、固定二进制路径；27912出生及父PID与前一观察不变，不因此接受新的验收基线或证明其来源。7个Windows产品文件hash与生产32c一致。17:53:09云端3服务模块+public文档hash匹配32c；ACTIVE仍`a5390dcc93b5f1393e7b95732ca4df679dc5065200f80cf509d96e0f759e2a2f`，businessSource32c/镜像4468。没有加载本地测试或运行时补丁。
- 当前43原job `7b993763-6364-40fb-9599-2af3bb8d9da3`仍failed/`wecom_cleanup_host_unconfirmed`，remarkSaveStatus unknown、未发送；原义务未解除。没有改结果、补旧host、清锁或换机重试。
- 本轮实际1次正常认证POST（预期session/audit）、9次业务GET、ACTIVE/运行文件/CIM只读核验；手机POST/任务/真实SDK/手机动作/ADB客户端/发送/配置/服务重载均0。未做全量回归，因为产品没有变；旧455唯一Python及49 Node的边界不扩大为本轮真机通过。

## 未提交真机任务的具体原因

生产`server/wecom-physical-cleanup.mjs`的host出生与cloud lock.createdAt比较，hostClosed/proof也直接跨Windows/cloud wall，proof含3秒限制；是已核代码缺口，**不能据此认定43历史唯一根因**，原ready证据丢失。再次选空闲机试跑可能在ready登记即失败并留下新清理义务。专属raw5037避免CLI启动，但当前adb_identity只回PID、连接前检查，没有已连socket peer/出生代次绑定；不能将其泛称完整安全执行路径，也不能核销原27912来源/隐式拉起风险。

root本轮独立阅读实际32c源码后同意保持提交前停止：没有已审核、可直接加载的独立完整安全执行路径。43/147/52原隔离不动，155分身不从查名池挪走，不调时钟、不放宽3秒、不绕过host门禁、不重绑PID。目录选机已完成，**主号/分身完整真机验收仍未运行**。

下一阶段需本地最小运行时适配候选与审查：复用已审clock model.2，用真实本地HTTP/child覆盖新采样、host注册/close/两帧proof、偏差/排队/旧样本/暂停未知/持久失败，先专属helper/测试，不改生产v1路由、Agent index或共享runner；真实Windows/暂停无证据时明确unsupported。候选与最小接线固定、验证审查且获得具体加载授权后，才重新取新鲜占用/身份做单机、双机、逐型/主分身验收。本记录不把“本地helper允许准备”冒充生产实现或新授权。

版本仅只读观测提交/不可变observed标签；无部署/推送/数据迁移或生产回滚。根测试器独立复核已固定`5ce1748157754e2d94dcd3152f493d9c6992b27e`，183专项及旧新变异比较通过，仍非真机结果。
