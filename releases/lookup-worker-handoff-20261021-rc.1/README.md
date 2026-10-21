# 执行器恢复失败后的原请求跨机接续

日期：2026-10-21。候选 `lookup-worker-handoff-20261021-rc.1`，本地验证，尚未部署或推送。
分支：`codex/lookup-worker-handoff-20261021`。最终提交由同名 annotated tag 固定。

## 问题与修改

154号的实际查询以 `alipay_lookup_failed` / `poco_query_page_recovery_failed:…` 结束。Agent 已做过一次页面恢复，但云端仅把人工恢复失败和结果未确认归入 `needs_recovery`，于是直接把外部请求终结为 `lookup_execution_failed`。底层 worker/transport 为什么退出仍未确认；本候选修复失败后的接续缺口，不宣称消除设备故障。

仅修改三个云端运行文件：

- `server/automation-center.mjs`：精确识别查名查询的 `alipay_lookup_failed` 与页面恢复耗尽前缀，接入已有恢复分类。普通错误、未结束任务、取消和已确认触限不凭此重放。
- `server/managed-lookup-platform.mjs`：仍须同一个查询的 job 和 Windows task 均已失败，才输出恢复证据；只传固定原因标识，不把原始堆栈传给调度器。
- `server/managed-lookup.mjs`：这类错误已经用尽本机恢复，不再重复本机恢复；等待真实 stop ACK，沿用原 lookupId 交给其他已就绪手机。沿用30秒设备退避、同一请求排除已失败设备、最多3台失败的上限。执行状态未知、人工验证、控屏占用仍按原保护处理。

对外接口、API Key、结果格式、请求幂等、5台并发、账户8小时冷却均不变。不修改 Agent、Python、ADB、SYSTEM、媒体、数据库结构或任何生产数据。原来已经终结的失败请求不会被该补丁自动复活。

## 基线与可复现组装

生产基线为 `lookup-ocr-snapshot-20261021-deployed.1`，组合源 `1ec44cf2bbf15583821f941efe2b711b0ecb455d`，镜像 `sha256:0db4c7eddb1a6ddb4c629882c220e5ee2287640c6520fa26bebf1c890bdf2225`。三个 before 哈希与本线程只读生产证据一致，详见 `BASELINE.json`。必须保留已上线的 JSON 快照恢复；根仓旧业务不是可发布基线。

```sh
python3 releases/lookup-worker-handoff-20261021-rc.1/verification/prepare-local.py --out /tmp/lookup-worker-candidate-new
```

脚本按原候选链组装，叠加已部署 JSON 快照入口后校验 before 哈希，再覆盖本候选 manifest；334个范围外文件哈希须一致。依赖沿用现有已安装版本，不安装或升级。运行测试前在隔离目录接入已有根/Agent依赖。

```sh
npm run check
node --test --test-concurrency=2 screen-client/*.test.mjs server/*.test.mjs scripts/*.test.mjs windows-agent/src/*.test.mjs
node verification/worker-handoff-http.mjs
```

HTTP验证只绑定回环地址，以随机合成 API Key、测试账号、合成号码及5台模拟 Agent 设备执行 prepare、提交20条、查询、stop、再次prepare。支持本机专用空 PostgreSQL 数据库；须先应用原有 managed-lookup/async 两份建表SQL，并保留完整快照列JSON。`MANAGED_LOOKUP_TEST_DATABASE_URL` 只接受127.0.0.1，禁止指向任何生产或共享库。`WORKER_TEST_RETRY_MS=121000` 验证实际超过2分钟再换请求号。

验证结果和夹具调整记录见 `verification/RESULTS.json`。模拟不等同于真机验收。

## 发布与回退

本轮没有上传文件、构建生产镜像、重载服务、恢复历史失败请求或触发手机动作。正式发布需单独授权，并重新只读核对 ACTIVE、源文件/运行镜像/下次启动镜像哈希；若生产已变化，重新合并核对，不能直接覆盖。

上线前备份旧镜像/Compose/三个文件和数据库，按 D-075 在真实媒体宿主机只读验证。云端模块必须重载才生效，若控屏受影响须先说明当次维护范围；无需重载 Agent 或操作 ADB/SYSTEM。先在授权目标观察自然发生的终态失败及同一 lookupId 接续，不人为让共享服务或手机故障。

回退只切回本次升级前已核实的兼容JSON快照镜像及三个云端文件；保留现有业务数据和请求状态，不恢复旧库、不强转JSONB、不回退至历史已知无法启动的镜像。运行中请求需走原安全停止/ACK门槛。历史154号失败不会在发布或回退时被偷偷重查。
