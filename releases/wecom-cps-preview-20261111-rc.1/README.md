# 200/202 API 预览准备

分支 `codex/wecom-cps-preview-20261111`，基线 `af9edb63ca1751c56d1b66118f33833db8a042b6`。本轮用户授权启用 200、202，并以已指定测试客户各走一次 API 预览，停在发送邀请前；不是正式邀请或 CPS 业务回调验收。

生产 ACTIVE：`wecom-live-state-repair-20261111-deployed.1`，SHA256 `b033757d557909e0d1c79b7ba375aae2b3efe302edc2c85897ff4244c3d391d5`。主平台 PID 1730700、Agent PID 15224、SYSTEM ADB PID 20016。独立 CPS 桥接为 preview 模式，两成员 bindingVerified=true、enabled=false。两台已释放清理占用。

既有待加载的 Agent 上传补丁仅在 `compactTaskResultForStatus` 内保留 remarkPhoneSet 和严格邀请/限频证明，完整文件从 `dd15cc1f` 到 `8a94d6a5`；其余字节相同。此前真实 200 原生成功而平台失败已确认由这处遗漏导致，不能跳过字段核验宣称通过。

本轮本地增加人工使用的受限 LiveEdit 工具及合成演练，只允许这十行插入；默认 dry-run，不启用 Inspector、不启动任务。取实际函数位置定位模块，拒绝 source drift、非目标改动及重复应用，保留失败回退；不发 pause/resume/breakpoint 命令。新建的无业务副作用 Node 25 与原 Windows Node 24.18.0 独立进程演练通过：零暂停、原 PID、查名样本不变，实际压缩函数的布尔/未知发送/证明正反例通过。第一次 Mac 临时路径规范化、dry-run 产生同 URL 脚本副本的定位问题已修正为真实路径和实际函数 scriptId 后重跑。控屏 53 项、工具语法通过。它不代表生产实际内存补丁通过。

生产 SYSTEM Agent 的 Inspector 启用被 Windows OpenFileMappingW 拒绝（errno 5）。到此停止，无提权、身份切换、启动方式修改或生产 Debugger 操作；Agent 源文件哈希、PID、ADB 和授权路径保持。原入口在 Windows 暂存目录受限备份，已核对 SHA256。不能通过普通管理员连接启用无重载方案，暂不激活此候选。

当前等待一次共享 Agent 维护确认。维护时应先暂停新任务受理、保留查名轮次/账号/冷却/原请求，等实际在途任务安全终结；仅替换已审核 index 并由原 SYSTEM 计划任务加载，不改其 --require/身份/ADB。独立 CPS 接入仅将两成员启用，保持 preview 模式、原账本和原签名；再由公网三方签名方式查设备、逐台提交、查询内部结果、确认清理释放与新 nonce 幂等，无邀请和正式回调。新的真实验收结果及文件回执另记，不拿上述模拟代替。

Windows 暂存：`D:\PhoneCloud\staging\wecom-cps-preview-20261111`，原 index 备份 `index.backup.mjs`，候选 `index.candidate.mjs`。此轮未执行 Agent 替换、两成员启用或真实手机预览。已有不重载指示继续有效；维护窗口待用户答复。
