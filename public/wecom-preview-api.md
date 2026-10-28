# 企微加微信：发送前预览 API

本轮为**本地候选，未上线**。入口：“用户工作台 → 手机详情 → 自动化 → 企微加微信”。管理员选择此手机的主应用或分身，填写已授权测试号码。此版本只搜索、核对备注并进入邀请确认页，**没有发送添加邀请的能力**。

只开放23、25、43、59、93、145、155、157这8台的固定物理映射。155配置主应用（Android用户0）和已确认的分身（999）；其他7台只配置主应用，不猜测分身用户。155主应用是本候选新增目标，本轮仅模拟通过，未做该槽位真机验收。实际安装、登录及页面在执行时校验；列表里的`available`只表示手机在线且无独占锁，不等于已登录。

## 认证与接口

沿用现有管理员登录返回的Bearer Token，普通用户、第三方查名API Key没有本轮权限。接口前缀：`/api/v1/user/automation`。

| 方法与路径 | 用途 |
|---|---|
| GET `/wecom-preview-devices` | 8台库存映射、默认应用、已配置应用列表及在线/占用状态 |
| POST `/wecom-preview-tasks` | 提交一个客户的发送前预览 |
| GET `/wecom-preview-tasks` | 本管理员最近100条任务，含应用选择和原请求编号 |
| GET `/wecom-preview-tasks/{jobId}` | 原任务状态与结果 |

设备列表包含`deviceId`、`deviceNumber`、默认`appSlot`/`androidUser`、`available`及`appSlots`。例如155的`appSlots`：

```json
[
  {"deviceNumber":"155","appSlot":"main","androidUser":0},
  {"deviceNumber":"155","appSlot":"clone","androidUser":999}
]
```

从列表选择已配置的`appSlot`，不要按品牌推断Android用户。槽位代表手机主应用/分身，不代表在企微里切换登录账户。

## 提交与双开绑定

```json
{
  "deviceId": "adb:<设备列表返回的实际序列号>",
  "appSlot": "clone",
  "phoneNumber": "<已授权测试手机号>",
  "requestId": "wecom-preview-demo-0001"
}
```

| 字段 | 约束 |
|---|---|
| `deviceId` | 列表中的固定物理设备ID |
| `appSlot` | `main`主应用 / `clone`分身，该手机必须已配置此项 |
| `phoneNumber` | 字符串，11位大陆手机号 |
| `requestId` | 8–100位字母、数字、下划线或连字符，同一次操作及重试保持不变 |

不接受`send`、`mode`、`androidUser`、自定义包名或重试次数。兼容旧三字段调用：省略`appSlot`沿用原默认，155分身，其余主应用。新界面始终显式提交。空值、`auto`等无效槽位返回400；未配置分身返回409 `wecom_app_slot_not_configured`，**不会回退主应用**。

服务端把应用选择和Android用户存到job及Windows任务；Agent经stdin交给单次Python子进程。执行前及每次写操作的原租约同时核对物理设备、槽位、Android用户、job、任务、owner及锁。单双开选择器只点已绑定目标；未安装、未登录或身份不一致时停止，不换另一套应用继续。

**同一手机的两套应用共用物理独占锁，必须依次运行**；其他空闲手机可独立执行。仍保留最多2个未终态预览，未扩大并发或设备范围。手机被控屏/其他任务占用时不抢占；已有其他Poco会话时停止，不终止别人的会话。

## 受理、防重与超时

首次受理HTTP201，返回`{reused:false,task:{jobId,...}}`。同管理员、同`requestId`和同设备/号码/应用返回HTTP200及原任务，不重新操作手机；同键换任一参数409 `wecom_request_id_conflict`。防重受现有历史保留期约束，不承诺永久保存。达到2个未终态任务429；忙碌/离线409、白名单外403、鉴权失败401。

POST超时、5xx或响应不完整不能视为未提交。先GET列表按`requestId`找原任务，再GET原`jobId`；重试POST必须保持原请求号及全部参数。页面不会自动重新POST：浏览器会话存储只保留设备/槽位/请求号，不保留手机号或凭据。同手机原任务未确认时，两套应用都禁止再提交；其他手机不受此限制。列表未找到仍保持待核对，不能因此自动新建请求。

未知备注保存、输入/点击异常不自动重查或重复保存。Agent离线后原任务不自动重新入队，保留原任务供状态/超时核对。

## 结果

```json
{
  "task": {
    "jobId": "<原任务ID>",
    "deviceId": "adb:<原设备序列号>",
    "deviceNumber": "155",
    "appSlot": "clone",
    "androidUser": 999,
    "requestId": "wecom-preview-demo-0001",
    "status": "succeeded",
    "result": {
      "status": "ready_before_send",
      "code": "stopped_before_send",
      "invitationSent": false,
      "remarkSaveStatus": "not_needed"
    }
  }
}
```

外层`status`为queued/running/stalled/succeeded/failed/expired，另含创建/更新时间。**只有`result.status=ready_before_send`说明已到发送前**；即使外层执行结束也须检查结果。`result.status=blocked`为保护性停止，`result.code`说明原因。没有“添加成功”的返回值，`invitationSent`始终false。

`remarkSaveStatus`为not_attempted/unknown/confirmed/not_needed。unknown须核对原任务和手机，不能创建新请求重放保存。空白备注名补“测试客户”、空白描述补“接口联调测试”，已有非空及其他字段保留，最多保存一次并回读验证。真实拼图、登录失效、限制和陌生页面停止；不增加自动登录、切号或通知发送。

## Agent兼容与验证边界

领取需声明`wecomPreview=wecom-preview-v2`；旧v1或未声明协议的Agent不能领取新任务，避免丢失应用选择。旧历史无槽位字段的job按已存Android用户解释，不能用新请求改写原目标。新云端与Agent须配套，不能只换网页；本轮不执行生产切换。

Agent专用租约：`GET /api/v1/windows-agents/{agentId}/wecom-preview-tasks/{taskId}/lease`，沿用Agent身份及tasks:read权限。有效响应含`appSlot`与`androidUser`；不能用管理员Token替代，也不接收客户号码。

本地HTTP用模拟Agent验证主/分身提交、同手机互斥、防重、租约、终态和重启续查；浏览器验证入口、选择及两套应用独立记录。Python/Node mock验证参数与槽位不一致时停止。这些不代表新版本双开真机或生产API验收。旧rc.2双机执行器及八机核心证据保留，不作为本次155主应用真机通过的证明。
