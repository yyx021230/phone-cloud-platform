# ADB未授权真实输出分类候选 rc.10

仅本地候选，未上线/推送。父提交73de8ba87d3f75ff3d9e32da4821b57784b69200 / lookup-throughput-20261028-rc.9；保留所有旧标签。

## 原因和改动

161/172各query+stop共4条历史任务，从DB精确读取result.message，真实输出为独立行`error: device unauthorized.`。原代码只匹配带引号序列号，导致设备未授权未进入设备故障分类；其中2条query最终业务失败。没有证据说明这就是51/52/164首次读取超时根因。

只修改云端lookupFailureDomain的task_failed匹配：执行器前缀必须在消息开头，错误必须是独立完整stderr行；支持quoted serial或无serial、LF/CRLF、可选句点。提示里提到error或kill-server不能单独命中。不改变ADB调用、手机授权、密钥、进程或调度恢复预算。

## 验证与未验

4条原始结果离线重放4/4归device，terminal AI均空。20项正反例覆盖真实输出/换行/嵌入文本，新增停止sync→observe组合证明：仍stopping/cancelling、无释放、无新task。相关126项通过，协作独立120项及4条原记录重放通过；全量及check结果见MANIFEST。

不把设备分类成功称为授权恢复；没有新的手机操作、姓名模型调用、生产API查询、部署、清锁或共享服务修改。完整真机业务恢复仍未通过，保留rc.9未验项。

## 基线和回退

生产比较基线仍platform-integration-20261028-deployed.1 / baca5721214658b46f24c974c9147490b0bafada / 镜像fca45ec32e72b0787e4375fd6812a5ac97d3aebec4b830b6393b03117554b45e；本轮仅只读查询原DB记录，不重新部署。代码回退点rc.9，无数据迁移。正式发布仍需已提交版本、实际生产哈希核对、备份与具体窗口授权；不得拿本候选擅自操作未授权手机。
