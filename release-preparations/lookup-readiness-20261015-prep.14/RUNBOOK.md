# rc.14 热更新准备

当前用户明确授权rc.14/e86d414发布、原表号码外部API验收，禁止影响其他手机和ADB/SYSTEM。生产deployed.13/c27a6d0，运行镜像3102e2fd；既有cloud/windows安全SSH复用。根仓已有变动保存，工作分支codex/lookup-recovery-combined-20261015干净起步。

只改1个运行Python文件，候选560Python/801回归/Windows31通过；镜像10ae730b network=none隔离ready且脚本hash通过。实际前置D-075 live、SYSTEM Agent650400/ADB634172、原hash/config/preload均通过；0查询通道/0执行任务/池disabled46，目标115/162/155/156/164均无占用。其他125/95/157/146/126控屏保留，不重载服务。

备份：云deploy-backups/lookup-readiness-20261015-prep.14保存ACTIVE/旧脚本；旧镜像3102保留。Windows backups/lookup-readiness-20261015-prep14保存旧脚本及ACL，stage新脚本hash8ba90c21。无数据迁移/删除，冷却不回滚。

最终门禁再核占用、实际版本与hash；Windows无残留Python进程时原子换脚本并恢复ACL，若有目标worker需确认空闲再窄处理，不能停止其他工作。云仅原子同步同一脚本、把新镜像层登记为下次启动，业务容器/Agent/ADB/媒体不重启。ACTIVE明确运行镜像+1热补与下次镜像，部署后再D-075/live/hash/health。

灰度先只允许115/162原表授权号码，最多10条业务；通过外部prepare探测115冷却账号切换及重新就绪，再tasks/GET与>121秒换键。若自然卡顿或触限，保留ID核对跨机/排队，不故意制造掉线或清冷却。按实际情况再纳入155/156/164空闲机。查名隔离只精确解除115，原恢复隔离/其他手机号不动。结束排空后CAS恢复原池，保存真实冷却，未完成请求不强制取消。

回退：新问题停止接单、原请求对账。仅从本次不可变备份恢复脚本/ACL与对应启动材料，限定空闲worker，不回滚数据库。若需要共享重启须停下说明影响。初次Docker FROM使用原始sha256被解析为仓库名，构建未成功且未改变生产；改为已核验ID的本地rc.13标签后隔离通过，无依赖升级。

用户提出提交10/20条排队：独立本地候选，默认20未完成、并发仍5、重复优先；不混入已批准rc.14。
