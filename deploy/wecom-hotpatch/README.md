# 现有进程内的企微恢复模块热修复

仅用于具名人工维护；本轮用户明确拒绝再重启并要求直接恢复四台。正常发布仍用已提交镜像，不把此工具作为无条件自动发布入口。

`runtime-recovery.mjs`只提供默认dry-run的库，不启动调试监听、不发信号、不暂停、不设置断点、不创建业务/恢复任务、不改数据库。外部维护者必须核对容器、PID/启动时间、当前源码hash、目标源码提交、备份和本轮授权，调试入口仅容器内127.0.0.1且不得映射到宿主公网；已有非本轮调试入口不得接管或关闭。不得输出/持久化原始Inspector响应（模块作用域可能有凭据），只保存脱敏结果和hash。

只用Runtime.evaluate/getProperties/callFunctionOn/releaseObjectGroup，找到原恢复服务及其现有state/persist/conflict/clock/now/id；核对旧方法hash、原对象方法形状和可写描述符、无在途企微任务/job及空mutation队列。目标两个模块的已审核源必须由外部manifest校验。已知静态imports按原作用域函数注入，保持模块strict语义，不用带回调缺失的Inspector动态import，不启动第二个HTTP/调度器。

新服务保留同一state、同一单调时钟及原持久化/冲突回调，确认pending仍返回同一锁对象后，一次同步Object.assign替换恢复服务方法；查名/Agent/ADB/媒体/控屏对象和原任务记录不修改。保留Symbol.for('phonecloud.wecom.recovery.hotpatch')中的原方法作为有限回退点，拒绝重复应用；若需回退，先确认无在途企微和mutation，恢复原方法，不恢复旧数据库发送记录。最后关闭本轮Inspector监听并核对原PID、启动时间、接口和实际四台proof。

已有运行层两模块仍需按审核hash同步，后续启动镜像/Compose指向已验证候选；不能只修内存却在下次启动回退。镜像/Compose准备不等于重启授权，本轮不得额外重建容器。保存实际运行镜像+两文件热补、下次启动镜像和组件源码分别对应关系。

本地入口：`node scripts/qa/wecom_hotpatch_rehearsal.mjs`。只启动合成HTTP子进程及回环Inspector，测试旧接口拒绝→原进程热换后显式重试通过、lookup哨兵/旧失败不变、源漂移/活动企微拒绝、Inspector关闭后同PID服务继续。默认依赖本仓de6cf40旧版本Git对象，无则失败，不猜基线。生产同版本Node22另在无网络/只读/无capability/非特权临时容器测试，不加载生产状态、不启动生产应用。静态/合成演练不能代替真实SYSTEM proof。
