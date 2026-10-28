# 新 Windows 启用准备

2026-10-19，分支 `codex/windows-newhost-setup-20261019`。用户澄清新机没有旧硬盘可读取，延续“补齐后继续启动服务、检查手机在线、不得切换ADB身份”的请求，按已验证迁机备份继续；无法取得备份后至旧机关机的最终增量，不伪造已补取结果。

## 本次绑定基线

- 实际旧机归档：迁机外层包 SHA256 `87a6446f1195eaf6333ef695abd08790bc9a1725abd9fb2344fcfa41814ee3ef`，运行归档 `6e7c0615add126604b0db8f83f7aa90e7b4992bf88af90cd4c43c306816290f8`。原生归档/依赖与恢复文件检查见前序 staged 回执。
- 云端 ACTIVE `lookup-round-stop-20261016-deployed.1`，Agent overlay 标识 `lookup-readiness-20261015-rc.14` / `e86d414e8f765194132c2ce9cb30da92a92b5957`；本次没有部署新的业务代码。
- 合并 ACTIVE Agent 清单/overlay 后30文件：29项与实际备份一致；`windows-agent/scripts/小红书数据同步.py` 一项不同，实际备份95307字节、SHA256 `e4ee2e856a41c9346e88c205b99f9faec371fe869752f0c492454016ffd639c5`。原备份该文件静态读取通过，唯一读取期间变化源为agent.log。本次保留实际备份字节，记录发布清单与实物差异，不擅自回滚或夹带本地脚本。
- 原 config SHA256 `ee61ff30debd1b1077a1964ebd3946a0f36d8c4a221777be219890896c865b52`、preload `9c3aa5affb9243f255f2bf74376ee7bb01c9f9171989f5477146263ee7e2bb4d`；保持不变。

## 启用前证据

- 云端只读事务检查：当前 default 状态快照中 queued/running Windows任务、自动化任务均0；无未到期设备锁。规范化历史表有旧记录，不删除，也不把历史行当作当前调度队列。
- 短信库保留 message_id 主键和 `(device_id,message_key)` 唯一约束；旧游标可能造成补读，不能据此宣称最终增量已恢复或所有同步行为已验收。
- 代码核对显示恢复动作依赖新扫描的物理设备集合、当前观察和快照准入；旧恢复状态不直接提供新机端口动作目标，全局PnP扫描仍被策略禁止。保留原恢复数据和暂停/隔离控制，不随意清空历史记录。
- `D:\PhoneCloud-Migration\before-first-start-20261019` 保存原config、data、preload和任务XML的启动前副本，父目录ACL仅SYSTEM/管理员。
- 固定SDK adb.exe 为PE x86，原SYSTEM授权位于SysWOW64路径；两套原私钥/公钥已获单独批准恢复且hash/ACL通过，没有生成授权。
- 原XML以Enabled=false注册为 `PhoneCloud Windows Agent`；Windows Task Scheduler 原生归一化为 SYSTEM / ServiceAccount / Highest，原Node路径、preload参数、Agent入口、工作目录完全一致。任务Disabled、ADB进程0，尚未启动。没有更改原业务启动动作或另建ADB启动入口。

## 接续与回退

再次核对D-075后启用并启动该任务，立即从CIM进程和5037监听核对Agent/ADB均SYSTEM且ADB路径固定。身份不符则停止扩展，不使用Administrator ADB客户端兜底。以Agent实际扫描和云端新鲜心跳确认在线，不以PnP接口数量代替。

遇启动故障，按本次新机启用范围停止/禁用新Agent并保留日志与新状态，先比较再恢复启动前副本；不重建共享ADB、切身份、重启USB/Windows/媒体或覆盖云库。最终增量缺口、真机业务、控屏、自启重启和容量长测仍须如实记录。
