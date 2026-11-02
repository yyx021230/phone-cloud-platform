# 外部API机型覆盖与当前阻塞（2026-11-02）

状态：只读矩阵完成，发送前真机外部全流程未完成。数据读取于北京时间16:46:09，来自平台已上报缓存，不是本轮现取OS型号/系统。

用户本轮确认仍只到发送邀请前。一次正常登录用于鉴权（会产生预期session/audit）；其余9个认证业务请求全为GET，另6个匿名GET。没有新建手机任务、填写备注、发送邀请、调用Windows/ADB或变更锁/配置。

## 已配置企微设备

| 编号 | 品牌/机型 | Android | 槽位 | 平台当时可用 | 本轮排除/限制 |
|---|---|---|---|---|---|
| 23 | Redmi 220233L2C | 11 | main | 是 | 目录空闲；原生测试仍冻结 |
| 25 | Redmi 220233L2C | 11 | main | 是 | 目录空闲；原生测试仍冻结 |
| 43 | vivo V2442A | 14 | main | 否 | 企微清理待确认 · 需单机维护 |
| 59 | vivo V2357A | 14 | main | 是 | 目录空闲；原生测试仍冻结 |
| 93 | vivo V2357A | 14 | main | 否 | 实时控制 |
| 145 | HUAWEI TAS_AN00 | 12 | main | 是 | 目录空闲；原生测试仍冻结 |
| 155 | vivo V2442A | 14 | main/clone | 是 | 查名启用池，排除 |
| 157 | vivo V2442A | 14 | main | 是 | 查名启用池，排除 |

共8台/9槽位/4种机型与系统组合；当前不重叠查名且平台空闲只有23、25、59、145，仍不是可绕过native冻结的执行许可。第四组vivo V2442A当前3台均被维护或查名范围排除。没有为了凑覆盖抢占93控屏、启用查名池或清43旧义务。

## 全平台覆盖差距

平台目录141台、在线126台；按品牌/model/Android缓存字段分44组，其中部分字段缺失或同型号有不同系统，不能当作44种已经确证的独立物理机型。企微配置只覆盖其中4组，其余不自动加白名单。

| 品牌 | model | Android | 登记 | 在线 | 企微配置 |
|---|---|---|---|---|---|
| 未上报 | 未上报 | 未上报 | 1 | 0 | 0 |
| 未上报 | 24115RA8EC | 未上报 | 1 | 1 | 0 |
| 未上报 | ANN_AN00 | 未上报 | 1 | 1 | 0 |
| 未上报 | CRT_AN00 | 未上报 | 1 | 0 | 0 |
| 未上报 | FNE_AN00 | 未上报 | 1 | 1 | 0 |
| 未上报 | M2006C3LC | 未上报 | 1 | 1 | 0 |
| 未上报 | M2012K11AC | 未上报 | 2 | 1 | 0 |
| 未上报 | PJY110 | 未上报 | 1 | 1 | 0 |
| 未上报 | PKA110 | 未上报 | 1 | 1 | 0 |
| HONOR | ANN_AN00 | 15 | 1 | 1 | 0 |
| HONOR | KKG_AN00 | 10 | 1 | 1 | 0 |
| HONOR | KOZ_AL00 | 10 | 1 | 1 | 0 |
| HONOR | LLY_AN00 | 14 | 1 | 1 | 0 |
| HONOR | NIC_AN00 | 15 | 1 | 1 | 0 |
| HONOR | TNNH_AN00 | 10 | 1 | 1 | 0 |
| HUAWEI | ANA_AN00 | 12 | 1 | 1 | 0 |
| HUAWEI | DVC_AN20 | 10 | 1 | 1 | 0 |
| HUAWEI | STG_AL00 | 12 | 1 | 1 | 0 |
| HUAWEI | TAS_AN00 | 12 | 1 | 1 | 1 |
| OPPO | PDYM20 | 12 | 2 | 2 | 0 |
| OPPO | PECM20 | 12 | 1 | 1 | 0 |
| OPPO | PECM30 | 12 | 2 | 2 | 0 |
| OPPO | PFJM10 | 13 | 1 | 1 | 0 |
| OPPO | PHJ110 | 13 | 3 | 3 | 0 |
| OPPO | PKJ110 | 16 | 1 | 0 | 0 |
| OPPO | PKL110 | 15 | 2 | 2 | 0 |
| OPPO | PMC110 | 16 | 1 | 1 | 0 |
| Redmi | 220233L2C | 11 | 10 | 10 | 2 |
| Redmi | 22041219C | 14 | 1 | 0 | 0 |
| Redmi | 25082RNC1C | 15 | 1 | 1 | 0 |
| Redmi | M2006C3LC | 10 | 2 | 2 | 0 |
| Redmi | M2010J19SC | 10 | 3 | 3 | 0 |
| Redmi | M2010J19SC | 12 | 1 | 1 | 0 |
| Tianyi | TYH651M_02 | 14 | 1 | 1 | 0 |
| Xiaomi | MI_8 | 10 | 1 | 1 | 0 |
| vivo | V2020A | 10 | 3 | 3 | 0 |
| vivo | V2020CA | 10 | 2 | 0 | 0 |
| vivo | V2034A | 10 | 1 | 1 | 0 |
| vivo | V2230A | 13 | 1 | 1 | 0 |
| vivo | V2272A | 13 | 1 | 1 | 0 |
| vivo | V2357A | 14 | 61 | 55 | 2 |
| vivo | V2442A | 14 | 17 | 16 | 3 |
| vivo | V2443A | 15 | 1 | 1 | 0 |
| vivo | V2531A | 16 | 1 | 0 | 0 |

