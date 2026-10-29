# 企微三个接口外部调用模拟候选 rc.4

本地模拟验收完成，未推送、未上线。

- 分支：codex/wecom-external-simulation-20261029
- 已验证源码：`7f2eaa9172eb2e07d8e4c078ce5205bdf89fbd7b`
- 开发比较及回退起点：`5acb5f4af13ea6a7edc6760035cade262cd36ba4`（rc.3；不是本轮核实的生产版本）
- 不可变候选标签：`platform-wecom-invitation-20261029-rc.4`（绑定材料提交，源码提交见上）
- 既有rc.1–rc.3及其他工作区不变；两个原有未跟踪依赖链接保留。

## 更新

调用方只用查设备、四字段提交、按taskId查结果三个接口。新增可选无依赖Node客户端、本地HTTP/假Agent/合成Poco完整链路测试及文档；测试目录纳入既有回归入口。平台业务源码、界面、Windows Agent和33项冻结文件未改；上一候选的32项运行文件中仅公开API文档更新。没有业务缺陷修复或数据库迁移。

## 实际验证

Node定向52项、企微Python135项、根check、语法/文档副本/哈希/diff检查通过；计数覆盖重叠，只自审。初次2项端到端在离线夹具初始化处失败，已修正夹具并重跑通过，不改业务同步行为。

6次并行相同提交只有1个任务；155主/分身分别绑定正确槽位；同机互斥；155等待时59独立执行。受理响应丢失后原参数重提找回原ID，服务重启不增加执行；claim回复不明保持0发送。4个合成任务各搜索/保存1次、共3次合成发送点击，真实手机操作/邀请均为0。`unknown`不是送达成功。权限、映射和参数负例均拒绝。详见TEST_RESULTS.json及EXTERNAL_API_EVIDENCE.json。

仅本机loopback、临时JSON数据、假Agent和合成页面；原子进程包装器和真实备注/发送算法参与，Windows原生适配器没有执行。本轮未跑全平台组合回归、真实Postgres、Windows原生、真机或生产验收，不沿用历史全量通过充当本轮实测。

## 给对接开发

`integration-handoff.zip`含简版API文档和client.mjs，不含凭据。先查devices选available=true及返回的槽位，检查capacity；再提交四字段、保存taskId、每2秒GET结果。双开要显式main/clone；同机互斥，最多2个未终态任务。超时重提保持原四字段，未知不得自动重发。正式地址和管理员Token由平台方另行提供；本地候选能力尚未发布。

复现：

```sh
node --test --test-concurrency=1 server/wecom-integration.e2e.test.mjs examples/wecom-integration/client.test.mjs
```

## 材料及开发回退

MANIFEST.json记录已提交源码、8项本轮文件、32项运行源文件和33项冻结文件哈希。candidate-runtime-layer.tar.gz为从Git导出的32文件候选源层；不是完整平台镜像，也不能整包直接覆盖生产。development-rollback-reference.tar.gz为rc.3相同路径的开发参考；不含数据库、Agent data、授权密钥或生产备份，不能充当生产回滚点。对接包中的文件与已提交源码逐项对照。

仅开发环境撤回本轮测试/样例/文档时，按当前文件归属最小撤回，不覆盖其他人改动；rc.3及本轮源码都已提交可查。已有任务、云端及本地发送凭据必须保留，不因开发回退清库或重放未知任务。

没有部署授权。本轮没有生产核对、镜像构建、ADB操作或重载。以后正式上线前必须重新确认实际线上版本/镜像/文件哈希，备份任务库和Agent data，按维护影响取得授权，并在真实媒体宿主机只读执行D-075 verify --live；失败停止，不自动修复。
