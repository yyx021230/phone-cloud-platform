# 查名字：完整可运行示例

把同目录的 **lookup.mjs** 给对接开发即可。Node.js 18 或以上，无需安装依赖，单个文件包含所有代码。

## 你们只需要这样用

1. 用平台给你们分配的 **Client ID 和 Client Secret** 配置环境变量 `CLIENT_ID`、`CLIENT_SECRET`。这两个是接口凭据，**不是平台管理员账号密码**。
2. 执行下面命令，把“手机号”换成已授权查询的实际号码：

```bash
node lookup.mjs 手机号 order-001
```

`order-001` 是你们自己的业务编号，例如订单号；同一笔查询重试时保持不变。另一笔业务使用另一个编号。

服务器默认是 `http://47.98.127.132`，不需要填手机编号。也不需要自己选账号、切号或处理冷却。

如果不知道如何设置环境变量，在 Mac/Linux 终端先输入 `bash`，然后执行下列命令。凭据通过输入提示填写，不写进代码或命令历史：

```bash
read -r -p '请输入 Client ID: ' CLIENT_ID
read -r -s -p '请输入 Client Secret: ' CLIENT_SECRET
echo
export CLIENT_ID CLIENT_SECRET
node lookup.mjs 手机号 order-001
```

Windows 或服务器应用同样通过进程环境变量配置 `CLIENT_ID`、`CLIENT_SECRET`，再运行相同的 Node 命令。

## 程序自动做什么

```text
启动准备 POST /api/v1/open/name-lookups/prepare  正文：{}
  ↓ 返回 ready: true、status: "ready" 后
提交号码 POST /api/v1/open/name-lookups/tasks    正文：{"phoneNumber":"实际手机号"}
  ↓ 保存返回的 lookupId
获取结果 GET /api/v1/open/name-lookups/tasks/{lookupId}
  ↓ 每5秒查询一次，直到 completed
拿到 name
```

签名也已经写好，不需要手动计算。启动接口在准备期间使用同一个幂等键反复调用。外部不用关心准备好的手机数量。

查询完成，有名字时输出：

```json
{"status":"completed","lookupId":"查询编号","name":"**某"}
```

没有姓名（包括未实名）时输出：

```json
{"status":"completed","lookupId":"查询编号","name":""}
```

姓名以实际页面可获取的显示值为准，可能带星号。你们业务系统在 `status === "completed"` 时读取 `name` 即可。

## 两分钟还没查完怎么办

默认一次运行等120秒。超过后输出 `pending` 并以退出码2结束：

```json
{"status":"pending","lookupId":"原查询编号"}
```

如果还没提交成功，`pending` 中可能没有 `lookupId`。这只是本次等待结束；**不能当成没名字**。

再次执行**同一条命令**即可继续原任务：

```bash
node lookup.mjs 手机号 order-001
```

程序把幂等键和查询编号保存到当前目录下的 `.lookup-state/order-001.json`。已有查询编号时直接获取结果；提交响应丢失时使用原幂等键重试。不要删状态文件，也不要为了重试换业务编号。已完成业务重跑仍然读取原任务，不自动创建一笔新业务。

需要一次多等一会，可设置 `WAIT_SECONDS=600`，即10分钟。正式系统把这些状态存进自己的业务数据库；容器部署须把状态目录设成持久卷，可用 `LOOKUP_STATE_DIR` 指定。多进程/多服务器使用数据库唯一业务编号与原子状态更新；此示例的文件锁只覆盖同一状态目录。进程被强制结束留下 `.lock` 时，确认旧进程已结束后只删除 `.lock`，保留 `.json`。

接口错误、网络错误、执行失败不会转换成空字符串。退出码0表示得到完成结果，1表示需排查的错误，2表示尚未得到结果。运行进度输出到 stderr，最终 JSON 输出到 stdout，便于程序接收。

## 一次提交10个、20个怎么做

每个号码调用一次提交接口，不传手机编号；不同业务编号可以并行运行这个示例。平台默认最多接收20条未完成业务，内部最多5台执行，其余排队；收到429时程序等待重试，不新建另一笔业务。每个号码完成后独立返回，不用等整批结束。实际接收额度以客户配置和接口响应为准。

## 本轮交付边界

依据2026-10-16已发布三接口契约编写；只新增本地示例，没有修改或部署线上服务，没有调用真实手机号或操作设备。
本地验证：`node --test lookup.test.mjs`，含签名、完整流程、空姓名、断线重试、模拟120秒续查、429/503、准备过期、失败处理，以及真实本地HTTP子进程落盘和重启续查。
