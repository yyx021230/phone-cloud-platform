# 188 单机原生探测与新停止证据（2026-11-02，未上线）

固定运行源码 `6b32257284b91d8f69a6319cca555150e0be24b4` / `lookup-reader-root-20261102-rc.3`；Windows 94 个运行文件与既有独立 rc4 staging 逐一匹配，查名 Python 为 `d13f48f5c81acc5e8e74675dc677d720c217c68baf3df4ac0f5165fe216dbdb2`。只有一次限定轮次，180.094 秒；0 正式业务、0 新号码、0 模型调用、0 设置修改或安装。生产版本未切换，共享 Agent、ADB、SYSTEM 未变。

## 边界与实际结果

现有公开 prepare 在池 concurrency=1 时返回 `lookup_preparation_capacity`，首次公开 ready 必须两台。没有为测试修改产品合同：本地池配置为2，但只注册188，测试器/native严格限定一台、实际并发1、controlOnly。22项本地检查覆盖多机/额外号码拒绝、错误证明、缺清理及真实prepare门槛。它们只是测试器负例，不算真机通过。

12:09:01 开始账户准备；81.839秒后成功，继而执行原有探测号码。真实输入一次，7个完整树采样均成功，849–2448ms，其中1帧超过旧2秒预算。12:11:23检测真实拼图；保存截图已逐图确认。没有姓名结果，单机未ready，公开prepare仍ready=false，`probeStopPassed=false`，进程exit1。没有人工后重试或追加第二轮。

随后公开stop返回stopped，新停止task成功；从实际持久化task/session核对taskId、sessionId、generation一致，原准备与停止属于同一会话/代次，session已ended。最终close再次确认cleanupConfirmed=true、workerRemaining=false。独立Windows日志保存两轮各自两包pidof明确不存在、目标Poco forward为0，未用命令返回码或逻辑stopped替代物理证明。

测试器整体验收同时要求readyProof，其`fresh_public_stop_not_proven`拒绝原因在本次人工未ready场景是组合门槛结果，不能解释为实际stop失败。原始回执不改写；独立持久绑定/原生清理复核另列在RESULTS.json。**仅新停止实例得到真机证据，探测和完整业务验收仍未通过。**

## 隔离与回收

执行前新鲜确认188在线、无任务/控屏/通道、已知5个账户冷却均到期；既有技术隔离标记保留。共享SYSTEM身份和固定ADB路径核对通过，读取器5/12有预算。真实独占租约前CAS169→170只临时关闭188 enabled；清理及租约释放后fresh CAS170→171恢复原enabled=true，其他配置不变，不清冷却/技术失败记录。

生产ACTIVE SHA、实际镜像、启动时间和重启计数前后相同，healthy；原运行仍3a266d71/a4db69c8。没有发布、推送、共享服务重载或第二台测试。临时脚本适配中的socket路径错误、日志JSON解码错误属于测试器本地/只读阶段，未触发手机动作，不归为产品故障。

## 台账结论及未覆盖

- L01：本轮188原生正常越过搜索、输入、读取到拼图，未再次出现原RPC超时；2448ms帧说明真实整页成本可超过旧2秒，但不能证明所有历史失响应根因已消除，也没有同条件旧版对照。
- L03：rc.3新stop入口的188正常绑定及真实清理实例通过；51/52/54/154旧retry2占位、永久清理失败仍未验，没有操作这四台。
- L04：共享Agent主循环、outbox、runtime丢失/重载不在测试桥内，继续未验。
- L08：本次没有完成探测姓名、任何业务结果或下一条，不替代native.2的限定两机恢复证据，也不声称生产AI全链通过。

源码与临时harness哈希、原始证据哈希固定在EVIDENCE_HASHES.json；手机号、账号、截图和完整原始事件仅私有保存。版本材料只记录本轮结果，不覆盖旧失败和未验。回退无需生产代码动作；临时enabled隔离已撤回，无待释放测试占用。
