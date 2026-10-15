# 真机验收接续（待人工）

当前只完成外部启动准备，不宣称五条业务通过。四个原探测拼图保留，156已真实探测成功。后台观察与提交watch已结束，不留无限轮询或后台加号；平台自己的人工观察器继续工作。

本机测试脚本位于/tmp/pc-combined-release-20261015/partner-real.py，SDK来自已发布rc.13 ZIP，secret只从云容器环境读取；业务fetch强制只允许公网HTTP prepare/tasks/GET。实际调用记录已脱敏，不包含号码/姓名/凭据。

用户完成115/155/162/164拼图并退出实时控制后，先只读observe-api-test.mjs，随后公开prepare原键；17:39:06前同键继续，过期必须按API契约创建新准备轮次，不修改时钟或内部状态。STATE.json在云data/test-receipts/lookup-partner-rc13-20261015，rows目前0；不要重复初始化pool或覆盖state。

ready后batch5一次，对原表index80–84（已授权、尚未用于本轮）五并发提交，保存每个lookupId，121秒后retry-after-timeout换新键，poll取结果。用后台只读task/事件对账执行数，实际两就绪/后补位若没自然出现就写未覆盖，不制造异常。预算最多10条，首次5条没完成不加第二批；一台卡住另一台能继续的证据逐条记录。

临时池45启用115/155/156/162/164、并发5。记录pool-before44用于本轮回退；原连续155/156测试的最终原配置在lookup-natural-handoff-20261015/pool-before.json（disabled/rev43）。全部本线程任务正常排空后CAS恢复原disabled配置并记录新revision，不覆盖别人后续改动、不取消待人工或未知任务。原156旧业务已单独恢复并公网读取空姓名，不能拿它替代新API透明防重验收。
