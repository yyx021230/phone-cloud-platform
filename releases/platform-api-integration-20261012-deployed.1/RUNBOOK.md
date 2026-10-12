# 本次文档运行与回退

生产目录/回执：`/opt/phone-cloud-platform/staging/platform-api-integration-20261012-rc.3`，备份子目录backups。当前运行base4e484ed7+11静态热补；下一次重建选择97633e24镜像，使用ACTIVE列出的两个Compose路径，不从根仓旧HEAD或单独旧Compose恢复。

未来业务重建命令（本轮未执行，仍需当轮维护授权）：

```sh
docker compose --env-file /opt/phone-cloud-platform/.env -f /opt/phone-cloud-platform/docker-compose.yml -f /opt/phone-cloud-platform/staging/platform-api-integration-20261012-rc.3/compose.candidate.json up -d --no-deps phone-cloud
```

新overlay从上版overlay精确复制，只替换image；包含既有秘密文件引用的历史目录不得当缓存清理，不在回执显示其内容。上版71b02934及restart-image.tar保持，新版镜像归档restart-image.tar及SHA见BUILD_BACKUP。使用实际ACTIVE、组件哈希和回执定位发布，不依赖目录名或0.1.0。

静态回退：精确核对本轮9资源哈希与实际发布身份，恢复backups/public下原5文件，撤下本轮4下载路径；保留原index.html/styles.css入口热补与所有业务文件。恢复备份ACTIVE及旧双Compose镜像选择；不重建、重启容器，不回滚数据库。隔离容器已经演练旧5哈希恢复/新增4不存在，见ROLLBACK_VERIFY。真实回退仍按当轮确认与影响边界执行。

部署与回退前后在媒体真实宿主机执行D-075只读verify --live，不做修复或重启。宿主机工具位于本回执tools：使用原容器复制的musl loader/node、未安装软件，实际systemctl/proc/binary/drop-in读取均发生在宿主机，不冒充repository-only结果。
