# 当前运行与回退

当前正式运维组合是 `/opt/phone-cloud-platform/docker-compose.yml` 加 `/opt/phone-cloud-platform/staging/platform-update-20261012-rc.3/compose.candidate.json`；哈希见ACTIVATE。后续只启动phone-cloud时沿用此组合，不单用base重新build。仍引用rc.1目录下0600飞书secret，该目录是运行依赖，不能当缓存清理。

```bash
docker compose -f /opt/phone-cloud-platform/docker-compose.yml \
 -f /opt/phone-cloud-platform/staging/platform-update-20261012-rc.3/compose.candidate.json \
 up -d --no-deps --no-build --pull never phone-cloud
```

三个文档状态文件需回退时，上一业务镜像41af已归档，使用rc.1的candidate Compose，仅回退文档显示，不重载Windows。整个业务功能退回907时，使用base加rc.1的compose.rollback.json，配套停止唯一PhoneCloud Windows Agent任务，将冷备份agent-state-code.tar中的2份原有目标运行文件恢复；4新增模块在after哈希无漂移且无新引用时移入隔离目录保存，不盲删。具体旧备份路径/sha见rc.3 CLOUD-STOP-BACKUP/WINDOWS-STOPBACKUP和rc.2 BUILD/BACKUP。

保留当前data、冷却、未确认outbox与通知回执；不整库恢复覆盖发布后的新业务。回退仍需空闲窗口/原ID对账；用户再次使用时不自动停止。实际媒体宿主机前后执行标准verify.mjs --live，失败停止，不修复或重启媒体/ADB/USB/Windows。

本轮未在生产实际回滚。完整PG备份格式/TOC及旧源码哈希已验证；先前隔离全库恢复成功见rc.2，本轮新鲜dump未再次全量恢复。最新镜像归档/OCI identity见IMAGE_ARCHIVE；最新完整PG及文件温备份见BUILD_BACKUP。Windows停机冷备份为原有code/config/data，logs/cache未动。
