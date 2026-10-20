# lookup-offline-round-stop-20261020-deployed.1

2026-10-20 17:40–17:41（Asia/Shanghai）已上线。候选rc.2 / 59ce44eb871754fb34924836a5c0538919b8cc72；实际镜像0207e744，上一版c84f493d。当前运行和下次启动镜像一致，16项覆盖/44运行文件hash通过，继承恢复界面并同步卡片、文档。

实现：查询中持续离线30秒，隔离旧尝试并保留原lookupId转其他已就绪手机；显式stop或无业务15分钟空闲结束时，离线清理不再无限阻塞stopping。重连须真实stop/ACK后复用。包含之前本地待命收敛和外层卡片人工状态候选。未改外部调用契约、48设备配置、最多5执行槽或数据库schema。

用户批准本次约2分钟窗口内所有控屏短断。切换前实际114、142、156、118四路，业务/通道/待执行任务均0；云端切换约61秒。没有Agent、ADB、SYSTEM、Windows、USB、媒体重启/变更；环境hash不变。原故障轮次在发布前已自行stopped，本次不把它归功于补丁。

验证：926回归、JSON/隔离PG模拟HTTP、镜像network none启动此前通过。上线44运行文件、10公网资源hash一致；health/ready 200、Postgres/Redis正常，容器healthy/重启0，131总/125上架/118在线，启用Agent新鲜心跳；48池/revision58/执行上限5保持，0通道/0未完成/0stopping。公网HMAC调用原prepare键幂等返回200/stopped/同preparationId；没有使用新prepare键或提交业务号码。API Key鉴权未改，本轮公网实测是既有HMAC兼容入口，不冒充新的Key真机全流程。D-075实际宿主前后live一致，批准二进制/8Mbps2包/PID2503525保持，有界200行指定错误0。

没有人为制造生产断线，没有新真机跨机或15分钟墙钟验收；生产全量验收仍未完成。其他正在运行系统的脚本不在本次发布范围。后续正常调用应使用新的准备幂等键开启新轮，旧键继续返回旧轮stopped。

备份deploy-backups/lookup-offline-round-stop-20261020-prep.1，切换前最新数据库537264292字节已完整解码；旧镜像、Compose、ACTIVE和目标文件留存。回退保留当前业务/别名/隔离与物理锁，不回灌旧数据库；有在途或隔离时不直接降级，不能清锁冒充停止。部署脚本及授权见release-preparations同名prep.1。

分支codex/lookup-offline-handoff-release-20261020，候选和已发布标签分开，旧标签保留。ACTIVE绑定此部署回执提交，BINDING单独记录；更新恢复UI历史overlay的当前文件hash并保留原始hash，避免下一次基线检查误用旧app.js。
