# 查名完整调度候选发布准备（2026-10-21）

状态：**准备完成，未切换、未重启、未推送；不是部署回执或生产验收通过。** 用户本轮“准备更新”授权准备工作，未扩大为正式切换授权。

## 版本与范围

分支 `codex/lookup-round-admission-20261021`；发布源码提交 `9d2276884f26e6c436bc4ccd80bb3c8d18be3771`，不可变 annotated tag `lookup-scheduling-20261021-rc.3`。本记录是候选后的准备文档，不移动候选标签。

基线以生产ACTIVE、容器、运行文件为准：`lookup-ocr-snapshot-20261021-deployed.1`，源码 `1ec44cf2bbf15583821f941efe2b711b0ecb455d`；运行及下次启动镜像均为 `sha256:0db4c7eddb1a6ddb4c629882c220e5ee2287640c6520fa26bebf1c890bdf2225`。23个Compose哈希匹配。完整候选继承失败跨机、调度rc.1、状态准确性rc.2和首次准入rc.3，最小覆盖16个云端文件、2个Windows文件；逐文件前后哈希见证据目录。

本次包含：统一最多5台工作预约及安全释放；人工观察不再被满槽执行挡住；新鲜证据驱动卡片和优先接续，息屏/未知不误报拼图；原机优先重探、健康设备业务轮转；失败原查询跨机；本轮首次两台通过后持续接单，后续零就绪只排队，恢复逐机重探。保留账号8小时冷却、5分钟空闲原机重探、15分钟空闲结束；没有修改名单、接收窗口20、鉴权或数据库列类型。

## 已准备材料

- 新镜像 `phone-cloud-platform:lookup-scheduling-20261021-rc.3`，ID `sha256:a9e487ecb04afa22def7c926541a06be5593191066652881388d017e54022dab`。以核实的旧镜像为FROM，仅COPY16文件；无依赖升级、网络下载或生产挂载。
- 云端暂存 `/opt/phone-cloud-platform/staging/lookup-scheduling-20261021-rc.3`：overlay、Dockerfile、hash、仅改phone-cloud镜像的Compose覆盖文件。
- 云端备份 `/opt/phone-cloud-platform/deploy-backups/lookup-scheduling-20261021-prep.1`：ACTIVE、23份Compose、完整PostgreSQL自定义格式导出605723519字节、旧镜像归档65281340字节。SHA256见cloud-backups.json；pg_restore目录可解析。本次未执行完整数据库恢复演练，备份不用于覆盖切换后新数据。
- Windows候选 `D:\PhoneCloud\staging\lookup-scheduling-20261021-rc.3`；旧两文件备份 `D:\PhoneCloud\agent\backups\lookup-scheduling-20261021-prep.1`。当前活动文件未替换。
- 材料位于私有目录；不在Git记录凭据、数据库内容或授权密钥，只保存脱敏校验与路径。

## 实际验证与未验项

候选既有967项全量回归（含投屏回归）、43项准入专项、check/smoke通过。JSON和隔离PostgreSQL分别50条普通HTTP测试通过；模拟窗口100用于积压，不代表线上允许100。实际121秒重提证据继承rc.1，不冒充rc.3重新运行。

本轮新增：Windows原生Node对2文件语法检查、观察器隔离模拟40/40通过；新镜像16文件hash一致；网络隔离、只读根文件系统、临时JSON目录中实际启动候选，health/ready、文档/卡片脚本/下载指南及ZIP共6个HTTP入口200。该镜像检查是test模式JSON启动，不是生产PG全量启动或真机验收。

生产准备后11:50北京时间：health/ready正常、容器PID777523与01:15:53 UTC启动时间保持；131库存，6路控屏188/154/159/124/54/172，7个查名占用161/162/165/138/53/58/115；返回的查询摘要中2条waiting_human、0条running，既有终态保留。旧版仍有超过5台占用现象；候选未部署，不能宣称已在线解决。占用是瞬时快照，切换前必须重读。

D-075真实宿主机只读live通过：PID2503525、批准二进制d3a9eab6…feec35、8Mbps/2包。宿主无PATH Node，使用现有暂存Node及musl loader运行；没有安装、修复或重启媒体。共享ADB PID8988及Agent14508为SYSTEM；冻结的路径/授权/启动方式不改。未提交任何真实号码或探测、未发群消息、未操作手机。

尚未验：新版生产负载下人工完成到卡片/原任务恢复的真实时延、账号触限切号及自然冷却、生产跨机和长期观察。模拟不替代这些验收。

## 切换与回退步骤（尚未执行）

1. 取得本次明确维护授权，核实窗口内控屏影响；重新比对ACTIVE、18活动文件、23Compose、SYSTEM和D-075。若版本漂移停止切换；若备份已过时先补新备份。避开实际执行中的查名/其他业务，保留等待人工请求，不清锁或取消用户查询。
2. 整套包含共享Agent代码，需在同一维护窗口重载云端和Agent，控屏将短暂断开；仅传文件不会加载完整更新。停止/启动只沿用原SYSTEM Agent计划任务，不碰共享ADB、密钥、端口、驱动、Windows、USB或媒体服务。
3. 云端使用全部原Compose加候选image-only覆盖，仅重建phone-cloud服务，不操作Postgres/Redis/媒体。Windows仅替换并校验上述2文件、沿用原入口加载。数据库保留JSON快照兼容，无迁移；记录实际镜像、进程、文件和ACTIVE部署回执。
4. 核对health/ready、PG/Redis、Agent上报、冻结hash和D-075；再按用户授权用外部API做有界真机灰度。核对原ID/结果保留、人工恢复、最多5预约、分配轮转、首次两台之后单台接单与零台排队，避免操作他人手机。
5. 失败回退：在同一已授权影响范围内恢复两份Windows旧文件及原启动动作，恢复原23Compose选择的JSON兼容旧镜像，必要时从rollback-image.tar.gz加载。保留现有数据库及新增业务结果，不直接恢复旧dump，不回JSONB。旧版忽略新增准入字段，会恢复实时两台接单限制；这是已知回退行为。确认健康与D-075后另存回退回执。

本轮保留既有工作与根仓改动；共同流程修订2026-09-30、SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。前序候选文档中的“未连接/未制作镜像”是当时状态，以本准备记录补充；不改写候选标签内容。
