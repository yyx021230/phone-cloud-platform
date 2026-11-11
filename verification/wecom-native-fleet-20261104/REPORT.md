# 企微多机实际测试结果（2026-11-04）

**16台实际尝试，0邀请。** 15台同来源独立主号脚本首轮13台到发送前、2台失败（86.7%）；另有59号1条正式API失败。25再用三个局部候选各复测一次，失败均保留。合计18次独立脚本、1次正式API；78沿用用户要求跳过。不是CPS、正式API或分身全量验收通过。

成功主号：**69、71、82、91、106、123、125、127、143、144、145、173、185**。这13台原生脚本都完整到达发送前，原进程退出、独立清理核验两次、原listing恢复、当时本轮活动记录为0。

逐台型号、码和首轮结果见[CASE_TABLE.md](CASE_TABLE.md)；每次来源与复测分列[results.json](results.json)。首轮统一3eb89bf，不能把不同候选结果混为同版成功率。

## 未通过与实际原因

- **25**：首轮普通唤醒后仍休眠。后续分别遇到启动Logo和无密码锁屏先后问题。最后ad2856b实机记录单次POWER回执、Awake及nonsecure_clear，进入WwMainActivity；截图已是首页，Poco却只有3个系统导航节点，因此停止，没有猜坐标点击。唤醒顺序已有本轮实机证据，页面读取兼容仍未解决，不能称25通过。[首页实屏](25-home-blank-tree.jpg)没有客户/账号内容。
- **98**：首因在remark_edit，`wecom_rpc_delivery_unknown_no_replay` / ReadTimeout；随后QA证明通讯不明导致本地清理未确认，最终码`preview_cleanup_unconfirmed`。没有重放未知点击；独立清理按原进程出生及资源范围两次核验后恢复空闲。同型号另8台通过，不能归为机型不支持。
- **59正式API**：HTTP201受理，正式GET200查到failed/`invalid_preview_config`，配置阶段0ms、未进入企微。Node传causalLease而Python白名单漏列，本地87d2501修正并新增实际Node→Python配置管道测试。独立清理task又报`wecom_cleanup_verify_timeout`，新义务bca54f78-f4ac-4944-870f-2a5512e4071a仍pending，不清锁、不开新attempt。原失败及unknown保留；TCP读取优化尚未取得SYSTEM原生proof正向验收。
- **78**：用户此前明确暂时跳过，未重试登录。本轮都是主号；分身未测。155原占用本轮没动，也没有再把它作为其他手机脚本测试的前置条件。

## “未配置API”不等于手机不能工作

正式API名单仍只有43、157、93、59、145、25、23、155八台。其他名单手机即使online=true、busy=false，也会返回wecomAllowed=false、`wecom_not_configured`；这表示未开放正式接口，不能说硬件离线或脚本不可用。

本轮没有扩大生产名单或给不明分身猜Android user。空闲且不在查名池的其他名单设备，采用已有的真实screen排他预约、持久单机hold、实际peer证明、原生预览及原资源双清理流程；QA派生main配置只在自有staging。独立脚本成功不替代正式任务API/CPS验收。

## 收尾与线上基线

全部18次独立脚本均有原controller/native退出、2次独立清理、listing恢复和当时本轮活动记录0的证据，没有遗留未上架测试手机。59新围栏及23/43/155旧围栏保留。93初查有正在使用的控屏，157在启用查名池，避开；93另有普通过期旧锁未动，不把旧锁说成当前使用。

最终ready200、Postgres/Redis正常，141总/125在线；查名enabled=true/rev187，其他配置SHA deeaeb269cba7ca104e697ab3a6ef63a291cfa788d4aaf5be686564b05fe9d3c保持，现场3执行/1排队。没有暂停/取消查名、关闭他人控屏或修改生产名单。

SYSTEM Agent15224与固定SYSTEM ADB31384的出生、路径、身份及三个运行入口hash不变，自有staged进程0。ACTIVE9afc29ae、镜像aba0ddc3及02:36:02Z启动时间不变，本轮未发布或重载。真实媒体宿主D-075 live通过：PID2503525、原自定义binary、8Mbps/2包保持。辅助systemd单元名探针选错对象返回0，未将它当故障或执行修复；权威live工具确认正常。

## 本地版本与边界

分支codex/wecom-fleet-preview-20261104，起点3eb89bf且开始干净，已有提交保留，未推送。87d2501/tag wecom-envelope-20261104-local.1修causal字段及只读TCP后端；3f209c8、bf16cd9、ad2856b分别形成25局部兼容不可变标签，均未安装到生产。最后ad2856b标签为wecom-wake-order25-20261104-local.1。

Python最终573、Agent跨语言/管道/清理30、QA协调器13及Windows3.9隔离mock10通过；Windows mock不是SYSTEM proof。首个Windows测试包漏profile未运行测试，补到自有staging后通过。新测试上下文遗漏、诊断条目下标、secure报错回归均记录并按原安全断言修正，没有删除安全门槛或延长预算。

原始有限证据保存在受限目录，仓库仅保存脱敏投影、截图及原件hash。没有号码、Token、Cookie、密码或私钥导出。审查为本线程自审，没有联动其他聊天或子代理。

后续剩余：正式API配置补丁发布后的单机验收及59安全收尾、25读树兼容、98原始传输定位、分身/CPS实际映射与完整接口验收。本轮结果不代表真实邀请送达、CPS备注手机号独立核验、回调/幂等或长期稳定率。
