# 发布准备回执（未切换）

- 运行代码候选提交：2f18514；不可变标签 lookup-final-20261023-rc.1。
- 镜像：phone-cloud-platform:lookup-final-20261023-rc.1 / sha256:c10e071b3f4811c626b28075bba364e8dc96e05dc9c8402d0f760673f7e63f8c。
- 生产仍lookup-recovery-20261023-deployed.1，运行及下次启动镜像7ecf126b，源码f97306ed。
- 云端暂存：/opt/phone-cloud-staging/lookup-final-20261023-rc.1；Windows暂存：D:\PhoneCloud\staging\lookup-final-20261023-rc.1。两边rollback已保存；云端pg_dump经pg_restore --list检查，旧镜像归档已保存。
- 宿主机源码不是生产基线。rollback/source仅保留原宿主文件；真正旧版运行文件在rollback/runtime，并逐项对生产before哈希核验。不能用旧宿主源码回退应用。
- 已隔离启动新镜像和临时PostgreSQL，network=none，无生产DB/设备连接；health/ready、后台资源/鉴权/接口及22文件SHA通过，临时容器已清除。
- 真实媒体宿主D-075 live通过。测试后生产health/ready均200；Windows Agent PID21840与ADB PID8988、SYSTEM身份未变。
- 第一轮构建使用裸sha256作为FROM被Docker当作仓库名，构建失败且未创建/切换生产容器。更正为已核对哈希的旧版标签，并加入.dockerignore避免把备份放入构建上下文，随后成功。prepare脚本仅准备；不执行任何激活。

正式发布仍需用户明确授权及维护窗口。云端与共享Agent重载会影响当时控屏，届时核对业务执行/占用再确认。不得重启ADB、切SYSTEM身份或动媒体。Windows阶段已原生532项测试及OCR两轮，实际手机点击、探测AI、账户列表双帧及业务跨机灰度仍待发布后执行。

回退步骤和动态配置兼容门槛见上级README。不要恢复数据库覆盖发布后的结果，不要移动已有Git标签。凭据不进入此回执。