## 实际外部接口验证

| 路径/场景 | 实际HTTP | 范围 |
|---|---|---|
| POST /api/v1/auth/login | 200 | 正常认证，材料和token仅进程内存 |
| GET /api/v1/wecom/devices | 200 | 已有数据只读 |
| GET /api/v1/wecom/devices?onlineOnly=true | 200 | 已有数据只读 |
| GET /api/v1/wecom/devices?onlineOnly=invalid | 400 | 已有数据只读 |
| GET /api/v1/admin/lookup-pool | 200 | 已有数据只读 |
| GET /api/v1/user/automation/wecom-preview-devices | 200 | 已有数据只读 |
| GET /api/v1/user/automation/wecom-preview-tasks | 200 | 已有数据只读 |
| GET /api/v1/wecom/customer-invitations/00000000-0000-4000-8000-000000000000 | 404 | 已有数据只读 |
| GET /api/v1/user/automation/wecom-preview-tasks/7b993763-6364-40fb-9599-2af3bb8d9da3 | 200 | 已有数据只读 |
| GET /api/v1/wecom/customer-invitations/7b993763-6364-40fb-9599-2af3bb8d9da3 | 404 | 已有数据只读 |

匿名设备目录及占位结果ID均401；匿名healthz/readyz及两静态文档200。已认证完整列表/在线过滤200，非法过滤400，不存在send任务404；43内部原preview查询200，但外部send结果路由查询该ID为404。不能用这个404冒充有效send结果200。

当前管理员最新100条企微任务的受限历史页只有43一条失败preview，没有send任务可回查；这不是全租户/全历史不存在发送任务的证明。原43仍failed/wecom_cleanup_host_unconfirmed/remarkSaveStatus=unknown，结果未改写、义务未清。

## 真正阻塞与后续顺序

1. 外部POST始终send，无preview字段；本地按8设备9槽位验证传mode=preview被拒绝，删除字段会生成send模式。没有对生产发该POST。
2. 原生/共享ADB的退出与隐式自启缺口未解决；固定路径本地候选不等于无自启，不能接纳未知新代际或用旧CIM快照恢复测试。
3. 43旧host/close证据缺失仍维护，v2本地时钟模型未上线；不得清锁、补造host/ACK或换新任务重放。
4. 若要保持不发送又走真正外部全流程，需要独立评审并增加外部预览能力；准备本地候选与明确加载授权后，再在已核新鲜身份/资源条件下单台、两台、逐机型执行。当前未实施该能力或部署。

## 文档修订

线上public/wecom-integration-api.md与32c发布文件hash一致，但仍标“本地未上线”，且清理/诊断章节仍用候选措辞。本分支仅本地纠正发布/未验状态、明确外部不支持预览，并纠正already_contact外部响应不含内部sendStatus/invitationSent。保留public新增诊断章节与docs原有差异，不整份覆盖。文案未上传线上。

原生产source32c与ACTIVE a539、3个服务端模块和public文档hash已只读比对；不代表新Windows/媒体/ADB核验。正式证据EXTERNAL_GET_MATRIX.json/PRODUCTION_BASELINE_READ.json；collector白名单和脱敏投影已本地验证，实际声明不超出只读范围。
