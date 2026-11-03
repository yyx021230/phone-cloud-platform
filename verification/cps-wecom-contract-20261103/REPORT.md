# CPS企微三接口本地候选验收

日期：2026-11-03。分支：codex/cps-wecom-contract-impl-20261103。
基线：377aeaf9ecc2a80fd55179e1688217ffd93e0361。
候选标签：cps-wecom-contract-20261103-rc.1（不可变annotated标签，提交从该标签解析）。
状态：仅本地；未推送、未上线、未连接生产／真实手机／CPS。

## 交付

按draft.2修订实现客户下发、向CPS回传结果、全部设备状态查询。源文件SHA256见manifest.json；协议见docs/CPS企微客户对接方案-v0.1.md，内部启用与回滚见docs/CPS企微接口本地候选验收与启用说明.md，公开候选协议为public/cps-wecom-integration-api.md。原始CPS文档SHA256为9035e6c449dc996ed1ff9a9cbeea0e9f1deb75b600ea7833e33d49580cc0cc02，原件与用户Downloads副本未修改。

## 实际验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 根npm run check | 通过 | root-check.txt.gz |
| 根npm run test:screen | 2290通过，0失败，1项独立PG环境条件跳过 | screen-full.txt |
| 独立临时Postgres＋CPS＋真实平台回环HTTP | 34通过、0跳过，补验上述PG项 | postgres-tests.txt |
| npm --prefix windows-agent run check | 676通过、0失败、0跳过 | agent-check.txt |
| 全部Python WeCom单元测试 | 544通过 | wecom-python.txt |
| 新8个模块语法、禁用启动／缺模式／不安全生产上游 | 通过，联网前拒绝 | startup-and-syntax.json |
| 查名／支付宝／媒体保护文件 | 132个SHA256未变 | isolation.json |
| Agent公共入口与基线对比 | 仅新增企微能力参数一行，去除后逐字一致 | isolation.json |

原始日志按原字节保留，部分使用gzip封装以保留原输出空白。数字有重叠，不相加。真实HTTP指本机临时平台服务、模拟Agent及回环CPS接收器，不是真实手机／CPS。

覆盖：公开签名向量、中文／0／false、INT64无损；20码点组合限制；签名／时间戳／nonce拒绝与未来时钟防重；显式成员主号／分身；同线索重复、两分钟后换线索、并发重复、重启及迁机不能绕过逻辑客户发送保护；原POST丢应答只按原请求对账；回调重试和拒绝不重跑；成员限频持久隔离、午夜到期与跨日旧回调保护；未知、登录失效和查无客户不伪报；预览不发送／不回调且不能切同账本发送；文件／PG单协调者、CAS与写入未知时fenced；查询不抢占查名原会话及锁、另一空闲手机可接单。

## 失败记录

新跨业务HTTP反例首次及第二次失败，原因是旧合成清理器的轮询没有新版备注手机号能力，服务按设计拒绝。保留lookup-exclusion.txt.gz、lookup-exclusion-second.txt.gz。测试在创建查名会话前显式执行升级Agent的能力轮询，保留旧Agent拒绝断言，最终JSON及PG两种真实HTTP均通过；未放宽业务门禁。更早的草稿基线测试、开发过程日志及私有WIP备份保存在本机临时证据目录，不替代本候选最终回归。

## 保留与未验项

开始记录23个本任务开发WIP并在新分支继续，没有混入其他未知改动。查名字源码／池配置／返回协议、实时控制、媒体、ADB身份及密钥未修改；本轮没有任何生产命令。所有临时PG进程已按自有cluster目录停止并移除。

未验：新原生结果证明的真机结构、真实成员映射／登录核验、生产PG约束及故障恢复、真实HTTPS入口和双方凭据／回调。CPS仍须确认普通失败及跨日处理、解决完整手机号_线索ID超过20字符的情况。不能以模拟通过宣称生产全量可交付或绝不出错。正式上线须另行准备基于实测生产版本的备份、维护范围与灰度。

回退：先停止桥接接单，保留在途原任务及账本，再按已审核版本回退代码；不删除／回退发送记录、nonce或成员限频，不改state key，不为恢复重放未知任务。当前无需执行生产回滚，因为未部署。
