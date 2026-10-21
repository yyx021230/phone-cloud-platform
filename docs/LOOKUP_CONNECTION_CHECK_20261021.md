# 连接恢复与生产只读核对

时间：2026-10-21 17:34—17:38（Asia/Shanghai）。仅调查，无发布或生产写入。

- 用户更新Windows入口：局域网192.168.20.139，远程100.100.177.27，Administrator SSH。本次实测远程入口成功；局域网入口未测试。主机返回PC-20261015BZYS。
- 云端既有主机SSH恢复成功，沿用已知host key，交互认证；真实凭据不保存到文件或命令参数。
- ACTIVE：`lookup-scheduling-20261021-deployed.1`，业务源`9d2276884f26e6c436bc4ccd80bb3c8d18be3771`。
- 运行/下次启动镜像均`sha256:a9e487ecb04afa22def7c926541a06be5593191066652881388d017e54022dab`；16个本次调度发布文件、24个Compose文件哈希与ACTIVE一致，重启镜像标签解析一致。
- 平台容器healthy，healthz/readyz均200；Postgres/Redis容器healthy。未做写入测试。
- Windows共享ADB PID8988，路径`D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe`，NT AUTHORITY\SYSTEM，127.0.0.1:5037监听者仍8988。Agent node PID24968也为SYSTEM。仅进程/CIM/监听查询，没有执行任何ADB客户端命令。
- Windows `src/index.mjs` SHA-256 `4d383bedf195739005abafe52779b7414d3aa2e3217fca45f359746de5e3bd23`；`src/lookup-human-observer.mjs` SHA-256 `f9d327e786802c5781e7eea046f4bf0dfa81d3ec67f63066e99345148a1ab4b2`，均与现行发布回执一致。
- 17:36:05只读PG事务（8秒statement_timeout）：设备池48启用、并发5，channels为空，未完成requests为空。不等于所有手机已就绪，也不等于完整真机验收通过；未逐台重新探查账号。
- page-helper与post-human两个候选未加载；管理员后台仍仅本地设计v4，真实状态/截图接入未完成。

诊断限制：最初进程枚举期间有短命ADB客户端退出，GetOwner报对象不存在；改为逐进程容错只读枚举后成功核对长期server与Agent身份，不重启或重建任何进程。最初本地stdout解码假设UTF-8失败，后按Windows编码读取诊断；不代表SSH认证失败。

未做：新号码、启动探测、切号、人工接续、通知、授予权限、清隔离、部署、推送、服务重载、ADB/SYSTEM/密钥/驱动/媒体调整。D-075本轮未再次现场验证，因为没有媒体操作或发布；不借既有回执冒充本轮媒体验收。

版本管理：独立调查分支`codex/lookup-connection-check-20261021`，基于设计提交`7475283`；仅本记录与主文档追加。已有候选、设计标签及根仓改动保留。本轮没有运行候选或部署标签。
