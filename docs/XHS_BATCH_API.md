# 小红书每日数据同步：批次任务与开放 API

状态：**本地候选 `xhs-batch-20261026-rc.3`，未上线、未启用生产定时任务**。
2026-10-28 候选更新：按用户确认支持公网 HTTP 或 HTTPS 地址，SDK 和批次服务的平台连接都已适配；签名、Nonce 防重放、用户隔离、禁止重定向和提交未知时不重放规则保持。HTTP 不加密传输；本次没有部署或启用定时。2026-10-27 的 100 个槽位/66 台手机名单需在启用前刷新，历史核对见 [启用记录](XHS_BATCH_ENABLEMENT_20261027.md)。

用户已确认：北京时间每天 **02:00** 启动，通过开放 API 查询结果。沿用 D-079 的近 30 天创作者中心外层列表、纯元素采集。

2026-10-26 后续真机验证：正式采集 API 的单机→双机共 3/3 成功、46 篇、全部完整且恢复释放；使用已部署 rc.21。这不是尚未部署 rc.3 的整套批次验收，详见 [真机报告与覆盖边界](XHS_BATCH_REAL_DEVICE_20261026.md)。

## 1. 行为与范围

- 首批准备名单：2026-10-26 的 145 个有效账号绑定槽位中选择 100 个，排除此前确认的 45 个问题槽位。名单在受限部署材料中；生产启用前再次核对设备 ID、app1/app2、小红书 ID，不能仅按可修改的手机名称派发。
- 全部批次共用最多 **5 台物理手机**的并发额度，同机两个槽位串行。通过原 `POST /api/v1/user/automation/xhs-data-tasks` 占用手机和派发 Agent；全平台整合候选使用 rc.4 双遍元素采集器，历史 rc.21 真机结果不能替代整合版本验收。
- 空闲才派发；被占用时等待。默认派发窗口为 **02:00–06:00**（240 分钟，可配置），这是本地候选的等待上限，不是用户要求 03:00 必须结束。窗口结束只跳过还未派发的项，已运行任务继续查询至实际终态。
- 离线、绑定被移除/变更、Agent 不支持采集直接标明跳过；执行失败不自动重跑。暂时排除的 45 个槽位不计入首批 100 个的成功率分母。
- 每日自动批次按北京时间日期去重。服务在当日窗口内重启可补建当天批次；窗口外不补跑历史日期。同一客户端有未完成批次时不再叠加新批次。
- 定时开关初始关闭。开启每日计划和创建手动批次是不同操作；关闭计划只停止以后自动创建批次。`stop` 停止当前批次追加任务，已运行项继续收尾。
- rc.3 的停止请求独立持久化，不等待调度器正在处理的慢 HTTP 请求；响应及结果中的 `stopRequestedAt` 表示请求已保存，计数在调度器下一次检查后更新。已进入提交阶段的单项可能继续完成，不强行取消手机任务。

## 2. 账号身份与数据口径

每个结果返回 `accountName`、`xhsId`、`deviceId`、`deviceName`、`appSlot`、`jobId`、状态与原因。
`identitySource=platform_binding_snapshot` 表示平台在任务创建时保存的绑定身份，**不表示脚本在小红书里重新核验过实际登录账号**。运营须及时维护正确绑定；昵称仅用于展示。

派发时带 `expectedXhsId`，平台在创建任务前进行条件检查，防止检查名单之后账号被换绑。完成后再次核对任务返回的设备、槽位、ID；身份不一致不向客户端输出采集数据。

`data` 原样保留经现有白名单校验的列表数据：

| 字段 | 含义 |
|---|---|
| `window_start_date / window_end_date` | 最近 30 个自然日，北京时间 |
| `complete / stop_reason / captured_at` | 是否读到可靠边界、停止原因、采集时间 |
| `notes[].title / published_date / status_raw` | 标题、发布日期、列表状态 |
| `notes[].list_view_count` | 列表观看数 |
| `notes[].list_like_count / list_comment_count` | 列表点赞数、评论数 |
| `totals` | 本次列表对应指标汇总；有缺失值时该指标为 null |
| `warnings / scrolls` | 数据警告和滑动次数 |

外层列表没有稳定帖子 ID，`notes[].note_id` 保持 `null`，不要将标题或数组下标当帖子 ID。带“万”等单位的数值仍是列表展示的近似值。未获取的收藏、曝光、粉丝等详情字段不会编造。

