# 四台企微占用恢复准备（未上线、未释放）

基线提交a6445251771a1139e0318c4218585a9cb5c84c42；独立分支codex/wecom-recover-four-20261104；候选wecom-recover-four-20261104-rc.1。

目标仅23/43/59/155。23/43/155的legacy旧配置交付失败沿用已准备的7029028上下文补载；59已登记reader退出且配置阶段0ms失败、旧核验超时，新增独立管理员维护分支。钉住原reader身份，严格原task/job/验证记录指纹；新proof不覆盖原失败、不续签旧验证、不重放添加、不直接删锁。只读原生产记录的离线候选校验四台均符合，见offline-context.json；不是四台已恢复。

定向55通过；扩围172项：170通过、2隔离PG条件跳过，这2项随后在独立临时本地Postgres真实执行2/2通过。root check及smoke通过，均未接真实手机。Windows取证只读，Agent15224和固定ADB31384未变化；其他在途/自有staging不操作。

部署应以当前aba0ddc3及已准备8f145ef6(rc.2上下文补载)为精确基线，只覆盖本候选两个cloud模块，保留其他组件及CPS未上线状态。备份目标原记录及旧镜像/Compose/ACTIVE后，须获本次云端重载窗口；不需更改Agent/ADB/身份/keys/媒体。发布前后真实媒体宿主verify --live。服务恢复后逐台GET提案及具名POST原义务维护请求，观察真实新proof和持久化释放；任何不确定不修改原记录或继续新attempt。当前尚未执行这些生产恢复步骤。

回退保留旧image/Compose和原数据库，不恢复旧发送记录、不DROP/DELETE义务、不重新添加客户。真实原生3秒proof及四台最终available尚未验证。


## 已完成的生产准备（未激活）

已提交源码de6cf4057de8c0c24fe0b23405db4a9a8d80748f，候选wecom-recover-four-20261104-rc.1。基于已准备8f145ef6上下文镜像只COPY两个新cloud模块，未启用镜像50a1fafcf13f739a0a4173048ed9065e470484eef95f2381ca2ed94cf29a86b6；共5文件hash及leaf import验证通过。Compose只有主业务image变化，环境与当前一致，现有小红书配置只在子进程环境复用，未输出或落盘凭据。

实际生产备份位于/opt/phone-cloud-staging/wecom-recover-four-20261104-rc.1，目录0700、四台原记录0600；4设备、4物理义务、4原普通lock、5原task、4原job，备份SHA256 84126890838dfbda8d854f3e206957b2d0c4aba57a32c7ef417ee476d1445379。ACTIVE/Compose指纹、旧镜像及5文件旧bytes/原缺失项均保留。未导出全库，不向仓库复制含客户信息的备份。

真实媒体宿主D-075 live通过，PID2503525、原binary、8Mbps/2包保持。当前ACTIVE仍9afc29ae、运行image aba0ddc3、Agent15224/ADB31384未变化，无服务重载或状态释放。

05:59Z在用74/82/163/159/91五路控屏，查名2执行/2等人工，配置enabled/rev187。数据库还含历史非终态行，不能把这些行数直接当Agent真实在途数。已向用户请求“等当前任务安全收尾后，约3分钟仅云端维护”，待本次明确答复，不沿用上一窗口授权；未提交任何恢复POST。prepared.json/manifest.json/impact.json为此次准备和影响范围记录。
