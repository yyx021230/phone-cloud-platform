# 查名启动探测候选

版本 `lookup-readiness-20261015-rc.1`，本地候选，未上线、未推送。

新增启动接口：至少2台探测通过可接单，后台补至5台。业务只分配已验证手机；确认触限后持久冷却并结束旧执行，原号码以同一个lookupId转给另一台已就绪手机，异常手机独立切号探测。无可用手机排队，执行未知先对账。完成只返回姓名或空字符串；未实名为空，网络/OCR失败不是空姓名。

基于已部署源码509bea2的不可变交付包，不使用根仓旧业务。38个覆盖文件清单及hash见VERSION.json、MANIFEST.json。兼容未调用prepare的旧客户端；调用prepare的clientId显式启用新结果格式。需云端和Agent配套更新，并在平台内部配置已授权、已知有姓名的LOOKUP_READINESS_PROBE_PHONE，不把真实值写入仓库。

本轮完整Node739、Python344、SDK Node22/Python4、传输Node6/Python9、合作方持久示例7通过（入口有重叠）。隔离HTTP/PG验证2台先就绪、5台模拟并发、1台等待另4台先完成、触限转交、实际121秒换8键防重、姓名/空姓名、重启失效及清理。24个冻结hash不变；D-075仅repository核验。本机ADB清单为空，未做新版本真机/Windows原生OCR/自然冷却验收，不能称生产全量通过。

可复现组装（输出必须不存在）：

```sh
python3 releases/lookup-readiness-20261015-rc.1/verification/prepare-local.py --out /tmp/lookup-readiness-review
```

在组装目录配置本地依赖后执行上述RESULTS中的命令。HTTP脚本只绑定loopback及模拟设备；PostgreSQL仅接受127.0.0.1的独立测试库，须先应用既有20261013-managed-lookup及async迁移。用READINESS_HOLD_MS=121000与MANAGED_LOOKUP_TEST_DATABASE_URL运行 `node verification/readiness-http.mjs` 可复验真实两分钟等待。不要继承生产连接。

接口说明：[OPEN_NAME_LOOKUP_API.md](OPEN_NAME_LOOKUP_API.md)。交付包：public/downloads/name-lookup-integration.zip；只交付已批准部署版本，当前包标明候选。

## 回退和发布边界

本次没有发布授权，不加载生产。后续发布前须重新核对ACTIVE/Compose/镜像/Agent文件与当前生产，完成真机灰度、回滚备份、D-075宿主机live核验并取得具体维护窗口。

不能把旧协调器直接加载到仍有prepared任务的池：先停新准备/受理，排空并确认执行结束，保留业务ID、别名、结果与冷却；执行未知时保留占用并停止回退。与合作方确认旧结果格式兼容后才按上版回执恢复云端/Agent文件，不回滚数据库数据。若需保留新格式读取而回退执行，优先兼容前向修复。不得重启ADB、USB、Windows或媒体，不改变冻结参数。
