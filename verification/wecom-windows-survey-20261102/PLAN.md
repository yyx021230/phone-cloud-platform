# Windows只读clock/主机调查：待脚本审查后执行

状态：**仅本地计划与脚本，尚未执行Windows调查**。延续人类空闲主号/分身发送前真机验收目标；先把实际API/机器条件和仍缺证据查清。root已完成b4c候选包审并固定3d922b，但没有因此批准生产运行时/真机。本阶段不扩模型、不重复34项或改产品，不将调查本身当授权时钟。

分支 `codex/wecom-windows-survey-plan-20261102`，干净起点`b4c3897b3a0ea9d5d0cba281276b98d64db2452c`。主文档持续完整读取，最新复核增量已核；共同流程2026-09-30/SHA `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。本轮只写本目录及主文档记录。脚本固定hash交root审，当前不调用任何远端连接。

## 两个精确脚本

| 脚本 | 拟执行上下文/调用 | 读取范围与成本 |
| --- | --- | --- |
| windows_metadata.ps1 | 既有Administrator SSH，PowerShell `-NoLogo -NoProfile -NonInteractive -EncodedCommand`，编码仅此固定脚本，不含凭据 | 2个本地Get-CimInstance：OS Version/BuildNumber/OSArchitecture/LastBootUpTime，ComputerSystem Manufacturer/Model/HypervisorPresent/NumberOfLogicalProcessors；只读当前token是否SYSTEM，不输出SID/用户名/机器名/序列号 |
| windows_clock_survey.py | 同一SSH用户，现有固定`D:\PhoneCloud\tools\python39\python.exe -I -B - --observe`，固定脚本经stdin，不在服务器保存脚本 | ctypes从System32加载Kernel32，只调用下表读API；16组连续采样，无Sleep/系统休眠，QPC外层超过2秒则停止加样；打印一次ASCII JSON，不创建文件/子进程/网络连接 |

不经Agent/计划任务或新SYSTEM入口；不是SYSTEM运行兼容性验收。Kernel32读时钟和自身pseudo-handle的进程时间不需要给其他进程增权。GetProcessTimes只读当前Python，官方要求的查询权限由当前进程自身句柄提供；不打开ADB/Agent或其他进程。[GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)

Python直接DLL绑定，避免PowerShell Add-Type/csc可能产生的编译临时文件和额外进程；`-I`隔离PYTHONPATH/用户site，`-B`不写pyc；不导入SDK/业务包。PowerShell只设置自己进程的输出编码/错误与进度显示，不写系统配置。缺API/失败输出unconfirmed/unsupported，不尝试更换二进制、提升用户或回退到另一套时钟。

| Kernel32函数与精确类型 | 目的 |
| --- | --- |
| ULONGLONG GetTickCount64(void) | boot计数，原始毫秒字符串 |
| VOID QueryUnbiasedInterruptTimePrecise(ULONGLONG*) | 工作计数，原始100ns字符串；VOID返回，不误当BOOL |
| VOID GetSystemTimePreciseAsFileTime(FILETIME*) | wall审计，1601起100ns整数，不换成JS浮点 |
| BOOL QueryPerformanceCounter(LONGLONG*) / QueryPerformanceFrequency(LONGLONG*) | 夹取实际读耗时的诊断ticks/frequency，不当全局权威 |
| HANDLE GetCurrentProcess(void) / BOOL GetProcessTimes(HANDLE, FILETIME*, FILETIME*, FILETIME*, FILETIME*) | 当前采样进程PID对应的OS出生FILETIME审计，不补旧任务host |
| BOOL GetSystemTimeAdjustment(DWORD*, DWORD*, BOOL*) | 只读当前periodic adjustment/increment/disabled；不是改NTP，也不能据此判断W32Time状态或得出误差上界 |

DWORD/BOOL明确32位、ULONGLONG/LONGLONG64位、FILETIME两个uint32，避免跨ABI使用本机long宽度。每组QPC包围：wall_before → boot_before → unbiased_work → boot_after → wall_after。16组上限固定，无CLI可改变次数；所有64位值十进制字符串，记录自己的OS版本/指针位数和异常，不输出任何授权许可。

QueryUnbiasedInterruptTimePrecise不计睡眠/休眠、单位100ns，Windows10/Server2016起支持；文档语义不等于当前机器已验证。[官方接口](https://learn.microsoft.com/en-us/windows/win32/api/realtimeapiset/nf-realtimeapiset-queryunbiasedinterrupttimeprecise)

GetTickCount64文档给的是通常10–16ms分辨率，不能当硬误差上界。wall precise用于UTC时间戳，间隔测量另用QPC，不能把UTC精度或QPC频率自动变成3秒证明。[GetTickCount64](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-gettickcount64)、[GetSystemTimePreciseAsFileTime](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemtimepreciseasfiletime)、[QPC说明](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps)

## 允许得出的结论与仍缺证据

可补：实际Windows版本/架构、选定API是否存在及可调用、自身出生原始精度、16次当时读数/实际夹取耗时、当时回退异常、名义计时调整参数、SMBIOS/HypervisorPresent提示。后续可按实际返回确定应实现哪组API，不能永久以“未测”代替调查。

不可推断：HypervisorPresent=true可能也出现在运行Hyper-V/VBS的物理主机，false/型号字符串也不是物理机证明；LastBootUpTime是wall观察，不是稳定boot ID。WMI类确实含上述属性，但不是超管保证。[Win32_ComputerSystem](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-computersystem)

仍需单独依据：云端Linux配对clock与时钟源/VM语义、Windows真实休眠/VM暂停/迁移行为、误差和漂移保守界、跨进程boot/epoch来源、SYSTEM实际child出生与父进程/已连socket peer绑定、持久journal崩溃恢复和PG原子语义。此调查不主动让主机睡眠、调时钟或施加业务负载，不会证明这些条件。所有输出固定authoritySupported/nativeExecutionPermitted=false，不由脚本自报profile/continuity把未刻画主机升级为许可。

## 执行边界与回执（目前未运行）

1. root先审固定两个脚本/hash、命令、权限及输出；如需扩大读取范围重新列清。当前没有执行许可推定。
2. 审后用现有安全SSH，密码仅隐藏stdin；单次metadata、单次Python，无上传文件或新任务入口。本地SSH总等待上限分别15秒；超时只停本线程自有采集，不杀共享业务/ADB/USB/服务，不把超时当生产空闲或手机异常。
3. 只保存白名单JSON和本地源码/hash、开始/结束/传输状态/实际身份类别、失败/未采项；stderr只做有界脱敏分类，不保存凭据或原始环境/业务UI。任何意外写入/新未知进程/权限不符即停，不能借机修复。
4. 回执先区分API支持和权威缺口，再提出具体最小兼容接线供审，不直接替换生产factory。

## v1最小兼容接线待评审点（不实施）

- 保留现v1路由/nonce/原host出生审计/旧义务，43缺失事实不补造；生产任务身份由服务器任务nonce、真实父进程spawn对象、同机精确出生token绑定，不能用跨机wall先后取代因果。
- 新能力必须在任务领取/host ACK持久之前协商并绑定服务端代次；旧客户端/旧义务继续原合同，不把旧锁迁成新可用状态。外部提交字段与API草案不扩展。
- 新注册/close/两帧proof每个动作及持久提交后使用新采样；原始wall仅审计，3秒不放宽。没有可信源/暂停依据时拒绝，不从调查脚本的布尔字段取许可。
- 已连socket peer/PID出生代次、跨重启持久未知和真实PG需另外固定最小diff及反例；本计划没有解决这些，更没有改变27912基线、43/147/52隔离或155查名排除。

本轮没有PowerShell运行时，因此.ps1未在本地解析/执行；仅人工/静态审阅。Python仅AST与非Windows拒绝边界可本地验证，不冒称Win32调用通过。计划提交/annotated draft标签只用于审脚本，非可部署修复；无生产变更或回滚动作。
