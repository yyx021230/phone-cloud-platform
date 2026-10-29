# 2026-10-29 本地候选真机记录

生产仍 platform-integration-20261028-deployed.1，当前阶段未发布/推送。仅空闲51/52使用本地隔离API和Windows独立staging；164生产querying未抢占。测试借用控屏租约，实际有视频负载，不是纯无视频性能基线；SSH适配的候选task/account-policy不等于生产常驻Agent生命周期。容量准入用合成Agent实际HTTP验收，不能由本次两机证明8台真实容量。

14:12只读核对51/52实际安装Poco版本1.0.0.68，APK SHA256均为ed96af302a803ed8f7696fa5c1267c7b1c7a3a5d4b1ddd457eeb76e0d19b70d9，与SDK文件一致。两机普通shell47/31ms、截图860/547ms；排除当时安装包字节差异，但不证明间歇故障消失。51当时新拼图，立即释放51/52自有租约；用户完成后重新确认空闲取得测试租约。

14:15–14:21实际API链路：51/52账户准备分别105.168/111.387秒成功。52探测39.870秒遇新拼图，停止清理证明成功。51已提交搜索，首次OCR帧读取11.210秒，下一次visual_before的Poco HTTP在2.016秒ReadTimeout；get-state16ms成功，但shell/exec-out1秒诊断均超时，serial限定清理亦未确认。Android本轮记录HANS对Poco UID规则事件及QueryController警告；本轮未读到destroySockets行，不把规则事件直接写成确证的关连接因果，也不把启动旧进程退出当首次崩溃。后续停止补试仍未确认，不能宣称stopped成功。本地轮次已收尾、自有控屏租约均释放、独立native进程0。

本轮0条业务提交，未通过原业务ID最终结果/跨机接续，164未验。记录原始失败而不返回伪造空姓名；真实根因仍包括手机命令通道间歇停滞的待证项。测试没有更改共享ADB/SYSTEM、生产Agent/池/结果/配置，未重启共享服务。

脱敏摘要来自/tmp/pc-metrics-native-20261029的INCIDENT_HTTP_RECEIPT.json及INSTALLED_READER_AUDIT.json；私有截图/事件不进入Git。
