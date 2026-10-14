# platform-core-20261014-rc.4

本地补丁，未发布。包含rc.3搜索入口保护及rc.2完整合并内容。

130真机复现私有OCR首次读取超时，经通用恢复重启应用并产生第二次号码输入。将OCR调用失败统一归入“结果未确认”，保留原任务，禁止自动重启、重输或XML兜底；不把失败报为未实名，不猜姓名，不扩大原查询时限。成功读取路径保持。

源码复现：`python3 releases/platform-core-20261014-rc.4/verification/prepare-local.py --out /tmp/platform-core-rc4-review`。回退重新组装上一候选，保留请求和冷却数据库，禁止恢复旧数据覆盖新状态。

Windows原生环境仍缺，双机及自然到期继续单独记录；非生产验收。
