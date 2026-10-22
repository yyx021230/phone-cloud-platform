# lookup-throughput-20261022-rc.3

本地候选，未上线。父版本 `lookup-throughput-20261022-rc.2` / `7120363d3c5e9414b4eeaa0a3d5705e719c85732`；保留旧标签及全部既有修复。

修复原查询触限/登录失效/执行器异常/人工等待转交后误用首次排队期限的问题。收到停止确认后沿用原总截止时间，仍保留取消、总超时、迟到结果和不重复执行保护。1个运行文件、1个新测试文件、1个HTTP验证脚本；范围外488个文件hash保持。无数据库迁移、API或默认超时配置变化。

```sh
python3 releases/lookup-throughput-20261022-rc.3/verification/prepare-local.py --out /tmp/unique-rc3-output
```

组装校验父版before/after、范围外及生产差异清单，不安装依赖、不访问生产。验证说明见 [本地复验](../../docs/LOOKUP_INDEPENDENT_VALIDATION_20261022.md)，实际结果见verification/RESULTS.json。合成号码、模拟设备，本机JSON/Postgres，真实Python解析；不是Windows/真机验收。

自审R2：仅确认停止后的原异步请求转换排队预算，不重新生成总期限；主动取消及已到总期限不转交。正式发布仍需最新生产基线、备份、D-075真实宿主机只读核验和维护授权；组合含既有Agent候选，不能将本轮云端小改当作整个组合可无中断上线。沿用父版本回滚材料，不回退数据或JSON快照修复。ADB/SYSTEM/USB/媒体/控屏冻结。
