# 18:51原八个Kernel32导出观察

root独立复跑2ee4探针7项后统一执行唯一一次查询，避免并行入口。企微owner未发送任何新Windows命令，仅复制root指定本地脱敏BODY/receipt；本地重复collector草稿已核自身hash移至受限临时档，没有合入或远端执行。分支codex/wecom-windows-exports-observed-20261102，干净起点2ee4c71748a9e8d42c7d5f62e025773cd43b205c。

18:51:24北京时间，root使用原2ee4/e6f5源、已审旧bounded22cfe、现有Admin SSH及固定Python命令，102ms/SSH exit0/stderr0、stdout1024字节。按原脚本JSON编码重建本次BODY，恰1024字节且SHA `66cb9b577a9153995af81d02be0c1ec5fa70ccb1dc543cbda8a8b2c0a949f188` 精确匹配传输记录。实际解释器Python3.9.13 final、64位，不再由目录名推版本。scope仍观察，零采样函数调用/native/物理清理许可。

八个原名中只有QueryUnbiasedInterruptTimePrecise在本次指定Kernel32加载下present=false/AttributeError，其余七个present=true；函数指针全部未调用。该事实解释本次调查的绑定阶段失败，但不证明整个Windows缺API、不证明其他API-set不存在，也不是原43原因、ADB退出原因或v1已修。root receipt保留了remoteCommand字段原双斜杠文本的更正说明/旧receipt hash，实际调用为单斜杠、传输和body未变；本owner不覆盖该更正记录。

Microsoft官方UWP API清单列出此函数属于api-ms-win-core-realtime-l1-1-1.dll，Windows10.0.10240起；并说明动态LoadLibrary使用列出的module/API-set名。它与单函数页面列Kernel32的说明不同，结合这台机器实际解析事实，支持后继**显式单一契约绑定**候选：仅此函数指定该API-set，其余7保持Kernel32，不遍历库、不做fallback、不增加API或放宽authority。[官方API契约清单](https://learn.microsoft.com/en-us/uwp/win32-and-com/win32-apis)

API-set在本机能否解析/调用尚未实测；先本地给具体源、精确API/模块/失败stage有限字段、fake-DLL差异反例和固定版本，再审下一次只读采样。当前只归档，不查询Windows或导入产品。208原源/原44c78 receipt、所有旧371记录、43/147/52隔离/155排除及27912来源未知保持，无手机任务、邀请、重载、身份/密钥/时钟/服务变更。
