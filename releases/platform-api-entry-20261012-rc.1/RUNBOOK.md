# 当前运行和回退

已发布源码：`platform-api-entry-20261012-rc.1` / `8ceaf56f1927637520f082c9c356ea49847c8b25`。只有public/index.html和public/styles.css发生运行变更，前后哈希见MANIFEST；26项云端核验见ACTIVATE。

运行容器仍为8f399b21、PID2684217，基础镜像4e484ed7，加上述两文件的原子静态热补。容器未重启，Windows Agent/ADB/媒体未操作。未来重建用不可变71b02934镜像，已完成独立无网络HTTP启动验证并归档。普通docker restart保留现有容器写层；重建必须沿用以下组合，否则旧Compose可能恢复旧入口。

```bash
docker compose -f /opt/phone-cloud-platform/docker-compose.yml \
 -f /opt/phone-cloud-platform/staging/platform-api-entry-20261012-rc.1/compose.candidate.json \
 up -d --no-deps --no-build --pull never phone-cloud
```

此命令本轮没有执行；今后执行需要当轮停机/灰度授权。base及overlay指纹见ACTIVATE。既有飞书secret仍引用rc.1阶段私密文件，该目录不能当缓存清理。生产ACTIVE_PLATFORM_RELEASE.json分别记载运行基础镜像、两文件热补及下次启动镜像。

两份旧静态文件及旧活动记录在同名staging目录的backups下，哈希见BUILD。静态回退先确认当前after哈希无漂移，再将旧HTML和CSS分别复制为临时文件、校验、原子rename；旧HTML先恢复，CSS后恢复。同步恢复上一活动记录/Compose指向。避免覆盖其他人的后续变更，不重启设备或恢复数据库。

旧基础镜像4e484ed7及PG/文件完整备份沿用上一部署回执；本轮不涉及数据模型或数据变更，未再次备份/恢复数据库。新71b02934镜像归档路径/哈希见IMAGE_ARCHIVE。本轮未在生产实际执行回退。

本轮local UI隔离测试、线上三页面/新窗口、9HTTP资源、26运行哈希及媒体宿主机D-075前后通过。只修改文档入口和相关外部样式，未重跑此前594/289等全量测试。查询新号码、自然触限切号/真实拼图恢复、两机/OEM、8小时及24–48小时仍待验收；本轮0查询/0飞书，上一轮授权1次通知已使用。
