# 三接口查名文档已上线

2026-10-16 11:29:45（Asia/Shanghai），用户明确回复“现在更新线上文档”。文档候选b0a22da6cf48e8b502e1573ee80dfc2974a5909a、tag lookup-public-docs-20261016-rc.1，分支codex/lookup-public-docs-20261016。

只替换7个public静态文件，HTML最后更新刷新脚本缓存。查名对外文档只展示启动准备、提交手机号、获取结果三个接口；旧服务端路由和SDK功能保持兼容。线上33个接口页面实际浏览器逐项导航通过、无新控制台错误，窄屏菜单三个查名链接点验通过，7文件公共HTTP200和SHA、ZIP清单、专用OpenAPI三路径通过。用户原来打不开的prepare锚点已确认恢复。未发送业务查询。

运行仍为deployed.16/a479fab与b5479d9c镜像，附7静态热补；下次启动镜像已保存bc6e3c1fea840f8da7ddefa2d802c728e6af4381d9cca7ba4987fd2525a6344a，ACTIVE与Compose链已记录。当前容器ID、PID1381680和启动时间完全不变，healthz/readyz200。D-075前后实际宿主机live通过，媒体PID2503525及8Mbps/2包不变。未重启云端、Agent、ADB、Windows、USB或媒体，未修改SYSTEM身份、配置或设备池；未中断控屏。

第一次准备构建将镜像ID直接用于FROM，被构建器当成远端名称而失败；当时尚未替换线上文件。随后核对本地rc.16镜像标签确实指向b5479d9c，再使用该标签构建成功。失败和修正如实记录，不将失败构建视为发布完成。

备份：/opt/phone-cloud-platform/deploy-backups/lookup-public-docs-20261016-rc.1。回退仅恢复7静态文件和原Compose/下次镜像，不恢复数据库、不重启服务；先CAS核对ACTIVE及文件哈希，保留后续并行改动。制作候选时281个运行代码文件哈希保持一致。本次仅文档验收，不改变之前真机50条验收尚未完成的结论。根仓既有改动保留，未推送。

对外入口：/api-docs.html?scope=lookup#lookup-flow；下载包：/downloads/name-lookup-integration.zip。
