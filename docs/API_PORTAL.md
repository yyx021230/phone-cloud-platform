# 全系统 API 文档门户（本地候选）

任务：用户要求第三方系统接入查名字，参考飞书接口文档组织方式梳理全系统 API，并在库存右上角增加入口。状态：**本地候选，未推送、未发布**。风险 R1；不改协议、认证、数据库、Agent、设备操作和冻结链路。

## 阅读入口与范围

- 本地预览：[API 文档](http://127.0.0.1:8796/api-docs.html)。预览只在本机回环地址提供静态文件，不连接业务服务。
- 候选内入口：库存标题右侧 **API 文档** → `/api-docs.html`，新窗口打开；直接地址同样可读。
- 106 个 HTTP 操作、6 个 WebSocket 通道；按第三方开放、用户、管理、内部及兼容接口组织。查名及验证码公开模型为完整字段表；平台任务 `result/payload/health` 等按执行器扩展，通用模型明确标为常用稳定字段，不伪造固定统一结构。
- 每个 HTTP 接口包含方法/路径、身份与 scope、参数类型/必填、成功状态、返回模型、请求/响应示例、路由错误及公共错误链接。支持搜索、代码复制、Node.js/Python/HTTP 切换、目录深链接、窄屏菜单。
- 可下载 `/openapi.json`（OpenAPI 3.1，HTTP 106 操作；WebSocket 在扩展字段中）及 `/api-reference.json`（完整参考数据）。没有交互发送请求功能，不保存用户令牌/密钥。
- 设计结构参考 [飞书获取文件统计接口](https://open.feishu.cn/document/server-docs/docs/drive-v1/file/get)，核对日期 2026-10-10。沿用参数/响应/错误/示例分节；本平台使用实际 HTTP 状态和 `error` 字符串，未虚构飞书式数字错误码。

## 接口基线与版本边界

工作区 `/Users/yyx/.codex/worktrees/lookup-version-management/phone-cloud-platform`；任务分支 `codex/api-documentation-portal`，起点 `08b864e3a070e7a561358897494c6425b154d598`。从不可变 `lookup-20261010-rc.2`（`f017254902ad4262bb036a461df725f8424b0758`）继承已合并的运行快照；**仓根历史运行代码不是该快照，不能从仓根整仓部署**。

候选源码位于 `releases/platform-api-docs-20261010-rc.1`，与 rc.2 相比只修改 `public/index.html`、新增五个静态文档文件。服务端和 Agent 所有文件逐项哈希相同，22 份冻结运行基线保留。此前 rc.2 的测试/生产差异材料作为历史证据保留，本轮测试见候选 `verification/API_DOCS_TEST_RESULTS.json`，不能拿旧回执当本轮执行结果。

开放查名基础协议已发布；自动人工交接、`needs_recovery`、账户冷却可靠性属于当前查名候选，门户反复标注未发布，第三方接入前须核对目标部署。原“自然8小时冷却、再次真实触限/切号/拼图组合、两台真机及长测”等未验收项保留，本轮没有新增真机查询、通知或生产操作。

## 内容维护与验证

人工审阅源：`docs/api-reference-contracts.json`。生成器：`scripts/build-api-docs.py`，从候选 `server/index.mjs` 标准路由分支核对方法/路径、认证、直接参数/辅助函数参数、状态与错误；路由不在人工目录或直接字段缺少说明时停止生成。新增特殊路由写法仍须人工审阅并更新生成器，不能把这项检查当作任意代码的完整语义分析或自动 CI 门禁。

```sh
python3 scripts/build-api-docs.py
node --test scripts/api-docs.test.mjs
```

本轮：专项 8/8；105 组 Node.js 与 105 组 Python 示例只解析、不执行；签名示例与实际服务端函数比对（GET、JSON POST、`{}`）；开放查名字段表与实际序列化逐项一致；OpenAPI 引用/路径参数与 106 操作一致；静态加载只获取参考数据，转义反例通过。浏览器验收桌面 1440、手机 390 宽，无横向页面溢出；搜索/示例切换/复制/手机目录/深链接与库存入口可见性通过。布局预览只使用库存头部，不登录或访问设备，临时预览文件已移除。

按 rc.2 既有方式在临时副本 overlay `verification/fixtures`、`verification/tests`，仅继承环境白名单且不加载业务 `.env`，执行根 `npm run check`、文档 JS 语法、`npm run test:screen`：594/594，无跳过。直接在精简快照目录执行根 check 首次因缺 fixtures 中的脚本而未通过，随后按既有入口补齐隔离验证；并非删除检查。专项测试初轮的插桩匹配/示例字符串计数问题已修正，最终 8/8。未重跑无改动的全部 Agent/Python/SDK 入口，不把既有结果计为本轮。

D-075 检查：管理 worktree 缺少仓根 deploy 校验器；在原工作区只读运行 `node deploy/mediamtx-pacing/verify.mjs --repository` 通过，结果明确 `repository-only/liveVerified=false`。未运行生产 `--live`，不代表媒体宿主机已核验；本轮没有媒体发布。

## 发布与回退边界

本地 Git 提交/不可变 annotated tag 按既有持续授权执行，标签 `platform-api-docs-20261010-rc.1`；未移动 rc.1/rc.2，未推送。后续发布先核对实际线上基线、单独取得授权；文档展示不代表查名新候选已经上线。不部署整个原工作区，不重启媒体/Windows/ADB。

本轮 UI 回退基线为不可变 rc.2：恢复其 `public/index.html`，新静态文档文件按发布记录回退；没有数据库迁移或设备状态修改。生产若只发布文档，必须先把候选文档与实际运行接口差异明确标注，不能将内部协议或候选功能假定为已开放能力。

原工作区既有改动保留；本轮实现只在隔离候选内。原工作区仅同步这份说明、脱敏测试回执和主文档，逐项核对修改前哈希；没有覆盖原 `public` 或业务文件。
