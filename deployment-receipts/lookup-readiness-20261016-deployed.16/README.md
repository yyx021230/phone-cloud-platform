# rc.16 已发布，50条外部API真机验收进行中

2026-10-16 11:00:40–11:01:34（Asia/Shanghai）完成云端切换。用户明确批准159、93、162、75、52、172六路控屏短暂断开；先前五路授权的首次执行因新增占用在任何变更前停止，取得六路授权后继续。仅重建phone-cloud容器，Agent、ADB和SYSTEM身份均未动。

运行代码a479fab54bfa67147a5391015c34e7b759efa43a，候选标签lookup-readiness-20261016-rc.16，运行及下次启动镜像b5479d9cfc0d6bf6ab5d2ee748856d4867cf6e21c118ab317709ba501519cda7。27项运行文件、healthz/readyz、Postgres/Redis与公开SDK ZIP哈希通过；误访/health、/ready返回404后按实际/healthz、/readyz核验200，不将错误路径计作故障或通过。D-075实际媒体宿主机发布前后live通过，媒体PID2503525、8Mbps/2包保持。发布后只读核验Agent650400、ADB634172及既有四文件哈希，SYSTEM不变、outbox为0。

备份、更新说明与回滚点见[准备回执](../../deployment-preparations/lookup-readiness-20261016-rc.16/README.md)。回退仅恢复上一版Compose/3ff9e524云端镜像，保留期间新增业务数据，不恢复旧数据库覆盖新请求。未重载Agent、重启Windows/USB/媒体或运行ADB客户端。

11:03先以156、164两台空闲手机灰度，原池revision52 disabled，经CAS53启用；未清理冷却/隔离/锁。重新下载正式公开SDK，SHA256核对8c2363be…通过；本机以外部HTTP/HMAC prepare、POST tasks、GET tasks/{id}执行原授权表索引150–199共50唯一号码计划。先两台验收，再启用空闲候补115、155、161、51、54，执行上限5；161仍按真实冷却状态跳过，130保持禁用，其他手机不参与。

本记录只确认部署和验收开始，尚不能宣称50条完成、5台实并发、人工恢复优先、候补补位、空闲过期重探或自然触限转交已通过。后续实际证据另存，不把816项本地回归/121秒HTTP模拟当真机结果。原工作区改动保留；未推送。
