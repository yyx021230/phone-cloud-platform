# 应用回退材料与边界

旧生产版本platform-integration-20261028-deployed.1，主云/旧批次镜像sha256:fca45ec32e72b0787e4375fd6812a5ac97d3aebec4b830b6393b03117554b45e已实际核实且保留。生产回退目录为/opt/phone-cloud-platform/staging/platform-integration-20261029-rc.1/rollback，保存原ACTIVE/32个Compose实际字节及29份云端运行文件；旧Compose链和仅image覆盖校验在CUTOVER_PLAN_PRIVATE.json，含身份环境的解析值不写仓库。

Windows原22文件或原本不存在的状态、原哈希与备份在D:\PhoneCloud\staging\platform-integration-20261029-rc.1\rollback；另小红书数据同步.py原cbf038e2字节在rc.3\rollback。回退前核对当前文件仍是本轮已知hash，存在并行更改即停，不覆盖他人内容。

本轮没有数据库迁移，不计划恢复数据库。新全库备份未完成；只形成七张关键配置/锁/批次表快照，已本机完整解码，未做完整数据库恢复演练。旧2.9GB完整备份保留，仅核实文件存在/大小，不能冒称新鲜全库备份。禁止用旧库覆盖新增客户结果、未知任务、send claim、Agent本地claims、outbox或lookup-reader-capabilities。

需要回退时先取得当前维护/副作用范围，核对真实在途任务、投递ACK、outbox、有效lease及未知发送，原ID保持。旧版本不保证理解新发送claim/容量协议；一旦有新发送记录，不能盲目双端降级，需先逐任务审查兼容及防重放。只用既有SYSTEM任务入口，精确核PID/创建时间后结束Node；禁止递归杀树、共享ADB重启、身份/密钥/启动动作变更。旧reader及后代退出必须单独核实，不能用Node退出代替手机清理证明。

云端正常关闭需等待saveState返回及旧进程退出；本次已有HTTP关闭10秒watchdog退出1现象，已记录，没有强杀。新启动实际超过原编排健康等待时间，不能按91秒历史值承诺回退时长。只重建经确认的业务服务，不执行整栈up/down，不重启Postgres/Redis/媒体/Windows/ADB。恢复后核原ID/配置/结果、健康与新鲜心跳及真实媒体宿主D-075 live，仍保留8Mbps/最多2包与原自定义二进制/drop-in。
