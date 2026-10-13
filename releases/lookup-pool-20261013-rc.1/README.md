# 统一设备池查名：本地候选 rc.1

对外新增`POST /api/v1/open/name-lookups/query`，请求体只需phoneNumber，本次HTTP直接返回`{ok:true,name:"**某"}`。SDK封装签名；实际业务须保存幂等键。姓名保持支付宝页面实际脱敏形态，未查到与执行错误分开。

内部49个编号统一纳管，最多5台自动执行、同机串行。平台处理首次账户准备、会话复用、触限切号/冷却、拼图人工接续、普通恢复、取消、未知状态和晚回执；已开始的查询不盲目换机重复。只有准备阶段确定失败允许换另一台1次。设备池管理入口`/lookup-pool.html`已加入管理员工具栏；旧7个外部接口保持兼容。

**仅本地候选，未上线、未推送、没有操作真实手机或飞书。**49台是登记清单，尚未核验生产稳定映射与五台真机并发。根工作区已有改动完整保留，代码在独立worktree和`codex/lookup-pool-20261013`。

## 版本与来源

- 候选标签：`lookup-pool-20261013-rc.1`，不可变annotated tag；精确提交用`git rev-parse lookup-pool-20261013-rc.1^{commit}`核对。
- 运行源码完成提交：`5b22bf1e0ab78a441abd47b1691a8e0c53e2d098`。后续候选提交仅补回执、文档与哈希，不修改运行源码。
- 基线：`lookup-pool-20261013-base.1`/238ec809，来自最后已提交生产组合，30个云端文件与历史部署回执匹配；查名Python补丁24a9429c完整保留。本轮没有重新连接生产确认今日基线，正式发布前必须核对ACTIVE、实际镜像和文件hash。
- 核心阶段：bae07e52，`lookup-pool-20261013-core.1`。原设计标签与基线标签保留，不移动。
- [VERSION.json](VERSION.json)、[MANIFEST.json](MANIFEST.json)、[验证回执](verification/RESULTS.json)、[更新说明](RELEASE_NOTES.md)。manifest记录文件SHA256，不把package.json的历史0.1.0当生产版本。

## 接入与本地复验

先读[同步/兼容API说明](OPEN_NAME_LOOKUP_API.md)及[SDK说明](sdk/open_name_lookup/README.md)。候选门户共40个操作，其中8个HMAC操作（1新同步、7兼容）；[接入包](public/downloads/name-lookup-integration.zip)包含实际候选SDK、OpenAPI、签名辅助及校验清单。

```sh
python3 verification/verify-candidate.py
python3 verification/run-local-tests.py
python3 verification/run-postgres-tests.py
```

本地验证脚本使用本机既有Node/Agent依赖与Python/OpenCV缓存，复制到临时目录，显式清空生产连接变量；PG脚本创建独立loopback PostgreSQL16临时集群并在finally停止自己创建的进程。路径不同的机器须先调整本地依赖路径，不能用生产数据库代替。测试只用合成号码和fake Agent，不运行实际手机命令。

最终验证：隔离旧业务smoke、语法、Node602、Agent290、Python163、SDK Node4/Python2通过（套件有重叠，不合并计数）；真实本地HTTP覆盖20请求/5并发/每机1、幂等、租约ACK、拼图原任务、恢复、取消、重启晚回执。临时PG覆盖同一HTTP流程、事务回滚、单协调器、终态归档、重启和跨租户隔离。34个冻结运行文件及原Pythonhash一致，旧39公开契约保持，ZIP匹配SDK且可重现构建。浏览器验证管理入口、设置保存/重载、49行及390宽无整页横向溢出，文档同步接口可见、控制台无错误。

## 启用、兼容和回退准备

1. 默认`MANAGED_NAME_LOOKUP_ENABLED`关闭，不改变现有线上白名单。正式启用要求现有HMAC开关、structured PostgreSQL及安全连接配置；在已认证数据库会话中执行[新增两表迁移](deploy/sql/20261013-managed-lookup.sql)，不自动迁移生产。
2. 云端与本候选Windows Agent配套发布；仅宣告`managed_lookup_v1`且执行器健康的Agent可被派发。旧Agent继续原功能，不能运行新池任务；ACK不确定不查号，代际不匹配拒绝写结果。单业务进程，第二managed协调器被拒绝，不支持业务多实例扩容。
3. 管理员核对49编号的唯一稳定deviceId，小范围启用并登记客户端用途授权。调整成员/授权/并发使用管理页，保存无需重建容器。SDK新方法190秒，服务端默认120秒、最多180秒；代理建议210秒，[示例](deploy/nginx/managed-lookup-location.conf.example)未应用，真实链路仍待验。
4. 发布前按单机、两机、五机灰度，验收自然触限切号/8小时到期、OEM、真实Agent重启/取消、共享容量与投屏影响。冻结媒体及投屏保持，D-075只能在真实媒体宿主机发布前后只读live核验。本轮没有执行生产live。
5. 回退先暂停池受理并安全排空；人工/未知/停止中保留预约，确认停止后才能退回旧应用，不能以TTL当停止证明。保留两张新增表、原请求/结果/冷却及回执，不破坏性删表。完整退回组合基线前必须核对当时实际生产版本，不能把本地历史基线整仓覆盖生产。

PG终态当前持续归档、不自动删除；最低保留7天，清理周期上线前明确。JSON只用于开发，不承诺跨文件原子事务。高级p95/归档分页不是当前管理页功能。尚未完成的真机/代理/生产验收明确保留，不能把本地回归称为生产全量验收。
