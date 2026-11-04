# 四台企微占用恢复准备（未上线、未释放）

基线提交a6445251771a1139e0318c4218585a9cb5c84c42；独立分支codex/wecom-recover-four-20261104；候选wecom-recover-four-20261104-rc.1。

目标仅23/43/59/155。23/43/155的legacy旧配置交付失败沿用已准备的7029028上下文补载；59已登记reader退出且配置阶段0ms失败、旧核验超时，新增独立管理员维护分支。钉住原reader身份，严格原task/job/验证记录指纹；新proof不覆盖原失败、不续签旧验证、不重放添加、不直接删锁。只读原生产记录的离线候选校验四台均符合，见offline-context.json；不是四台已恢复。

定向55通过；扩围172项：170通过、2隔离PG条件跳过，这2项随后在独立临时本地Postgres真实执行2/2通过。root check及smoke通过，均未接真实手机。Windows取证只读，Agent15224和固定ADB31384未变化；其他在途/自有staging不操作。

部署应以当前aba0ddc3及已准备8f145ef6(rc.2上下文补载)为精确基线，只覆盖本候选两个cloud模块，保留其他组件及CPS未上线状态。备份目标原记录及旧镜像/Compose/ACTIVE后，须获本次云端重载窗口；不需更改Agent/ADB/身份/keys/媒体。发布前后真实媒体宿主verify --live。服务恢复后逐台GET提案及具名POST原义务维护请求，观察真实新proof和持久化释放；任何不确定不修改原记录或继续新attempt。当前尚未执行这些生产恢复步骤。

回退保留旧image/Compose和原数据库，不恢复旧发送记录、不DROP/DELETE义务、不重新添加客户。真实原生3秒proof及四台最终available尚未验证。
