# rc.16上线准备回执

2026-10-16 10:52（Asia/Shanghai），状态：待维护窗口确认，未切换、未触发新真机查名。风险R3（共享云端重载）。候选分支codex/lookup-scheduler-rc16-20261016、commit a479fab54bfa67147a5391015c34e7b759efa43a、annotated tag lookup-readiness-20261016-rc.16。既有根仓与旧版本文件保留，未推送。

## 已完成

- 816全量/38定向/check通过；公开SDK loopback HTTP真实等待121032ms后8个新键原ID，20条2执行18排队补到5执行15排队。193个Windows/控屏/媒体文件和云端入口hash相同。修复未连接真机，真实验收仍待执行。
- 从不可变rc.15递归重建成功；两个云模块+文档合计13个生产文件。镜像b5479d9cfc0d6bf6ab5d2ee748856d4867cf6e21c118ab317709ba501519cda7已在network=none/tmpfs隔离启动，ready、27个运行hash、公开文档/ZIP HTTP200通过。
- ACTIVE仍deployed.15、运行与下次启动3ff9e524，ACTIVE hash f143daee；Compose各文件和27运行hash已核对，生产容器启动时间不变。ACTIVE中的此前验收状态滞后于50条审计625cbf8，本轮以实际GET核准池revision52/disabled/0通道/0待处理，不用旧元数据当实时池状态。
- 数据库备份491771443字节，pg_restore完整解码通过；旧镜像备份64181248字节，ACTIVE/Compose/13目标文件齐备。路径与SHA见CLOUD_PREPARED.json。
- D-075真实媒体宿主机live通过，8Mbps/2包、PID2503525不变。Windows只读psutil核验Agent650400、ADB634172均SYSTEM，固定路径/四文件hash保持，outbox0；未执行ADB客户端。

## 当前中断范围与授权

10:52新鲜核对：159、162、52、172、91五路screen_control；100条最近Windows任务中无queued/running/stalled，查名池无在途。已向用户请求约2分钟云端维护，尚未收到本次答复；此前窗口不自动复用。只重载phone-cloud，不重载Agent，不动ADB/SYSTEM/密钥/任务/USB/Windows/媒体。

切换前重读占用、任务、池revision和ACTIVE/hash；有新业务/新增未批准控屏时停止并重新报告范围。维护确认后才能把compose.pending.json加入当前Compose链执行仅phone-cloud的up --no-deps --pull never。前后都执行D-075 live并核对Windows不变量。更新ACTIVE绑定具体a479fab和新镜像，再保存独立部署回执，不把prepared当deployed。

## 真机验收计划（未执行）

先使用空闲156/164，再开放空闲候补115/155/161/51/54，以至少6台候选验证最多5台执行；161当前全账号冷却应被跳过，不清冷却、不解隔离、不抢占控屏。实际名单先新鲜核对；若目标已被使用则跳过，不强停。

本机只使用公开HMAC prepare/POST tasks/GET tasks/{id}做业务：原已授权表索引150–199，50个唯一号码；保持最多20未完成，121秒换键验证原ID；最后两条留到无新prepare/提交的实际245秒空闲后，重新通过公开prepare再提交，审计就绪过期与重新探测。管理接口只用于灰度配置/只读取证/自然排空后恢复配置，不管理重试、改结果或替代外部调用。external-api内脚本只是待运行计划；必须重新下载上线后的公开SDK校验ZIP，凭据/号码经安全SSH读入内存并传stdin，不写文件/参数/日志。

候选代码/API模拟不能替代真机。人工验证由用户完成；正常手机继续消化队列。物理5路、候补替换、恢复后优先、空闲后再探测、自然触限和两分钟防重分别保留证据，未触发的分支标未验。当前允许名单49个编号、池实际绑定48台（148未绑定），不猜测补映射；130保持禁用。

## 回退与检查

若云端启动/27hash/公共契约失败，使用备份前原Compose链恢复rc.15的3ff9e524镜像，只回退云业务；保留新增请求/结果/别名/冷却/隔离，不恢复旧数据库覆盖新业务。当前维护授权须覆盖回退的短断。D-075失败只报告，禁止自动修媒体。候选新增就绪字段为可忽略元数据，服务重启既有owner机制会要求重新探测。

Git差异检查：产品/文档/脚本无空白错误；原始before-fix断言输出4处空白行尾、npm check输出1个末尾空行保留为原始验证日志，未改不可变候选标签掩盖此警告。没有把日志空白警告写成业务测试失败，也没有声称diff --check全零。
