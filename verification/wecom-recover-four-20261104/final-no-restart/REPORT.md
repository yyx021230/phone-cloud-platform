# 四台企微恢复回执（不追加重启）

2026-11-04 15:51北京时间复核：23、43、59、155均在线、空闲、可用。新SYSTEM只读双帧proof已实际持久化，原业务task/job与受限备份逐项相同，旧失败维护记录均保留。没有邀请发送、直接删锁或伪改原task成功。四台恢复验收通过，长期观察尚未完成。

## 版本与变更

cloud a733181/rc.9、native单文件f6b8ebd/rc.8、Runtime工具6602d70。当前容器仍50a1fafc，PID3613382，06:24:48.578Z启动；一次早前已授权重载之后没有追加重启。原state/clock/persist保持，双文件运行层与内存逻辑同步；下一启动镜像afb66834/Compose预检仅主服务image差异，未执行up/recreate。Agent15224、ADB31384出生/固定路径/SYSTEM身份及3个原业务入口保持；仅明确获准wecom_preinput_recovery.py热更新。Inspector已关闭，未公开端口，无Debugger/pause。CPS lead_id候选未混入，未推送远端。

正常其他设备查名worker误拦、失败后不能显式重试、Runtime工具别名注入遗漏、重复检查导致3秒超时分别修复。显式重试须同具名管理员、新requestId、retryOf、原指纹和互斥，最多5代；无proof且已签发匹配challenge的invalid可重新核验，旧proof永不续期。所有真实socket open/send保留新鲜SYSTEM/worker/旧producer/peer检查，授权在两帧前及最终核对，原3秒期限、双帧和250ms间隔保持，未知staging仍拒绝，未停止其他测试。

实际失败均保留：首轮Runtime依赖别名错误使23 request_failed；43原生2861.62ms虽生成proof但加启动后过3秒被拒；59一次遇到新staging worker被拒。最终四台原生约1629/2074/1606/2437ms，均由服务端接受新proof后释放。最早演练只验证受理，现完整演练复现旧错误再原地修复并完成lease/challenge/proof，不能把受理或原生ok当生产成功。

## 核验与状态保留

Python企微582通过、维护服务67通过、screen69通过、root check通过；Node22隔离无网络/只读/非特权完整证明演练通过。生产health/ready200、PG/Redis正常；真实媒体宿主D-075 live通过，PID2503525、自定义binary、8Mbps/2包保持。

查名配置rev187和51台映射保持，原4条非终态请求在实时或历史结果表中，原9会话记录存在。此前8条已确定账号currentAccount/savedAccounts保持，部分accountQueryStarted随正常进展变化，原116从starting补齐账号。最终9个当前channel及完整账号/冷却/请求/占用受限快照SHA c9e64657。没有关闭pool或恢复旧快照覆盖进展。不能声称早前一次重载前后所有热channel相同或零重探，旧8条结束原因未全归因。

最终只读核对工具曾因库存字段名、活动窗口遗漏归档而断言失败；改用编号和原session/request主键、历史表后通过，不误报生产丢失。原件和客户数据仅留受限远端，不入仓。

## 回退与边界

远端/opt/phone-cloud-staging/wecom-recover-four-20261104-rc.1、rc.4、rc.6、rc.9保留各阶段原件、运行层备份、镜像及受限查名快照；rc.4/rollback-runtime.tar.gz是原cloud双文件。Windows staging/wecom-recover-four-20261104-rc.2保留各版native。进程内保留最初方法回退点，回退须无企微mutation且身份/source匹配，保留当前state/clock和已恢复结果，不恢复旧数据库。不得重启Agent/ADB或切身份；如需切容器仍须另获维护授权。

本回执只证明这四台清理恢复，不等于正式企微/CPS API、分身、真实添加或全系统永久无故障。没有创建额外监控或外发消息。
