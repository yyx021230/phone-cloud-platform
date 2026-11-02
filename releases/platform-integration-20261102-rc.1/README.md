# 三业务集成发布候选

状态：已获用户直接发布及终止在途任务授权；准备中，未激活。

基线ba85a3f保留查名修复和企微物理清理协议，最小补入小红书986d的单采集器c4f0fd8。完整源版本见VERSION.json；XHS导入前后哈希见XHS_IMPORT.json。根check退出0，511项XHS Python通过；其余1908组合/投屏与企微/HTTP/PG验证精确归属先前固定0d代码，未重新冒称新真机通过。

发布由root统一切换，查名字执行云端，企微执行Windows，小红书审查调度。现场实际镜像与源码基线、备份/取消预览、SYSTEM/ADB身份、冻结文件overlay及D075 live必须另记。生产src/screen-stream.mjs与src/serial-adb-health.mjs保持现场原字节，不整树覆盖。配置、授权环境、keys、启动动作、ADB、Windows、媒体均不改。

停止业务不等于物理清理。未决cleanup_pending须保持整机封锁。旧版回退前必须查清全部未决义务；紧急情况先保持业务入口/Agent停止和数据保留，不让不识别义务的旧应用重新接单。真实SYSTEM/三业务线上验收与全池长期状态尚未通过，25完整预览等原未验项保留。