完整空列表是 `status=succeeded, data.notes=[]`；失败/未执行是 `data=null`；不完整采集可能保留部分 `data`，但 `status=failed`、`data.complete=false`。批次 `complete=true` 仅表示全部选定项都成功且完整，不代表已验证每天 95% 的长期成功率。

## 3. API

前缀 `/api/v1/open/xhs-data`；以下全部需要签名，支持 HTTP 和 HTTPS。客户端只可读写自己的计划和批次。设备/槽位/ID 白名单由受限服务配置管理，接口请求不能任意扩展设备范围。

| 方法 / 路径 | 用途 |
|---|---|
| `GET /schedule` | 查询计划和目标数量 |
| `PUT /schedule` | 保存计划，见下方请求体 |
| `POST /batches` | 手动创建，`{"requestId":"business-20261026-001"}` |
| `GET /batches?offset=0` | 每页 20 个批次摘要 |
| `GET /batches/{runId}?offset=0&limit=10` | 逐账号完整数据，limit 1–20，按 nextOffset 继续 |
| `POST /batches/{runId}/stop` | 空对象；停止未派发项，保留已运行项收尾 |
| `POST /batches/{runId}/items/{itemId}/reconcile` | `{"jobId":"existing-task-id"}`；只关联身份/提交时间吻合的既有任务，不新建采集 |

计划请求体：

```json
{"enabled":true,"time":"02:00","windowMinutes":240,"concurrency":5}
```

手动创建的 `requestId` 是同一客户端内的持久幂等键，8–120 个字母、数字、`_.:-`，`daily:` 前缀保留。响应丢失后使用原 requestId 重查/重发可取得同一批次，不要换新键。不同键与活动批次冲突返回 409。

结果示意（简化）：

```json
{
  "runId":"64位十六进制批次ID",
  "status":"completed",
  "complete":true,
  "counts":{"total":1,"succeeded":1},
  "items":[{
    "itemId":"0","accountName":"示例账号","xhsId":"example_xhs_id",
    "deviceId":"stable-device-id","deviceName":"示例手机","appSlot":"app1",
    "identitySource":"platform_binding_snapshot","jobId":"task-id",
    "status":"succeeded","reason":"",
    "data":{"window_start_date":"2026-09-27","window_end_date":"2026-10-26","complete":true,
      "notes":[{"title":"示例笔记","published_date":"2026-10-25","note_id":null,
        "list_view_count":120,"list_like_count":8,"list_comment_count":2}]}
  }],
  "offset":0,"nextOffset":null
}
```

批次状态：`running / needs_attention / completed`。项目状态：`queued / submitting / running / unknown / succeeded / failed / skipped`。终态后客户端应分页取完，按 `runId + itemId` 保存不可变采样；同账号每天会产生一个新快照。

常见原因：`device_busy_waiting`、`device_offline`、`binding_changed_or_missing`、`xhs_account_binding_changed`、`agent_update_required`、`dispatch_window_expired`、`batch_stopped`、`collection_incomplete`、`job_identity_mismatch`。上游明确错误另带 `errorCode`（如有）。

## 4. 认证和客户端

请求头：`X-Client-Id`、毫秒 Unix 时间 `X-Timestamp`、每次请求唯一 `X-Nonce`、十六进制 `X-Signature`。

签名为 `HMAC-SHA256(secret, canonical)`；canonical 是以下五行以单个换行连接，无末尾换行：

1. 大写 HTTP 方法。
2. 原始请求路径 **含原始查询串**，顺序和编码必须完全一致。
3. X-Timestamp。
4. X-Nonce（16–120 个字母、数字或 `_.:-`）。
5. 原始 UTF-8 请求体的 SHA256 十六进制摘要；GET 使用空字符串摘要。

时间允许 ±5 分钟。Nonce 落 PostgreSQL，服务重启后仍防重放；重复请求使用新 Nonce，但沿用业务 requestId。与旧短信/查名接口“只签 pathname”的规范不同，不能直接复用旧签名函数。

Python 3.9+ 无第三方依赖客户端见 [sdk/xhs_batch_client.py](../sdk/xhs_batch_client.py)。从受限配置/密钥服务读取 `base_url/client_id/secret`，调用 `configure()`、`create_batch(request_id)`、`batches()`、`results(run_id, offset)`。客户端不自动重试 POST、不跟随重定向；不要将密钥、平台密码放入 Web 前端或日志。

