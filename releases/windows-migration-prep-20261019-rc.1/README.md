# Windows 迁机准备 rc.1

用户明确新电脑还没准备好，先完成迁机包。状态是本地可审阅准备材料，未关旧机、未停止Agent、未恢复密钥、未启用新机、未发布或推送。

开始基线 `5ff339070cc4b77a38eec049069f722d1bb8c0df`，干净工作区；独立分支 `codex/windows-migration-prep-20261019`。实际生产程序来自已验证Windows备份，不从本地企微候选或旧根仓打包部署。生产ACTIVE仍为 `lookup-round-stop-20261016-deployed.1`。

迁机目录：`/Users/yyx/Backups/PhoneCloud/PhoneCloud-Windows-Migration-20261019`。核心与日志、驱动包使用与已验证备份相同的不可变内容；排除未完成云端传输片段。归档、原始任务XML、配置/密钥/主机清单均留仓库外，访问受限；不是加密备份。源Windows还保有原备份；云端数据库备份留在云服务器，不因Windows迁机还原到在线数据库。

## 交付

- [开始说明](README-FIRST.txt)、[切换与回退清单](CUTOVER_RUNBOOK.txt)：新机条件、原生产SYSTEM任务动作、最后状态离机保存、密钥恢复审批边界、禁止双Agent、拓扑重建、逐台验收和回退。
- `tools/windows-migration/verify_bundle.py`：文件hash及归档内部大小/CRC/hash，拒绝路径逃逸、大小写冲突和归档链接。
- `Prepare-NewHost.ps1`：新机管理员只读检查；可选独立暂存仅解D/PhoneCloud，跳过C盘密钥和旧PID锁；不恢复密钥、注册任务、启动Agent/ADB或改全局策略。未在新Windows执行暂存。
- `capture_final_state.py`：须源机、人工确认云端排空、旧Agent已停；核对运行基线和原密钥hash，新增受限config/data完整状态包并校验；不停止进程、不复制密钥。未执行真实停机采集。新data恢复需按完整快照预览，不能盲目叠加保留已删除旧状态。
- `smoke_windows_runtime.py`：新机原D路径上的Node依赖、Python DLL、OCR本地模型推理和中文WinRT OCR；无ADB、Agent启动或手机调用。新机未到位，未运行。

## 实际核验

13项离线测试通过：内容损坏、遗漏/多余文件、路径逃逸、大小写重复、symlink、manifest篡改、运行源码改变/新增、状态变化、拒绝覆盖、旧锁/密钥不采集等。真实包核心25,126、日志101、驱动23项全部读取并校验通过。Python编译与diff检查通过；当前Windows PowerShell原生解析0错误，仅解析，未运行暂存/恢复。自审，无独立审查。

只读原机补录：Windows10 x64 19045、Node24.18.0、Python3.9.13、Airtest1.4.3、Poco1.0.94、中文OCR zh-Hans-CN、SSH/Tailscale服务及网络参考。原OCR venv基址D盘保持；Appium原本禁用且缓存缺失，不作为迁机自动安装目标。原wheel-manifest历史标志不是新机验收结论。旧通用安装/启动脚本会绕过当前preload，不作为迁机入口。

未修改共享ADB/Agent/媒体/控制代码，无需用业务全量测试冒充迁机验证。新机网络、依赖DLL、密钥恢复/任务注册/开机自启、USB映射、业务真机和稳定性均待实际环境；最终状态尚未采集，用户真正关机前必须安排安全收尾与离机增量。旧机内存耗尽问题按用户要求暂停深挖，包不宣称修复它。

回退材料是旧电脑、原备份及最终状态；新机如承接业务，回退前先安全收尾并比较新旧状态，避免旧状态覆盖新结果。详细步骤见切换清单。候选tag `windows-migration-prep-20261019-rc.1` 不代表迁机完成。
