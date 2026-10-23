# 探测AI补丁发布准备

2026-10-23 14:43 CST：用户已授权发布本候选；尚未切换，等待本次控屏中断窗口确认。运行候选ae9a4d21dad30fde054884502275fc2e1b5c6308 / lookup-probe-ai-20261023-rc.1。新镜像020c325d7c577859236d6eb9d3c395e4ee5fda55f8838e7ecbe717aa084b60c2，以已核对线上7ecf126b为基底，只覆盖server/managed-lookup.mjs。

生产暂存/回退目录：/opt/phone-cloud-staging/lookup-probe-ai-20261023-rc.1。旧镜像导出、ACTIVE、Compose引用、旧源码和958401778字节数据库dump已备份；pg_restore --list通过，未完整恢复数据库演练。新镜像使用无网络的隔离PG检查ready/API/鉴权与文件hash，通过后临时容器删除。D-075宿主机只读live通过，未重启媒体。

当前无客户业务排队或运行，有161/54准备探测、1/113/157/61/52控屏。切换脚本仅允许当前明确维护授权，业务/执行任务空闲且查名通道idle后停止云端。原准备轮/已完成结果保留，不调用stop接口，不写池配置，不重载Agent，不碰ADB/SYSTEM/Windows/USB/媒体。实时占用会变，切换前重读。

回退：若新容器未就绪或hash不符，保持原数据卷与全部Compose参数，使用rollback内ACTIVE所列Compose恢复旧镜像7ecf126b；只重载phone-cloud，不还原整库、不删除新数据。原镜像导出提供离线恢复点。回退后核对healthz/readyz、文件、原任务/结果、Agent连接及D-075。切换与回退均受用户批准窗口约束。

脚本已语法检查；激活/最终回执脚本尚未执行。发布成功后另存实际回执，不把本准备文档当成生效证明。只有本地模拟和原截图模型读取通过，生产探测AI授予就绪仍待验证。
