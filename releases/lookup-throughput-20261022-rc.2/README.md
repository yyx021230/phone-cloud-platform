# lookup-throughput-20261022-rc.2

**本地候选，未上线。** 继承rc.1，不移动旧标签。

独立反例发现结果可能跨相邻卡片借用姓名、手机号或按钮；修复OCR/Poco/XML关联边界，多个人名候选不直接取第一个。新增126个双帧反例、50条队列压力专项，以及真实Python识别结果贯穿HTTP/数据库的50条测试。

详情见 [独立复验](../../docs/LOOKUP_INDEPENDENT_VALIDATION_20261022.md)，计数/失败复现说明/最终脱敏结果见verification/RESULTS.json。两个Python运行文件、两个测试文件、两个验证脚本共6文件覆盖；其余484文件hash保持。

```sh
python3 releases/lookup-throughput-20261022-rc.2/verification/prepare-local.py --out /tmp/unique-rc2-output
```

不安装依赖、不访问生产。模拟设备、离线OCR都不替代Windows原生OCR及真机验收；不能宣称今后不再出现未知页面。发布前仍须具体维护授权、最新组件核对/备份和D-075宿主机只读核验。ADB、SYSTEM、密钥、USB、媒体冻结；沿用rc.1的发布与回退边界，不覆盖数据。