地址可以直接填写 `http://你的平台地址`（可带端口，不带 API 路径、用户名、密码或查询参数）。小红书批次使用本节的 HMAC 凭据，与支付宝查名的 API Key 独立；不会因为启用 HTTP 而取消认证。

无需 SDK 的 Python 标准 HTTP 查询示例（仅取已有计划和结果，不创建或启动采集）：

```python
import hashlib, hmac, json, os, time, uuid
from urllib.request import Request, build_opener, HTTPRedirectHandler

BASE_URL = os.environ["XHS_BASE_URL"].rstrip("/")  # http://你的平台地址
CLIENT_ID = os.environ["XHS_CLIENT_ID"]
SECRET = os.environ["XHS_CLIENT_SECRET"]

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def get(path):
    timestamp, nonce = str(int(time.time() * 1000)), str(uuid.uuid4())
    canonical = "\n".join(("GET", path, timestamp, nonce, hashlib.sha256(b"").hexdigest()))
    signature = hmac.new(SECRET.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    request = Request(BASE_URL + path, headers={
        "X-Client-Id": CLIENT_ID, "X-Timestamp": timestamp,
        "X-Nonce": nonce, "X-Signature": signature,
    })
    with build_opener(NoRedirect()).open(request, timeout=40) as response:
        return json.load(response)

print(get("/api/v1/open/xhs-data/schedule"))
print(get("/api/v1/open/xhs-data/batches?offset=0"))
# 从批次列表取 runId，然后逐页读取：
# page = get(f"/api/v1/open/xhs-data/batches/{run_id}?offset=0&limit=10")
# nextOffset 为 null 表示已取完；否则用该值继续，查询参数顺序与签名保持一致。
```

## 5. 实现与故障恢复

独立 Node 服务 `server/xhs-batch/main.mjs`，用专用普通平台用户通过正式 API 工作；一个外部客户端对应一个不同的专用平台用户。它不启动 Agent、ADB，也不复用管理员 Token。

生产只支持 PostgreSQL。新增两个专用表：`phone_cloud_xhs_batch_records`（计划、批次元信息、分开存储的逐账号结果）及 `phone_cloud_xhs_batch_nonces`；避免把这些内容塞入原全量 state 快照。结果不自动删除，部署方需按容量制定后续保留策略；本版只清理过期认证 Nonce。

调度器持有专用数据库连接的 advisory lock，第二实例拒绝启动；连接丢失即停止派发。数据库连接等待上限 5 秒、查询上限 10 秒，健康检查执行真实数据库探测；健康检查不代表已验证平台 API 能力。

每次任务提交前先持久化 intent 和稳定 `clientRequestId`；遇响应丢失或进程在提交中断开，恢复为 `unknown`，继续保留该手机的额度，禁止盲目重放。rc.3 通过任务接口按该引用只读查找原任务，严格核对用户范围、设备、槽位、小红书 ID、引用和提交时间后续查结果，不再 POST。平台只在保留的任务记录中查询；记录已淘汰、多个匹配或身份不符时仍待人工核对，不能保证所有未知提交都可找回。人工 reconcile 仍只关联既有任务。已知 jobId 即使查询超时也不新建任务，超过 30 分钟未终态标记 needs_attention。

派发前只读检查平台 `batchContract`，确认条件绑定、账号快照及提交引用查询均支持；旧版平台返回 `platform_batch_contract_required` 时不提交手机任务。平台新增可选 `clientRequestId` 参数、按引用查询和已有引用拒绝复用，原调用无需传入新参数。该有限历史检查不是永久的单任务幂等协议。

## 6. 本轮基线、验证与发布

