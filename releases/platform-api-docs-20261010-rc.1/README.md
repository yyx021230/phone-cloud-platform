# 全系统 API 文档候选

不可变候选标签：`platform-api-docs-20261010-rc.2`；任务分支：`codex/api-documentation-portal`。**本地候选，未推送、未部署。**

继承已合并的 `lookup-20261010-rc.2`，只在库存标题右侧增加 API 文档入口，并新增5个静态文档文件；服务端/Agent全文件与rc.2相同。仓根历史业务文件不是本候选，不能整仓覆盖线上。

文档覆盖106 HTTP操作/6 WebSocket通道，重点完整记录第三方查名签名、幂等、排队、结果、人工交接与冷却。可下载OpenAPI 3.1，支持搜索与Node/Python/HTTP示例；页面不调用业务接口或保存凭据。

[版本](VERSION.json) · [说明](RELEASE_NOTES.md) · [目录调整测试](verification/API_NAVIGATION_TEST_RESULTS.json) · [初版测试](verification/API_DOCS_TEST_RESULTS.json) · [哈希](verification/MANIFEST.json) · [维护与验收记录](../../docs/API_PORTAL.md)

本轮专项8项、根语法、594项回归、桌面/窄屏和入口布局验收通过。verification/TEST_RESULTS.json、既有production补丁及其他继承材料是rc.2历史证据，不是本轮执行结果或新文档部署包。

完整隔离复验仍可用原 `verification/verify.py`（参数为已有依赖的原工作区）；新文档专项从工作区根执行 `node --test scripts/api-docs.test.mjs`。发布与真实副作用另需授权，媒体/控制冻结和D-075保持；未实施生产live核验，也未解决或重新验收先前尚未触发的真机组合。

rc.2仅调整3份文档静态文件：按第三方/平台/管理/内部分类，默认聚焦第三方；全部文档与全站搜索保留所有接口。目录保留初版rc.1名称，版本身份以标签和VERSION.json为准。专项9/9与JS语法及桌面/手机通过，594回归为初版历史结果，本轮未重跑。
