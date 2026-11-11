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


## 06:06后新增授权与前置阻塞（未切换）

用户已批准一次云端重载，另要求完整保留现有查名占用/账号/冷却/请求状态。完整一致性快照已在远端0600保存，仓库仅保存脱敏摘要lookup-before-maintenance-summary.json；51设备/9channel及关联49session/288job/326task/140历史和当前lock。pool enabled/configRevision187未动，不用会清退热channel的disabled维护方式。原两条当前任务已终态，见drain-original-tasks.json。

旧SYSTEM恢复脚本把实际查名runner与隔离OCR误识别为残留，四台恢复将在原生第一关失败。因此未上线云端、未创建proof attempt、未消耗一次重载。四台只读预检包PID/forward均0，见target-resource-preflight.json；这不是原生proof。

新增本地一文件恢复脚本修复及反例：固定其他serial/SYSTEM/Agent/Python/模式/ADB路径和严格OCR父子链可共存，目标serial/未知/伪路径/非SYSTEM/循环/孤儿/父PID重用等继续停止。Python企微579和投屏69通过，原3秒challenge与SDK/ADB/控屏不变。实际只读候选另遇独立staged小红书进程，保持未知停止、等待其完成，不结束他人进程。云端窗口已有授权，但用户“别动Agent”仍限制一文件生产热更新：单文件例外未获准，不重载Agent、不触碰ADB、不把本地579当四台真实恢复成功。
