# 普通HTTP查名文档已发布

2026-10-16 **11:57:51（Asia/Shanghai）**，按用户本轮“现在更新线上文档”授权完成9静态文件替换。

- 候选：`lookup-http-guide-20261016-rc.1` / `e474c911122961e98744b93962730f2552c97dee`。
- 文档发布：`lookup-http-guide-20261016-deployed.1`（本回执提交对应annotated tag）；业务仍为`lookup-readiness-20261016-deployed.16`。
- 运行镜像`b5479d9c`加静态补丁；下次启动镜像`03b6928af85439bb69d2ff11f77d882480fa9496f2ba69370215814556b8aaf1`，替换前为`bc6e3c1f`。Compose只有镜像引用差异。
- 容器ID、PID1381680、启动时间03:00:51Z保持；没有重载云端、Agent、ADB、Windows、USB或媒体；未连接Windows。
- D-075真实媒体宿主机发布前后live均通过，PID2503525、8Mbps/2包不变。healthz/readyz均200。
- 公网9文件HTTP200且SHA256与候选一致，ZIP四文件校验通过。浏览器33接口页精确标题、3个Python/HTTP标签、完整源码、复制状态通过，0控制台错误。
- 浏览器下载事件等待15秒未捕获，页面未改变；不宣称浏览器落盘验证通过。已用独立HTTP读取并验证全部下载字节和ZIP，实际下载内容可用。
- 本轮仅文档验收，无真实手机号/设备查询。此前业务真机待验项不因本轮发布而关闭，未宣称生产全量验收完成。

## 交付入口

- [从这里开始](http://47.98.127.132/api-docs.html?scope=lookup#lookup-flow)
- [Python普通HTTP完整示例](http://47.98.127.132/api-docs.html?scope=lookup#lookup-python)
- [HTTP三步调用](http://47.98.127.132/api-docs.html?scope=lookup#lookup-http)
- [下载代码包](http://47.98.127.132/downloads/name-lookup-integration.zip)

## 证据与回退

DEPLOYED.json保存实际镜像、文件、健康、D-075和发布时ACTIVE指纹；PUBLIC_CHECK.json为公网文件核验，BROWSER_CHECK.json区分通过与未确认项。发布后将本回执commit/tag绑定到生产documentationOverlay，绑定动作另存生产RECEIPT_BINDING.json；不改业务receipt字段。

旧6文件、旧ACTIVE及原重启镜像回退点保留在`/opt/phone-cloud-platform/deploy-backups/lookup-http-guide-20261016-rc.1`。生产回执在`/opt/phone-cloud-platform/deployment-receipts/lookup-http-guide-20261016-deployed.1`。回退前再次核对无后续漂移；恢复旧静态文件与文档元数据/镜像引用，保留业务数据和既有部署回执，不重启服务。

分支`codex/lookup-python-docs-20261016`；未推送远端，原根仓既有改动保留。候选快照和既有标签均未改动。
