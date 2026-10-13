# 查名按设备独立提交：本地rc.3补丁

用户要求“查到哪个，哪个返回”。本补丁修复审查F1，替换整轮调度事务：一台手机的结果、停止或派发使用独立短事务；它的回滚不会撤销其他手机已提交的姓名。对外仍按原lookupId获取结果，单个结果提交成功即可读取，不等待其他手机结束。

来源：不可变异步rc.1完整基线＋SDK rc.2覆盖＋本rc.3两份云端文件。版本、基线hash、精确覆盖清单见VERSION.json；不能把本目录当完整源码或整仓部署。rc.1/rc.2及历史回执不变，源码未推送、未上线。

## 行为与边界

- 离线空闲手机暂缓回收，保留原预约；设备异常仅回滚本机事务，本次调度跳过故障设备并报告错误。
- 结果一条一条提交，后续新任务也逐条准入。每次事务重新核对最多5个自动执行名额，原owner锁、generation、持久化后才允许领取、同机互斥与原键/别名保持。
- 存储或owner故障停止新派发；已经成功提交的其他结果保持。平台适配器持久化失败单独标识，不伪装为可跳过的手机故障。
- 没有状态变化的普通busy/idle/停止等待不反复写库。仍沿用单业务进程、统一队列和PG状态行短锁；未增加多进程并行写库、未修改真机执行器。
- F2撤权漏检、F3取消/到期成功竞态、F5旧同步推荐仍待修；F4沿用rc.2修复。整体仍不是可发布验收结论。

## 本地复验

`python3 verification/prepare-local.py`只读核验三版manifest；带`--out <新目录>`可组装独立本地测试源码。输出目录必须不存在。准备项目既有Node依赖后，从组装目录运行：

```sh
node --test server/managed-lookup-isolation.test.mjs
npm run check
npm run test:screen
npm run test:smoke
```

PG专项`verification/device-isolation-postgres.mjs`只接受127.0.0.1、独立空数据库`lookup_isolation_fixture`，使用合成数据和测试触发器；不要指向业务库。先创建该临时库，再设置`MANAGED_LOOKUP_TEST_DATABASE_URL`。脚本只执行已有两份managed迁移，不产生新生产迁移。历史PG归档/HTTP验证脚本也要求先对各自临时库执行这两份迁移。

实际验证与测试准备失败均记录在[本轮回执](../../docs/evidence/LOOKUP_DEVICE_ISOLATION_20261013.json)：本地文件存储、独立PostgreSQL、loopback HTTP和模拟Agent，真机查询为0。真实五台、自然触限切号与8小时到期继续待验。

## 回退

两份覆盖文件可按rc.1原hash恢复；SDK rc.2保持。没有schema/config/Agent变化，不删结果/别名/冷却/预约，不重启ADB/媒体。回退会恢复已知F1，因此正式上线仍须在其余缺陷修复及灰度后另行批准，不建议带着该已知缺陷发布。
