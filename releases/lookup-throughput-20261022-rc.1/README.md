# lookup-throughput-20261022-rc.1

本地组合候选，**未上线**。父候选 `lookup-admin-20261021-rc.3`；实际生产基线、前后哈希见BASELINE/PRODUCTION_DIFF。保留已有管理员后台、拼图后闭环与worker接续补丁。

新增：队首不能派发时放行后续可执行原单；准备失败按页面/设备分类且本轮有界；探测失败安全释放槽位；新限制页冷启动识别、复用账号列表；人工超时原单安全跨机；21种实际失败截图对应的姓名/未实名/无姓名页面兼容。

完整证据、29条处置、测试限制、维护/回退要求见 [调查与修复](../../docs/LOOKUP_THROUGHPUT_20261022.md)。API契约与并发上限不变，不修改生产结果，不跳过人工验证或冷却。

组装：
```sh
python3 releases/lookup-throughput-20261022-rc.1/verification/prepare-local.py --out /tmp/unique-throughput-candidate
```
先验证父层与17文件before/after，再验证470个范围外哈希。依赖沿用既有锁定版本；不安装或升级。测试结果见 verification/RESULTS.json。原图和个人数据不随包交付。

发布需另行明确授权、最新备份、D-075宿主机只读核验及灰度。组合候选含共享Agent既有改动，不能承诺上线不中断；当前授权只覆盖本地开发与只读调查。ADB、SYSTEM、密钥、USB/驱动、媒体均冻结。不移动旧标签，不推送。回滚沿用发布前实际镜像/组件精确备份；不回退JSON快照修复或删除业务数据。
