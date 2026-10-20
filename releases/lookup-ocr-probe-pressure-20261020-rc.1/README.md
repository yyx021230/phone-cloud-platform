# 查名识别与探测优化候选

状态：本地测试完成，未上线、未推送。版本 `lookup-ocr-probe-pressure-20261020-rc.1`。

基线为已发布 `lookup-offline-round-stop-20261020-deployed.1`，源码 `59ce44e`，实际云端三文件与 Windows 两脚本哈希已只读核对。候选只包含五份运行文件；不替换整个 Agent，不动 ADB/SYSTEM、投屏、媒体、驱动或凭据。

## 改动

- 精确识别完整充值结果下方“猜你喜欢以下结果”的推荐区；仍要求已探测账号、完整号码匹配、前后台一致和两帧确认。加载、风险/拼图、姓名动作及未知结果区不判空。
- 截图耗尽剩余预算时不再用几毫秒启动OCR并误报引擎超时。已确认终态且视觉预算耗尽或OCR超时，跳过同机再等一轮，stop ACK后保留原lookupId跨机；普通瞬态异常仍只读恢复一次。
- 此类失败手机临时退避5分钟，独立于账号8小时限额冷却；不永久禁用，不清锁，不延长原查询总期限。
- 原机5分钟刷新优先不变；其后优先探测24小时内成功过的空闲手机。历史只作为排序提示，绝不能直接赋予ready；未来时间、过期、占用、掉线、冷却和隔离仍不能绕过。

## 验证

`verification/RESULTS.json` 保存实际结果；932项Node、265项查名Python、163项执行器通过，56项云端专项通过。20条模拟业务遇到三台OCR失败，20条完成、最多5执行、23次业务尝试，无同ID同机重复，候补补到5就绪。

8份已脱敏现场OCR文本，旧版全部拒绝，新版识别；本机原图OCR单帧0.785～2.259秒，不代表Windows原生耗时。未在生产执行任何新号码或手机指令，也没有本轮Windows真机验收。不能承诺支付宝不再出拼图。

## 复现与回退

从本目录执行 `python3 verification/prepare-local.py --out /tmp/pc-lookup-pressure-review`（目标必须不存在），依次校验父候选、before/after哈希与189份范围外文件。使用已安装本地依赖，执行根 `npm run check`、`npm run test:screen`、`python3 -m unittest discover -s windows-agent/scripts -p 'test_lookup*.py'`、`python3 windows-agent/scripts/automation_runners_test.py`。测试环境不得继承生产DB/Redis凭据。

本轮不构建或切换生产镜像。以后发布必须先重新核对ACTIVE、占用和五文件基线，准备旧镜像与Windows两脚本备份并取得本次授权；云端重载、目标空闲查名worker刷新需说明范围，禁止重载共享ADB或改变SYSTEM。回退仅还原本轮五文件/旧云端镜像，保留业务数据与D-075；新增可选JSON时间戳旧版忽略，无数据库结构迁移，不回滚数据库抹掉联调记录。

自审：终态匹配、停止ACK、迟到结果、取消、账户凭证、幂等及5并发门槛继续由原链路约束；只读取证未触发任务领取路由。测试/fixture不发布。没有独立人工审查或生产通过结论。
