# 首次只读调查与补采记录

基线为`20882a65c5787948dc0eb9a30837c5f3a0d32d43`，分支`codex/wecom-windows-survey-observed-20261102`，开始干净。root具体脚本审查后按人类已有排障授权执行一次PowerShell/一次Python；不是手机/native/发布授权。两远端脚本均从固定Git对象读取并再次校验原sha，现有Administrator SSH，未上传文件或改身份/入口/配置。

18:27:24北京时间的PowerShell查询326ms/SSH exit0/stderr0，得到：Windows10.0.19045、64位、ASUS/System Product Name、16逻辑CPU、HypervisorPresent=false、当前采集用户非SYSTEM。字段是主机提示，不证明物理机或时钟权威；不是生产Agent/ADB身份变更。原JSON及传输状态分别保留在WINDOWS_METADATA_OBSERVED/EXECUTION_RECEIPT。

同次固定Python命令72ms/SSH exit0/stderr0，stdout371字节，原本地collector把decode/shape/permission/status失败合并为unconfirmed_response，且只在成功后保存正文，导致原371字节和具体失败分支丢失。**不能确认JSON可解析、脚本/API执行到哪步或API不支持。** 最初“status非成功”的推测已向root更正，不重构或伪造旧正文。SSH报告命令返回，不是独立OS生命周期证明；若有本地超时，远端自有采样是否结束仍应unknown。未自动重试、未重新查询metadata。

原collect_reviewed.py和EXECUTION_RECEIPT保持不改，用于描述首次实际执行。新collect_clock_supplement.py仅提议对原208源/原hash/原命令做一次Python补采，单独exclusive marker与原receipt hash绑定，不重跑PS。传输byte count/SHA先写盘，再解析；非JSON/UTF8/shape/status分开，未审正文不落盘；严格白名单+字段类型验证后，先保存失败body再停。

root纯本地审查发现第一版补采validator只有key白名单，能保留known-key错类型。修前源与8项原输出保留COLLECTOR_PRE_SCHEMA；新12个方法中的两个方法产生26个错类型/嵌套失败条目，红例源/输出保留COLLECTOR_SCHEMA_RED，不能写成26个独立测试方法。修后12项通过，含真实补采main的假transport/假git执行验证失败正文先保存、原receipt不变、再调用不重发。所有回归无SSH/Windows；合成失败码127不是原371字节的实际错误。

补采当前等待对具体wrapper/hash的审查，不将提交文件或CLI开关视为执行许可。即便之后取得读数，仍是observe-only，不证明硬误差/漂移/暂停、SYSTEM原生reader/peer、journal恢复、原43清理或27912来源。原v1产品/工厂、43/147/52隔离、155查名排除保持；没有SDK/ADB客户端/手机任务/发邀请/服务变动。

完整staged diff --check命中一行原始COLLECTOR_SCHEMA_RED_OUTPUT尾空白；保留原始日志/hash，仅排除该文件后其余材料检查通过。未把原始红例格式化成新证据。
