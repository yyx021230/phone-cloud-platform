# rc.13 切换前回执与接续

运行源码c27a6d0/lookup-readiness-20261015-rc.13；覆盖文件RUNTIME_FILES.json。旧版deployed.10、ACTIVE hash见PREPARATION。旧恢复候选a707c4c9镜像不再作为本次切换目标；新组合镜像3102e2fd包含rc.12和156兼容及恢复rc.3，隔离network=none/tmpfs实例22文件hash、6HTTP200、未签名prepare401通过。

云端备份/暂存、Windows备份/暂存见两个PREPARED。482420700字节PG备份已完整解码但没有恢复演练；旧实际镜像另存归档。Compose pending只改业务服务image/版本label，未激活。配置与授权预加载只核hash，未复制或改密钥。D-075真实宿主live通过；切换前后仍需重验。原有冷却/请求/结果/恢复状态必须保留。

## 切换门禁

17:00占用147/146/126控屏，156needs_recovery，无Windows执行任务。已请求约5分钟云端+共享Agent维护，尚未批准。用户同意后再次读取最新占用；若有新增业务/控屏超出范围先告知，不用旧快照。核对部署锁/其他更新、ACTIVE/Compose及22来源hash、SYSTEM进程/唯一5037/原PID634172、计划任务XML/config/preload hashes。任何漂移停止，不自动覆盖。

云端先以原8层Compose加暂存pending，仅加载phone-cloud；PG/Redis/Nginx/媒体不动。ready及新恢复控制协议可用后才加载Agent。停止范围仅原Agent634228，不能taskkill /T或用会停止ADB的全局脚本。启动使用原SYSTEM计划任务，原动作/config/preload不改；启动前后确认ADB634172持续存在，否则停下报告，不拉起替代server。

Windows只替换4个src和1个visual脚本；另2个继承Python已经匹配，仅核对保留。所有目标从已提交组合对应stage取hash，恢复状态在停Agent前另留时间戳快照；不把旧备份状态覆盖到当前。维护中156原请求保留，不把未知结果写空，不主动取消。

完成后验证云镜像/ACTIVE/Compose、22文件、Agent单实例SYSTEM/扫描心跳/outbox、恢复协议revision ACK、原ADB/config/preload/任务动作不变、D-075。写正式部署回执与不可变deployed标签。没有正式回执前不得将prepared写成已上线。

## 真机验收与收尾

参见rc.13 README：先核156原请求，可运营恢复但单独记录，不能计入外部透明链路。选择获授权名单内当时空闲手机，保护他人控屏；配池运维保存原配置/CAS版本，不伪造就绪。新业务只通过公网HMAC prepare/tasks/GET，首批五条最多十条；实际121秒换请求键，返回原lookupId并只读核对attempt/Windows输入次数。逐条完成/队列补位/真实执行重叠分别取证，没出现的自然分支明确未验。原任务未排空时不强制清理或改结果；排空后CAS恢复原池配置。

回退用原镜像归档/Compose/目标文件备份，业务数据不回滚。若新Agent已产生暂停/隔离，旧Agent会忽略这些控制，不能无条件回退并恢复循环；先停在已授权维护范围确认每个隔离目标。云端回退前也需核对公开容量/状态契约影响。任何ADB/身份/密钥/Windows/Hub/媒体恢复均不在本次授权范围。
