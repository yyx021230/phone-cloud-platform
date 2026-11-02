# 原八个Kernel32导出定位：本地待审计划

状态：本地脚本候选，**没有新的远端执行授权或操作**。起点b3433e1087a9b8eb553e46c15c4163cc623cb3b3/observed.2，分支codex/wecom-windows-exports-plan-20261102，开始干净。原两调查/补采marker、receipt、208源与原因未知的第一次371字节保持。

实际补采已证明原源在bind_readonly_apis时AttributeError，但没有记录失败函数名；不能据此猜某个接口、改DLL试错或判断整个Windows时钟不可用。最小后继只查八个原名字是否能从同一指定Kernel32解析。

- 只读脚本：windows_exports.py。仍现有Administrator SSH、固定`D:\PhoneCloud\tools\python39\python.exe -I -B - --inspect-exports`，固定审定源码经stdin，不落远端文件。
- DLL仅`ctypes.WinDLL('kernel32.dll', use_last_error=True, winmode=0x800)`，System32搜索策略与208原源一致；不尝试其他DLL/API、不做fallback。未加入GetModuleFileNameW，不读模块路径/地址/其他模块/环境。
- 仅对原8名getattr/callable，顺序固定：GetTickCount64、QueryUnbiasedInterruptTimePrecise、GetSystemTimePreciseAsFileTime、QueryPerformanceCounter、QueryPerformanceFrequency、GetCurrentProcess、GetProcessTimes、GetSystemTimeAdjustment。**不调用返回的任何函数指针，不采样clock。** DLL加载/符号解析本身是Windows加载器读取，不是零OS调用，不能把sampleFunctionsCalled=0说成系统无动作。
- 每行只有固定name、present布尔、errorType有限enum：none/AttributeError/OSError/UnexpectedError；不记录原始异常消息。非callable视为未确认。逐项缺失继续检查剩余原名字，不查其他名字或修改注册。
- 实际解释器版本从sys.version_info的major/minor/micro/releaselevel/serial读取，位数为ctypes.sizeof(c_void_p)*8；不从python39目录名推断版本/架构。不输出sys.version编译路径、环境或任意字符串。
- 任何结果均authoritySupported/nativeExecutionPermitted/physicalCleanupVerified=false。present=true只表示此进程下指定模块可解析的callable，不是调用、精度、暂停、物理机或SYSTEM证明；present=false也不能断言替代API-set不存在。
- 不操作ADB/SDK/手机、服务、调钟、休眠、SYSTEM入口、密钥、配置或原锁。root具体审固定源/hash/命令后，再按审定的一次新只读预算执行；当前不运行Windows。

本地fake-DLL反例验证原8名/零函数调用、指定缺失、OSError、非预期getter错误、非function属性、实际非Windows拒绝及CLI无替代module开关。假库错误与名称全为合成，不当实际Windows缺失结论；不再运行34模型/适配测试。

将来执行须有≤15秒本地总等待、严格小JSON白名单/类型检查、先保存stdout字节/SHA再parse，保留失败body/分支，不自动重试。若超时，远端结束未知，不杀共享进程。新receipt独立且固定source/hash，不能更写旧371或原208事实。

只有在实际导出/解释器数据到手后，才提出具体绑定差异/最小兼容接线；本脚本不是该修复。现v1入口、43/147/52隔离、155查名排除与27912来源未知不变。共同流程2026-09-30/SHA0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b，主文档持续完整阅读；完成固定本地commit/annotated draft标签供审，不推送或上线。
