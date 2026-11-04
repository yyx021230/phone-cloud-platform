# 正式企微任务配置兼容与只读身份扫描本地修复

当前生产仍wecom-recovery155-20261104-deployed.1 / aba0ddc3，SYSTEM Agent15224、固定SYSTEM ADB31384保持。用户要求不要因155等待而停止其他手机测试，授权空闲名单真机预览，仍只到发送前、尾6441、不上线、不影响查名/其他控屏。

59/main正式POST预览仅1条：job51764154-492c-4670-a7e3-c93873efa1a6、taska96959f8-91d1-43cb-ae37-84650ae6bd04，mode=preview/previewOnly=true/sendClaimed=false。新因果host登记和真实close成功，但配置阶段0ms报invalid_preview_config，未进入UI；随后独立verify1984121a-055a-4108-9abc-5b2333929ff1报wecom_cleanup_verify_timeout。原失败和unknown字段保留，新增物理义务bca54f78-f4ac-4944-870f-2a5512e4071a仍pending。没有重复投递、补造proof或清锁；不能把该错误说成59硬件不可用，也不能把145脚本通过当正式API验收完成。

根因：Node正常发送causalLease，Python validate_config后续代码要求它，却在字段白名单漏列，全部因果业务入口都会在任何UI前拒绝。修正该字段白名单，仍要求原私有bootstrap及binding；无physicalCleanup的孤立ticket拒绝，未知字段/错误purpose仍拒绝。新增实际Node runWecomPreviewTask→真实Python validate_config跨进程测试，原本各自的mock没覆盖此边界。

清理超时事实：本次固定3秒校验失败，尚未精确分解所有耗时，不断言唯一根因。实际Windows只读采样，psutil TCP表三次47/47/78ms，已部署IPHelper后端16/15/0ms，两者六次都只见原SYSTEM ADB31384。SystemRuntimeGuard改为默认复用现有WindowsTcpRuntime，只换读取事实后端，每次仍实时读取IPv4/IPv6和进程owner/path/birth/parent/Agent入口，缺失或改变仍拒绝；不缓存事实、不延长3秒/120秒、不启动/重建/切换ADB。此为减少重复扫描开销的本地候选，尚不能宣称原生proof已通过。

验证：完整Python企微561项通过；Agent真实管道/配置/清理相关30项通过；独立QA协调器13项通过。未改Agent主入口、共享调度、投屏/控制、媒体或查名文件。生产两个Python文件均未覆盖，无服务/Agent重载。新字段和TCP默认后端未在SYSTEM任务上正向验收；59和155保护占用仍保留。后续仅这两个Python文件可在没有企微worker时准备热补，不要求为它们重载共享Agent；仍需明确发布授权，不能把测试授权当上线授权。

其他手机继续独立预览，不受155恢复依赖。当前已知145与69/71到发送前且双清理/上架恢复；25在亮屏确认失败，安全清理后恢复。逐机完整结果另记本轮fleet回执，不把生产API和独立脚本结果混成成功率。