- 基线：独立工作区 `codex/xhs-batch-schedule-20261026`，起点 `ccb583737169142c0f3c8f34661513f76c413c6c`；原仓 `codex/sms-notification-library` / `6811aef632eeaaacd6d6ce1effc4afa64bf6d363` 的 240 条既有改动保留。
- 共同流程：2026-09-30，SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。遵循当前用户提供的 AGENTS、D-075 和 ADB 身份冻结；延续 D-079，新增的是批次编排和外部查询契约。
- 2026-10-26 只读线上基线：`server/index.mjs` SHA256 `b42951d9bec95d368dd381a920a18f53329cab53f85ee5056e3a0d3aa3c8f397`；`automation-center.mjs` 为 `76e197e2b01b2f625d068cede5b9b2e4d224598e50531072b8cf9313bb83ecae`。它们不同于旧工作区整文件，**禁止整仓/整文件旧版覆盖生产**。
- [prepare-platform-patch.mjs](../deploy/xhs-batch/prepare-platform-patch.mjs) 只接受上述 hash，生成两个文件的最小补丁：采集账号快照/提交引用公开字段，以及采集路由的 expectedXhsId 条件检查、引用查询与能力声明；检测到线上变化立即停止重新审阅。其他快手、查名、控制及媒体内容逐字保留。
- R2 自审：范围、客户端隔离、条件绑定、持久 intent、重启、未知结果不重发、同机串行/全局五台、停止与回退逐项检查。未委派其他 agent，不冒充独立双人审查。
- rc.2 已完成 17 项批次测试及 10 项既有回归。rc.3 合并回归为 **33/33、0 失败、0 跳过**：含临时真实 PostgreSQL、实际服务进程/重启、Python SDK、隔离平台 HTTP；新增慢提交时停止、丢失响应找回、错误账号拒绝关联、结果落库失败后恢复、旧平台能力拒绝，以及 100 槽位/50 台模拟手机全批次。模拟中峰值为 5 台、同机串行、无重复提交，分页读取全部 100 项；不是 100 个真实手机账号验收。
- 两项缺陷测试在 rc.2 上均先失败（停止被网络阻塞、未知提交不能自动找回），rc.3 通过。根 `npm run check`、新增入口语法和 diff 检查；生产基线补丁范围/反向恢复、六种非采集公开模型核对。没有生产/真机测试，不证明每日 95% 或持续负载 SLA。
- 候选更正：rc.1 最终合并回归为 26/27；真实 HTTP 任务领取日期与旧测试样本 10 月 13 日不一致，日期校验正确拒绝。rc.1 标签保留但不用于发布，rc.2 将该模拟数据日期对齐真实测试任务，并重新完成合并回归；运行代码未为测试放宽日期检查。
- 本地环境：Node 25.9.0、Python 3.9.6、PostgreSQL 16.15。实际合并回归命令为 `XHS_BATCH_TEST_DATABASE_URL=<临时本机测试库> node --test --test-concurrency=1 server/xhs-batch/*.test.mjs server/automation-center.test.mjs server/xhs-data-collection.test.mjs server/xhs-data-collection.http.test.mjs`，rc.2 为 27/27，rc.3 为 33/33。未运行冻结媒体全量回归，Agent/媒体代码无变化。数据库专项未设置测试 URL 时会明确跳过，不可宣称测过 PG。

发布前还须：绑定已提交 tag；复核最新线上 hash 和部署拓扑；创建/确认专用普通账号及 100 项白名单、受限密钥文件；备份目标表和两个云端文件；在授权窗口完成 D-075 live 前置核验、业务任务/控屏排空以及云端两文件加载计划，再进行单机→双机→100 项灰度。涉及云端进程加载，不能宣称完全无中断；不重启 Windows、ADB 或媒体。

用户要求先完善后上线，本轮不执行部署。现有平台未新增全局维护准入门禁；一次查到空闲不能保证随后没有新任务。正式加载云端文件前必须在维护窗口协调暂停新任务/控屏进入并再次核对；不能落实时停止发布，不能用“新服务独立”承诺原平台重载零影响。生产能力检查、真实占用冲突、单机→双机和实际 02:00 调度都仍待正式验收。

`schema.sql` 只新增表/索引，已在临时库执行。`config.example.json`、systemd unit、nginx location 是部署模板，目标路径/服务用户需按实际环境配置；示例占位密钥会被启动校验拒绝。启动命令 `npm run start:xhs-batch`，需显式 `XHS_BATCH_CONFIG_FILE`（0600）、`XHS_BATCH_DATABASE_URL` 和可选 `XHS_BATCH_PORT`（默认 8791、仅 loopback）。由现有 HTTP 或 HTTPS 入口仅代理该 API 前缀，保持批次端口不直接暴露。配置 `platformBaseUrl` 支持 HTTP/HTTPS，容器内回环只代表该容器自身，必须按实际同机/跨容器拓扑设置，不能原样照搬示例端口。

回退：先关闭计划、stop 未派发项，核对并等待既有任务收尾；停止新批次服务、撤回新增代理段；按备份/原镜像恢复云端两个最小补丁。**保留新表和采集结果**，不 drop、不整库覆盖、不删除业务数据；旧平台不依赖新表。启动回退前后均保持 D-075 生产基线。发布/迁移/创建真实计划与首批手机采集仍须具体版本授权。
