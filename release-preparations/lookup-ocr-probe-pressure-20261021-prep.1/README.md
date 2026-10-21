# 查名充值空结果兼容上线准备（2026-10-21）

状态：用户已授权发布候选；镜像、数据库及Windows备份、隔离验证完成，尚未替换运行文件/切换容器。当前有控屏，按用户维护前告知要求等待本次中断窗口。候选源码0d94fff31ed68e441ae364088a13f6c0c18f774f，标签lookup-ocr-probe-pressure-20261020-rc.1。

仅更新云端三个查名模块、Windows两查名执行器，并将对应脚本纳入下次启动镜像。返回空字符串仍基于完整充值结果两帧确认；真正异常才安全跨机。API字段和认证不变。保留当前池配置及其他业务版本，不重载共享Agent，不动ADB/SYSTEM/keys/任务入口、Windows、USB或媒体。

## 实际准备

- 线上仍lookup-offline-round-stop-20261020-deployed.1 / 59ce44e；运行及下次启动镜像0207e744，44继承运行hash与Compose核对通过。
- 新镜像f8e57172de142b336a0aabcb93a46039925c3a0d1c6359205490ae844ba64e78，45运行hash通过；network=none隔离启动ready及4公共入口通过，没有连接生产DB或真实Agent。
- 数据库备份554233897字节，完整pg_restore只解码验证；旧镜像归档、ACTIVE及Compose、五目标文件备份齐备。准备脚本持部署锁，未重启任何业务。
- Windows实际Agent14508、共享ADB5037监听8988，均SYSTEM；与旧回执PID不同是发布前现场事实，本轮没有重启它们。两脚本hash仍匹配候选before；config/preload/Agent入口仅记录hash。
- Windows暂存脚本8份脱敏版式样本通过，隔离OCR运行时合成数字推理2.736秒通过；不是新真机查名验收。当前未发现缓存Poco worker；切换前须重新核验。
- D-075在真实宿主机live核验通过；未修改媒体。932Node/265查名Python/163执行器为本候选上轮已通过，本轮代码未变，不重复冒充新全量结果。

## 切换门槛与回退

切换前重新核对ACTIVE/五目标hash、两端任务和控屏。须得到当次云端约2分钟窗口的控屏中断授权，并避开新业务；不能用旧窗口授权。Windows只在目标查名无执行与无相关缓存worker时原位备份/替换两脚本；若需刷新worker，只允许精确空闲查名worker，禁止共享Agent/ADB重启。

云端用准备好的Compose增量只切phone-cloud镜像；环境/数据库/池不变。确认health/ready、PG/Redis、Agent心跳、文件hash、公开文档与实际宿主机D-075，然后保存部署回执、ACTIVE和Git标签。上线后优先只读观察对接方自然任务，不能凭发布授权增加真实手机号查询。

任何目标hash/占用漂移先停切换；失败仅回滚本轮脚本和旧云端镜像，保持数据库业务记录与D-075，不自动恢复数据库旧快照。备份/新镜像与哈希见CLOUD-PREPARED.json、WINDOWS-PREPARED.json；前轮已验证回退规则继续适用。

首次Windows暂存发现staging父目录不存在，创建专用目录后成功；未动运行脚本。生产访问沿用安全SSH，凭据未写入材料。原根仓及其他任务改动保留，未推送。
