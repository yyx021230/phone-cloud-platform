# 单台恢复隔离与在线检测解耦 rc.1

**状态：本地候选，未上线、未推送。** 从已核对生产文件的 `lookup-readiness-20261015-rc.8` 组合源码最小叠加；原根仓业务文件不是生产基线。合入此前未上线的 `device-recovery-pause-20261014-rc.1`，三方合并后保留现行查名与小红书逻辑。

- 单台可“暂停自动恢复 / 继续自动恢复”，保持发现和在线上报；只有新鲜 Agent 确认相同修订才显示已生效。
- 同一手机实际发出的恢复命令累计连续3次失败，或一轮状态化动作链耗尽，自动持久隔离。命令返回成功不等于恢复成功；只有既有稳定验证通过才清未隔离失败数。安装器忙、任务占用、未授权、未执行动作不计失败。
- 隔离不因冷却、拔插、自然上线或 Agent 重启自动解除。管理员显式“解除隔离并继续”后重新允许恢复；其他手机不继承该隔离。已启动的 Windows 安装不能取消，仍需自然收尾。
- `adb devices -l` 与在线上报先执行；信息补全、设备清理、原有恢复/后续后台工作使用独立单执行者。后台长期不返回时，后续在线扫描和心跳继续；超时不创建第二个恢复。恢复动作临执行前复核最新扫描、暂停和隔离，不操作刚上线或未授权的手机。
- 不改 ADB 身份/二进制/端口/密钥/预加载/启动入口，不改冻结投屏模块，不改变现有单机 PnP/控屏互斥，仍保留真实安装器忙/未知保护。**这不能解除 Windows 已经堵住的驱动安装队列。**

## 管理接口与持久文件

`POST /api/v1/windows-agents/{agentId}/recovery-control`，仅管理员：

```json
{"adbSerial":"FIXTURE-A","paused":true,"expectedRevision":0,"reason":"等待排查驱动"}
```

解除自动隔离：`paused:false, resetIsolation:true, expectedRevision:<当前修订>`。目标必须属于该 Agent，且其能力与隔离遥测已上报；不允许暂停与清隔离同时提交。失败409先读最新状态，禁止盲目覆盖。新修订携带逐目标 release revision，已执行的解除指令重复随心跳下发也不会解除下一次新故障。

- 云端：`DATA_DIR/device-recovery-controls.json`，schema1，新增可选 `releases`（每个目标最近解除修订）。
- Agent：`data/device-recovery-control.json` 保存已确认控制；新增 `data/device-recovery-isolation.json` 保存失败、隔离及已消费解除修订。
- 不迁移 PostgreSQL。写盘失败不确认解除，保留暂停/隔离；隔离存储损坏保留原文件并阻止自动恢复，在线检测和业务仍可运行。恢复器错误不能用清空文件消除。
- Agent初次启动先同步权威控制；新Agent遇旧云端，停止自动恢复等待协议，发现/在线上报仍继续。旧Agent不支持该功能，管理接口明确拒绝，不伪称设置生效。

## 组装与验证

`python3 releases/adb-recovery-isolation-20261015-rc.1/verification/prepare-local.py --out <全新目录>`

脚本校验本候选及父级 manifest，仅组装源码，不启动服务或连接设备。测试依赖沿用相同 package-lock 的本地依赖，没有升级。实际结果与失败记录见 `verification/RESULTS.json`，冻结对照见 `verification/FROZEN.json`。

模拟使用临时文件、回环HTTP服务和假ADB命令；原生Windows驱动、真实PnP隔离、生产控屏并发和长期稳定性未验。本地通过不能宣称生产验收完成。

发布、回退见 [发布与回滚](RELEASE_NOTES.md)；驱动冲突见 [处理方案](DRIVER_PLAN.md)。所有生产操作留待明确授权。
