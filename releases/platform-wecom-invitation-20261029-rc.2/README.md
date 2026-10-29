# 企微四字段系统对接候选 rc.2

本地候选，未上线／推送／连接生产。分支 `codex/wecom-integration-api-20261029`，不可变标签 `platform-wecom-invitation-20261029-rc.2`；源码和归档身份见[MANIFEST](MANIFEST.json)，实际测试见[TEST_RESULTS](TEST_RESULTS.json)。rc.1及其所有历史材料保留。

## 交给对接开发

直接提供 [四字段两步接口文档](../../docs/wecom-integration-api.md)，公开静态副本为 `/wecom-integration-api.md`。

- POST `/api/v1/wecom/customer-invitations`：手机编号、main/clone、好友手机号、备注。首次202返回taskId；进行中或发送/保存未知的同目标同参数重复提交200复用原任务。
- GET `/api/v1/wecom/customer-invitations/{taskId}`：查询原任务。不要求对方传ADB序列号、Android用户、请求号、执行模式或内部租约。
- 单应用允许省略appSlot，双开必须明确，未配置分身或编号映射歧义拒绝；不暗中换手机/账户。备注空白默认“测试客户”，发送模式会按该值更新备注名。
- 仍采用管理员Bearer身份；没有新增独立企微API Key或普通用户权限。状态unknown不表示已送达，原生点击不能当作好友接受；完整状态表和超时处理见简版文档。

## 范围与验证

在rc.1 `ea93f1a` 上只加服务端适配和文档，复用原任务/存储/发送保护。用户澄清后，本轮未提交UI简化已完全撤回。五个UI文件、所有Agent/Python及33冻结文件相对rc.1不变，无依赖或表迁移；旧API及v4协议兼容。没有重新合并其他窗口后续未提交修改。

本地定向39项Node通过，含真实JSON HTTP/假Agent的四字段、双开、三路同时重复、参数冲突、终态/重启、防重、权限、UI、子进程、查名及认证写入保护；根语法及diff检查通过。两对API文档一致。仅自审。本轮没有重跑rc.1全部1702项/Python，未跑新PG、Windows原生或真机，不把历史通过数当作当前接口全量验收。

## 发布及回退准备

candidate-runtime-layer.tar.gz包含32个已提交运行文件，必须结合真实生产基线审核，不能直接整包覆盖。development-rollback-reference.tar.gz只是rc.1对应源码参考，不是生产备份。归档及逐文件SHA256见manifest。

当前无生产变化，无需生产回退。正式发布前重新核验ACTIVE、云端/Agent/Compose及D-075 live，备份当前镜像、数据库、原文件和Agent data发送凭据，确认在途任务、调用方以及维护窗口。这里只需新增云端路由及静态文档；不借接口更新重载Agent、重建ADB或切身份，但首次上线完整企微组件仍须依实际生产版本决定配套更新及另行维护授权。

若回退新增路由：先停新提交，保存taskId及未知记录、等在途任务安全结束，使用当时真实备份恢复服务。旧内部GET接口的jobId与taskId相同，可由平台管理员核对未决记录；不能因简版路由撤回便重发。数据库/job与本地发送凭据不回退或删除，D-075及SYSTEM原ADB保持。回退到未实现企微的生产版本需另核验任务兼容和维护范围，不能把本地rc.1参考包当已部署版本。
