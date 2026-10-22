# rc.2：修复真实手机事件截图的关联

状态：本地修复完成，尚未上线。基于实际生产`lookup-ai-vision-20261022-deployed.1`/源fef7ff8/镜像35cba1db；本轮只改一个云端运行文件`server/managed-lookup-platform.mjs`，不改Agent、ADB、SYSTEM、媒体、依赖、数据库或对外协议。任务分支`codex/lookup-ai-live50-20261022`；用户在50条真机测试中要求停止任务并修复本问题。

## 事实与修正

真实Windows Agent把上传后的evidenceId保存在任务finish事件截图中，而job.result.screenshot及task.result.screenshot可能只保留capturedAt、sizeBytes、mimeType等元数据。rc.1只从job.result取evidenceId，在有真实持久截图时错误进入evidence_missing并按既有空值规则收尾。本轮第14、17条均因此漏名。旧模拟把dataUrl直接放status结果，没覆盖真实事件上传格式，这是原验证的缺口。

rc.2在结果没有evidenceId时，沿用现有jobEvidence精确任务取证入口，匹配结果的截图时间、实际字节数、MIME；候选必须唯一。继续核对原job/task/session/generation/client/phone/query、时间窗口、持久asset与SHA256。不选其他任务/旧截图，不猜多个候选，不改变120秒上限，也不把模型用于探测/拼图/登录/切号。原有直接evidenceId路径保持。

## 验证

- 先加入真实事件格式复现：旧代码失败；修正后26项Adapter专项通过，含7个新增案例，覆盖其他任务/旧时间/不同字节数/MIME/歧义/缺失capture。
- 完整1124项回归通过，根check通过，404个范围外文件哈希未变。
- 普通外部HTTP的隔离模拟按真实Agent先上传finish截图事件、再提交仅元数据status，50条全部触发模型并完成；16姓名/34空，原ID保持、每号一次首次输入/一次观察恢复、同机续查、停止ACK/下轮/重启取结果通过。本次hold201ms，不冒充再次实测2分钟；rc.1实际121秒防重及120009ms超时为继承证据。
- 两张真实故障截图通过当前正式读取器独立诊断调用，分别9.079/10.872秒返回姓名，均与下午结果一致；没有回填或修改生产订单。这是诊断复核，不是修正版上线后的完整验收。
- 本轮未再跑修正版Postgres事件流程；持久化结构/事务未变。未部署、未运行修正版真机完整链路。

## 组装与回退

先按rc.1的prepare-local.py组装精确运行基线，核对BASELINE中的before哈希，再叠加本目录一个运行文件及测试。禁止从根仓旧业务整仓覆盖线上。生产只需在实际35cba1db镜像叠加该文件；构建新镜像、备份和新维护窗口属于后续发布准备，本轮未执行。正式生效需要云端重载；不能复用已经结束的上一维护窗口。

回退目标为当前35cba1db及原Compose/ACTIVE；保留业务数据、不覆盖已完成结果。回退会恢复已知截图缺陷，须明确告知。现有rc.1备份保留；本轮不推送、不修改其他工作区。
