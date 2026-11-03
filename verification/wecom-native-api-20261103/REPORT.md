# 155号正式内部API预览：阻塞回执

日期：2026-11-03。状态：**未完成真机API验收；主号失败，分身未测。**
分支：codex/wecom-native-api-20261103。
本地基线：4355ccdd86ce6e7ebb3499bfae0bd664c3a4ce84（CPS本地候选rc.2，不是生产版本）。
观察标签：wecom-native-api-20261103-blocked.1，绑定本轮文档与证据，不是通过／发布标签。

## 授权与执行范围

用户授权选空闲企微手机测主号及分身，只到发送前，不影响查名、不上线。本轮通过现有生产内部POST /api/v1/user/automation/wecom-preview-tasks、显式mode=preview提交一条155/main；只使用原授权尾6441测试客户，号码经隐藏stdin传入，不写操作命令参数或本地证据。没有调用真实发送接口、send-claim、账号切换、修复／清锁或媒体接口。

新CPS适配器没有上线，也没有真实官方成员映射，本次不是CPS三个新接口正式真机验收。此前独立脚本预览通过不能替代本次正式任务API。

## 开始前事实与本轮判断错误

生产实际business/runtime commit为32c0091a534aa7f9038deb91aa33f202f72e0e6b，ACTIVE SHA256为a5390dcc93b5f1393e7b95732ca4df679dc5065200f80cf509d96e0f759e2a2f。10个云端文件及3个Agent入口文件与该版匹配，SYSTEM Agent19756和ADB27912/出生代次及固定路径确认；没有切换身份或启动ADB服务。

155支持main/user0和clone/user999。预检时listed、available=true，无活动锁、任务、作业或会话；reader8/limit12。155仍在启用的查名池，lookupExcluded=false；59无占用，93有3个非释放旧锁，43/23已有物理清理围栏。

本轮仅凭空闲状态及平台原子互斥，未充分落实主文档已有的旧32c登记失败及停止扩围条件，继续提交了155。这个判断不应重复或作为后续放行依据；此后停止，没有对59、93或分身再投递。

## 原单及失败

| 项目 | 值 |
|---|---|
| device／slot | 155／main／Android user0 |
| job | 464661a8-a392-4030-80a5-522bf68ca67e |
| Windows task | f0604d28-1db4-4b37-ac75-ffa3e9320914 |
| 受理 | 2026-11-03 09:11:40.800 UTC，HTTP201 |
| 终态 | 09:11:41.667 UTC，failed／blocked |
| 原码 | wecom_cleanup_host_unconfirmed |
| 任务模式 | job.mode=preview，Windows payload.mode=preview、previewOnly=true |
| 发送 | sendClaimed=false、sendStatus=not_attempted、invitationSent=false |
| 备注状态 | remarkSaveStatus=unknown，未改写 |

实际发布wrapper在host登记ACK前不释放手机业务配置，只在原子进程close后上报终态；5个实际bootstrap／worker文件与32c精确匹配，后检企微preview／verify进程0、未知Python进程0。因此本轮没有进入手机业务UI、0邀请；不是“到发送前页面成功”。原ready正文及PID/token没有登记留存，不能补造旧host或宣称已有完整物理清理证明。

## 遗留范围与查名

本轮独立义务74f91db7-3beb-4f87-b7d7-678fe2376ad5仍为cleanup_pending／awaiting_host，hosts=null、hostClosedAt为空、verification=null。业务任务已失败，没有其他本轮运行任务，但155被该单机围栏占用，暂不能接新的企微或查名任务。

没有删锁、修改义务、重新下发原查询、改时钟或重载服务。09:19只读查名仍有3条执行／1条等待人工、configRevision183；本轮未写查名配置。09:25 healthz／readyz均200，ACTIVE及10云端文件、原Agent/ADB身份和运行文件保持。其他任务仍运行；不能把这描述成“所有查名设备零影响”，155后续派发确实被保护性阻止。

## 本地验证与错误记录

- 当前候选物理清理／Agent协议相关45项通过，只证明本地对应场景。
- 旧v1跨机器wall比较及实际本地child／HTTP409反例，在隔离提取的生产32c原模块上9项通过；通过含义是风险可复现，不是原生通过或155此次唯一根因已证。
- 最初把历史v1测试直接运行于当前因果协议源码，出现3项协议不匹配失败；原件保留为targeted-tests.txt.gz，未改旧测试迎合新源码。正确来源映射见v1-fixture-source-hashes.json。
- 本轮客户端首个GET误带JSON null请求体；修正GET无body后按原job读取，没有重发。首次证明查询按未索引payload过滤而超时，后续改为原job→windowsTaskId的主键READ ONLY查询并加statement/query timeout；后检无这些原查询。没有把客户端错误当作手机失败原因。
- 没改产品／共享Agent／原测试；不重复整套回归，不将前轮2304项或本轮反例数量当真实API通过。

## 收尾条件与下一步

1. 暂停新生产原生API派发，本轮操作脚本已禁用POST；保留原job/task/obligation及unknown字段。
2. 155只保留单机保护隔离，不关闭他人控屏、不占用别的手机，不改查名池或全局reader并发。
3. 旧生产通用释放接口拒绝物理清理围栏，正式verify又缺原hosts/close，当前没有可在“不上线／不重载”条件下安全完成的解除入口。未准备或执行绕过校验的SQL、伪造host／proof或清锁命令。
4. 后续需要独立评审原义务处理方式及完整新生命周期协议的加载、Windows正向验证和灰度。加载候选也不能视作自动核销旧义务；不得只删跨机createdAt比较、改NTP、换PID或重放UI。
5. 用户仍要求先不上线，因此本轮停在真实阻塞回执；主号/分身完整真机API、CPS新适配器真机联调尚未完成。

本轮没有代码部署可回滚。删除原业务任务不能等同完成物理清理，不能用“回滚”名义删除围栏。原始限定数据留在受限临时证据目录，仓库只保存脱敏投影和原件SHA256；未导出凭据。审查为本线程自审，没有其他聊天或子代理参与。
