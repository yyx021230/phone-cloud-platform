# 显式单一API-set契约绑定：本地最小候选

状态：**仅本地候选，未执行Windows**。起点15bcb3c8e6a0ce84b1c0ae684baee10ee99054ab，分支codex/wecom-windows-clock-contract-20261102，开始干净。原208旧survey/未知371、b343具体绑定失败、15b的Kernel32导出矩阵及root当前receipt都保留，不改写历史。

## 实际依据与最小差异

本机实际Kernel32解析矩阵仅QueryUnbiasedInterruptTimePrecise失败，其余7名可解析但未调用。Microsoft官方API清单将该函数列在api-ms-win-core-realtime-l1-1-1.dll，10.0.10240起；该页说明动态LoadLibrary使用所列module/API-set名。[官方契约清单](https://learn.microsoft.com/en-us/uwp/win32-and-com/win32-apis)

survey.py是新独立standalone只读源，**只将这一个函数指定到该API-set**，另外7个原函数仍显式Kernel32，原ABI类型/16组配对采样/2秒循环检查保持。两个库都固定System32加载策略use_last_error=True/winmode0x800，按第一次使用各加载一次。没有库名列表试探、替代API、异常后fallback或修改搜索路径；契约加载/导出/签名任一失败立即停止，不到Kernel32再试。

文档依据不是本机API-set可用证明。API-set尚未在本机加载/解析/调用；本候选不能写成Windows兼容修复已实测，更不是生产v1修复。

## 精确读取范围

拟执行仍是既有Administrator SSH，原固定解释器：

```text
D:\PhoneCloud\tools\python39\python.exe -I -B - --observe-contract
```

从后续审定Git对象/哈希取本standalone源经stdin，不上传文件、不创建SYSTEM任务。仅此8函数：GetTickCount64、QueryUnbiasedInterruptTimePrecise、GetSystemTimePreciseAsFileTime、QueryPerformanceCounter、QueryPerformanceFrequency、GetCurrentProcess、GetProcessTimes（自身pseudo-handle）、GetSystemTimeAdjustment。不增加Win32 API，不改时钟/NTP、休眠、权限/密钥、Agent/ADB/USB/媒体或手机。

GetTickCount64为uint64毫秒，UnbiasedPrecise为VOID+uint64指针，wall precise为VOID+两uint32 FILETIME；QPC/QPF为BOOL+int64指针；当前handle为void*；GetProcessTimes仍自身handle/4 FILETIME；adjustment仍2 uint32+BOOL指针。真实Python版本/ctypes位数在绑定前记录，避免失败后缺失元数据。64位数全部字符串，输出仅审计/观察，authority/native/physical flags始终false。

QPC两秒限制只在循环起点检测，不是单次native调用硬中断界。外部采集总等待仍≤15秒，超时远端完成unknown，只关闭自有本地采集，不杀共享进程。2个库固定一次，不自动换库/用户/路径补结果。

## 有限失败诊断

| 字段 | 固定集合/含义 |
| --- | --- |
| failedStage | bind_readonly_apis / read_current_process_times / sample_paired_clocks |
| failedApi | 上述原8个名字，来自固定策略，非异常字符串 |
| failedModule | kernel32.dll / api-ms-win-core-realtime-l1-1-1.dll |
| apiPhase | load_module / resolve_symbol / set_signature / invoke_api / invalid_return |
| errorType | AttributeError / OSError / TypeError / UnexpectedError；不输出raw异常消息或地址 |
| windowsError | ctypes私有last-error整数，只作诊断，0不证明成功 |

ApiFailure保留实际cause对象供本地审查，线上正文只序列化有限字段。若是非API的数据处理异常，status=unconfirmed_observation，只记当时stage与有限type，不猜failedApi。成功raw数值与系统版本、政策映射字段按固定源schema处理，不能把bindingPolicy或布尔自报传进权限。

## 本地验证与下一步

fake DLL对照：旧Kernel32-only查找模拟失败，新固定契约可绑定；准确验证7函数仍Kernel32、仅此函数API-set、恰2库/无fallback且绑定时不调用任何函数。覆盖契约加载失败、符号缺失、非function类型，错误保留API/模块/phase及实际cause；fake完整读取恰16组、失败BOOL精确记录API，所有结果无native许可；实际非Windows拒绝/CLI无模块或fallback开关。均为合成DLL，不证明Windows已成功。

只交具体源/哈希/反例版本供root审，再由统一执行入口决定一次只读采样；本owner不重建并行采集器、不查询Windows、不重跑模型/先前全套。输出须先存bytes/SHA再严格typed parse，失败body保留、不重试，不覆盖原记录。实际样本即使取到也不等于误差/漂移/暂停/SYSTEM/peer/持久恢复合格。

共同流程2026-09-30/SHA0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b及主文档持续阅读；root b880已归档导出与契约方向。旧v1产品入口未动，43/147/52隔离、155查名排除、27912起因未知保持。无推送/上线、无真机验收结论。本候选回退只需停止使用新verification源，无生产回滚动作。
