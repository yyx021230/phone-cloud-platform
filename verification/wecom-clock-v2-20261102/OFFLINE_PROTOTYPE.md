# 离线延迟原型范围

仅验证草案的挑战顺序和保守3秒窗口是否在本地可行，**不实现生产v2协议**。

- Node只监听127.0.0.1随机端口，所有路由为`/fixture/*`、消息含fixtureOnly，不识别任何生产binding/认证或API。没有生产连接、ADB/SDK、SYSTEM任务、驱动、密钥、系统时间修改。
- Python是新spawn的本地子进程，只读自己/父进程的真实PID及出生时间，使用真实私有管道。最小bootstrap nonce、错PID/旧pipe nonce拒绝、真实OS close等待可实际观察。machineId为明确合成值，不声称SYSTEM/机器身份通过。
- Python在收到挑战之后才调用**未修改的产品`wecom_physical_verify.verify_empty`真实函数**，保留其首项事实/两帧/身份复读/250ms间隔/3秒限制。旧host不存在、两个包和全部forward读数均由**合成空结果与受控延迟回调**提供，每次合成读保留前后父进程身份/预算检查；没有创建ReadOnlyAdb、SDK或socket，没有读取手机或媒体。它们不是可提交生产的proof。
- 原型以本机performance/time.monotonic计时，只证明这次本地运行中的延迟；尚未认证暂停感知时钟，**不能证明Windows/云端睡眠暂停的连续性保护已实现**。测试中的epoch变化只是受控字段变化，未重启服务器/业务。
- 挑战签发至接收proof包含实际HTTP往返、两帧合成读取/身份检查、Python管道及实际child close。正向保留全部检查；2700ms响应延迟加两帧与250ms close、3000ms close，以及600ms单读延迟均应失败，不重新签发挑战或重盖首项事实。
- 提前首项事实消息、错PID/旧nonce不会到proof；本地固定±5分钟audit offset不改变预算结果。原型错误只清理它自己持有的本地child，不对任何生产进程执行操作。

运行：`node --test verification/wecom-clock-v2-20261102/latency-prototype.test.mjs`。结果文件绑定实际源码hash；所有测试通过仅指上述8项离线实验，不代表v2产品实现、持久事务/journal、系统暂停或真机验收。

暂停/时钟连续性模型仍是实现门槛：只有经过验证能包含宿主/VM暂停的同机时间源才可签发/接受授权；否则连续性未知即关闭当前epoch。所需负例包括服务器暂停10秒而普通mono不前进、两端同时暂停、Windows单独暂停、mono回退、wall前/后跳及server重启。不能用另一台机器的wall补算，也不能因prototype在正常运行时通过而默认这些负例已过。
