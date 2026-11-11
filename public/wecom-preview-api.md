# 企微加微信：平台内部兼容 API

**其他系统开发请直接看[简版系统对接接口](wecom-integration-api.md)。** 先获取设备在线／占用列表，再提交手机编号、主应用／分身、好友手机号和备注，取得任务号后查询；下文的ADB ID、requestId和模式是旧平台内部接口，集成方不必传。

本轮为**本地候选，未上线**。入口：手机详情 → 自动化 → 企微加微信。管理员选择主应用／分身、客户手机号、备注名和描述，再选择执行方式。默认 `preview` 只到发送前；显式 `send` 会填写备注、保存回读后发送一次邀请。

范围仍为23、25、43、59、93、145、155、157这8台；155配置主应用Android用户0、分身999，其余只配置主应用0。槽位对应已配置应用，不是自动切换企微登录账号。未配置分身返回409，不回退主应用。列表的available只表示在线且无锁，不证明已登录。登录、验证、限制和陌生页面会停止。

## 接口与认证

沿用平台管理员Bearer Token及同源保护，普通用户和查名API Key无权限。前缀 `/api/v1/user/automation`；兼容历史路径名，不代表只支持预览。

| 方法与路径 | 用途 |
|---|---|
| GET `/wecom-preview-devices` | 固定设备、已配置appSlots及available；modes为preview/send |
| POST `/wecom-preview-tasks` | 创建一次预览或单次邀请任务 |
| GET `/wecom-preview-tasks` | 当前管理员最近100条任务 |
| GET `/wecom-preview-tasks/{jobId}` | 原任务状态，超时后用原ID续查 |

独立旧页面 `/wecom-preview.html` 仍只创建预览；完整发送入口在自动化任务模块。当前并发仍最多2条未终态任务，同一物理手机的主应用和分身共用独占锁，必须依次运行，不抢控屏或其他任务。

## 提交参数

```json
{
  "deviceId": "adb:<设备列表中的序列号>",
  "appSlot": "clone",
  "phoneNumber": "<已授权客户手机号>",
  "remarkName": "yyx（坦克）",
  "description": "接口联调测试",
  "mode": "send",
  "requestId": "wecom-invitation-demo-0001"
}
```

| 字段 | 约束 |
|---|---|
| deviceId | 设备列表中的固定ID |
| appSlot | main／clone；省略兼容原默认：155分身，其余主应用 |
| phoneNumber | 11位大陆手机号字符串 |
| remarkName | 可选；最多20个Unicode码点；空白使用“测试客户” |
| description | 可选；最多120个Unicode码点，可多行；空白使用“接口联调测试” |
| mode | preview／send；省略为preview，未知值或null返回400 |
| requestId | 8–100位字母、数字、下划线、连字符；重试保留原值 |

首尾空白去除，描述CRLF／CR统一LF；非法类型、控制字符、超长值入队前拒绝。20／120是平台限制，不是企微官方规格。不接受send布尔开关、任意Android用户、包名、密钥路径或重试次数。

`preview` 沿用原行为：备注名与描述仅补空白，已有值保留。`send` 中备注名按表单规范化值精确更新，**包含覆盖非空备注名**；描述仅补空白，已有描述、企业和电话号码等其他资料保留。空白备注会使用“测试客户”，界面明确展示此行为。最多保存一次，保存后重新打开并稳定读取一致才能继续；未知保存、错号或其他字段变化立即停止。

## 防重、超时与结果

首次受理201，返回 `{reused:false,task:{...}}`。同管理员、同requestId、同设备／号码／槽位／mode／规范化备注和描述返回200及原任务。任一参数不同409。提交超时、5xx、响应不完整均先用原requestId查列表、再GET原jobId；不要换请求号重新发。浏览器只保存设备、槽位、mode和请求号，不存客户号码或备注正文。未知受理时阻止这台手机两套应用重复提交，其他手机可继续。

发送前先写Agent本地收件目标凭据，再向云端申请一次性send-claim。只有云端持久化成功并明确返回、原租约和同一页面仍有效，才调用一次原生发送元素。凭据申请超时、点击超时、断线、取消、清理失败或Agent重启都不重放。云端已claim的同一物理设备／Android用户／手机号，即使换requestId也409；主应用与分身是不同发送账户。云端防重受现有历史保留期约束；Agent本地SHA-256目标凭据跨任务与重启保留，无自动清除入口。迁机须保留 `windows-agent/data/wecom-send-claims`，不能删除凭据后用重发验收。

