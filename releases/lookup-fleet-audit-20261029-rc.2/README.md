# 精确代表任务补充审计 rc.2

仅只读调查与本地模拟，未部署、未新查手机、未调用模型。本阶段基线`67a16cddbf4aa4030782ad27877f2889eeb5d52d`，分支`codex/lookup-fleet-audit-20261029`，开始工作区干净；风险R0。本补充延续[全48台审计](../lookup-fleet-audit-20261029-rc.1/FLEET_AUDIT.md)，不改写原时点报告、旧commit或tag。共同流程2026-09-30、SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`保持。

## 新核实事实

|手机/精确job|实际证据|结论与限制|
|---|---|---|
|159旧双卡 `d67a59df-3ebf-4b06-b228-54094090b37a`|原audit-159.png SHA256与归档AI证据完全一致；readiness_probe最终failed/lookup_probe_page_unsupported；AI upstreamStatus=502、stage=model_body、1 read、10240ms|原图已正确进入AI，失败发生于上游，不是已记录的双卡几何拒绝；不是业务最终失败样本。候选已有同原图有界502/503/504重试，尚未对该原图做新的真实推理|
|159较新单卡 `9226a22a-867e-4561-91cf-5b3fbd24732b`|原job/evidence AI读2次、34813ms，最终succeeded/hasName=true|这是原任务已恢复的普通单卡，不能拿它冒充旧双卡复测；不能继续算最终失败|
|130 `1810b41e-360d-43c3-bfa1-36008e33d759`；181 `f4edad51-aeff-4361-af2b-c5eff87da4ea`|精确start堆栈均在生产脚本4831，即Back导航返回focus未过Home白名单；稍后错误focus与原截图已为AlipayLogin首页|中间返回focus未记录；null/遮挡/其他activity无法区分。普通首页不证明账户已登录或身份明确，不能宣称两台已修复|
|163 `cea3c477-fc0c-4be1-a1f5-7e616f3dbcd7`|精确start的错误focus和原图均为小红书ChatActivity；之前账户列表稳定事件存在|失败时前台不符已确认，谁/什么切走与当时锁/控屏是否重叠未确认；不指认用户，不向其他应用盲点|

旧159双卡图哈希：`1b6647a873a7458370107e72af653dcd293a2271b66157e1ed5e67dd55ef32b6`。报告与Git不包含原图、姓名/号码/账户、AI租约token或USB序列号；精确事件、原图与完整结果只保留私有证据。

## 候选覆盖与新待验证缺口

已有AI候选保持原图/原结果ID，不重查手机；502/503/504只做有界瞬态重试，最多3次模型读取、共享120秒截止，姓名仍需至少两次一致确认，认证失败等不盲重试。现有离线AI正反例通过，不能推导旧双卡真实模型成功；没有为取证新增模型调用。

本窗口对真实`exit_search_activity_for_account_navigation`函数做隔离模拟：SEARCH→null→HOME序列在一次Mock Back后立即返回null，只读了2帧，第三个Home尚未观察。该行为证明代码对瞬态焦点缺失的处理缺口，**不证明130/181旧现场曾返回null**。回执见[FOCUS_TRANSITION_REPRO.json](FOCUS_TRANSITION_REPRO.json)。未改业务代码；协作窗口在独立下一阶段评估有界只读稳定观察，必须保留具体外部/遮挡立即停止、持续未知失败、原Home/XML/账户/拼图证据、不额外Back/点击/启动的约束，且如实说明新增读取预算。旧单次focus读取默认10秒及既有3秒恢复，轮询2秒不等于整体严格2秒硬上限。

## 实际验证、文件与下一步

- 聚合回执[REPRESENTATIVE_EVENT_REVIEW.json](REPRESENTATIVE_EVENT_REVIEW.json)的8份原数据/原图回执和3份日志SHA256全部复核；旧双卡原图字节哈希与归档匹配。回执的candidateCommit是协作窗口原rc.10，不表示当前已存在新焦点修复。
- 协作窗口模拟导航16项、搜索入口5项、AI相关85项通过；本窗口独立`node --test server/lookup-ai-vision.test.mjs`实际60项通过、无外联（fetch mock），再独立复现旧焦点行为。测试范围有重叠，不能相加为新全量回归；本阶段无运行代码变更，未重复全量回归。
- 新增本目录聚合报告/回执及主文档附记；原审计rc.1和联合候选rc.1保持不变，既有改动保留，无生产回退动作。
- 130/181历史根因、163前台切换归属、旧双卡真实模型/业务恢复、初始RPC/普通命令失效及全池真机/8台吞吐继续未完成。下一步先对新焦点候选做失败复现、边界测试与独立审查，再按明确授权/占用条件考虑真实验收；不放松结果/登录/冷却/清理保护。