云端claim响应丢失可能造成“实际未点击但已隔离”的保守停止；这时必须核对，不能自动解锁。运行期间不切换同槽位登录账户；目前没有稳定企微账号ID绑定，不把槽位当永久账号身份。发送成功、对端送达、对端接受是三个不同事实。

```json
{
  "task": {
    "jobId": "<原任务ID>",
    "deviceId": "adb:<原设备序列号>",
    "deviceNumber": "155",
    "appSlot": "clone",
    "androidUser": 999,
    "mode": "send",
    "requestId": "wecom-invitation-demo-0001",
    "status": "succeeded",
    "result": {
      "status": "send_attempted",
      "code": "invitation_click_issued_delivery_unknown",
      "invitationSent": null,
      "sendStatus": "unknown",
      "sendClaimed": true,
      "remarkSaveStatus": "confirmed"
    }
  }
}
```

| 结果字段 | 含义 |
|---|---|
| 外层status | queued／running／stalled／succeeded／failed／expired；succeeded仅表示执行器完成，不证明送达 |
| result.status | ready_before_send预览完成；send_attempted单次发送调用完成；blocked保护性停止 |
| sendStatus | not_attempted未取得云端发送凭据；unknown云端／本地凭据或发送尝试存在不确定性，需核对，不重发 |
| invitationSent | false未进入发送步骤；null发送结果未知；本版不返回true，不能凭点击冒充已送达 |
| sendClaimed | 是否已记录云端发送凭据；即使没有终态上报也保留 |
| remarkSaveStatus | not_attempted／unknown／confirmed／not_needed |

目标已经添加时，保持现有合同：外层`failed`、`result.status=blocked`、`result.code=already_contact`，未发送邀请；不再填备注或重复添加。这不同于`ready_before_send`，不能当成可发送许可。2026-11-02候选补充“客户详情”页面的严格同号码识别，本地文档不表示生产已经加载。

Agent本地凭据先成功、云端凭据未成功或响应丢失时会保护性失败并保留unknown；以原任务code为准，不能因sendClaimed=false换请求重试。云端收到本地unknown终态后同样阻止该目标换键重发。当前没有自动对端送达或联系人接受确认接口，历史用户直接确认不等于自动识别已实现。需要人工验证时不自动登录、切号或跳过。

## 固定错误码与阶段诊断

2026-10-30本地候选在`task.result.execution`附加经过白名单过滤的执行阶段、累计耗时和本执行器清理回执。外部简版GET对应顶层`execution`，字段／错误码含义见[执行诊断](wecom-integration-api.md#可选执行诊断2026-10-30本地候选)。旧记录没有阶段数据，不回填推断值。终态上报前的记录仅经子进程私有管道保存，不承诺实时推送。错误码与阶段不能解除未知发送／保存隔离，不自动重放。

## Agent配套、发布与回退

2026-11-02本地清理候选：业务终态与手机可用性分开。任务失败或取消后若清理仍未确认，同一物理手机所有槽位保持占用，新任务返回409 `wecom_cleanup_pending`；请查询原任务和设备列表，选择其他可用手机，不换requestId绕过。清理确认后才重新接单，未知发送／保存状态仍保留原防重规则。设备显示“需单机维护”时，不代表正在自动无限重试。该行为须配套云端和Agent一起验收，当前未发布。

领取必须声明 `wecomPreview=wecom-invitation-v4`，旧v1/v2/v3不能领取；旧历史任务缺mode仍按preview处理。新云端／Agent／Python／页面必须配套，旧回滚版本不能执行send任务，禁止把send改成preview后重放。

Agent内部只读租约：GET `/api/v1/windows-agents/{agentId}/wecom-preview-tasks/{taskId}/lease`，需Agent身份及tasks:read。响应绑定任务、物理设备、Android用户、槽位、mode、原owner/锁、remarkFingerprint和operationFingerprint。后者为SHA-256，对紧凑UTF-8 JSON `[mode,remarkFingerprint,phoneNumber,deviceId,androidUser]`计算。执行器每次写及发送前重新校验，不把凭据、号码或备注正文放argv或事件。

Agent内部单次发送凭据：POST 同一路径末尾 `/send-claim`，空JSON对象，需tasks:write及有效send租约。首次201含claimed/taskId/operationFingerprint；再次调用409，**不是可重放令牌**。存储失败或失锁不给发送许可。

2026-10-30初始候选只做本地HTTP／假Agent／合成Poco与故障模拟；11月2日开始使用空闲真机的独立staging预览，未加载共享Agent或发送邀请，实际结果见项目主文档。历史23和59单次邀请获对端确认，仍不是当前候选完整发送版本的验收。正式发布前另行核对生产基线、备份、D-075和维护范围，单机→双机验证。
