# 查名 API Key 简化接入候选

状态：本地候选，尚未上线。版本 `lookup-api-key-20261016-rc.1`，分支 `codex/lookup-api-key-20261016`。从干净 ae05601170c27624e7443743bcd63afcdfdd2345 开始；根仓和已有候选保持。用户选择只填一个 API Key，未授权本轮正式发布。

## 变更与兼容

- 查名三个公开接口支持固定 `X-API-Key`，映射到现有 clientId。调用方不再提供 Client ID、Secret、时间戳、nonce或签名。
- Key 使用 `pclk_` 加32随机字节的base64url编码（43字符）；配置只保存 SHA256，小写64位hex，字段为现有 OPEN_NAME_LOOKUP_CLIENTS_JSON 客户端项的 `apiKeySha256`。不把原HMAC secret直接当API Key。缺少/无效配置不启用新方式。
- 旧HMAC完整保留，包括时间戳、nonce防重；新旧方式共享身份、权限、查名任务、幂等和限额，不创建另一套队列。重复Key摘要拒绝所有歧义匹配；混用认证头拒绝。
- Key仅支持POST prepare、POST tasks、GET tasks/{lookupId}。不能用于旧会话接口、短信、管理、投屏或Agent接口。现有用户/客户授权检查仍执行。
- 生产基线已只读核对：ACTIVE a7495221、业务deployed.16、运行b5479d9c/下次03b6928a；index e13e4271、open-name-lookup-api 0c846c1c与本地组装完全一致。BASELINE.json保留完整哈希。
- 运行只改index鉴权入口、可选配置解析，新增lookup-api-key模块。调度/查名执行器/Agent/ADB/SYSTEM/投屏/媒体逻辑无改动；无迁移、无依赖升级。11静态文件及独立Python/Node完整例子同步更新，保留旧examples/name-lookup不覆盖。

## 本地验证

- 根语法检查通过，全量 `npm run test:screen` **824/824**，包含原HMAC测试与8项新鉴权/真实回环HTTP测试。
- Python **10/10**、Node **13/13**：准备/提交/结果、空姓名、失败不当空、120秒客户端等待、原键重试、SQLite/文件持久化及进程重启后GET原ID。
- API Key普通HTTP夹具：20条提交、2台执行18条排队，补位到5台并发，429、防重、逐条完成；模拟触限冷却ACK/跨机同ID、一个挂起不阻塞其他四台、服务重启续查。
- 实际墙钟等待 **121000ms** 后8个新请求键仍原lookupId、原一次执行；HMAC再提交同号码也同ID。跨客户读取404；错误Key/混合头/旧接口/管理接口拒绝。
- 文档3段Python单次HTTP代码实际在mock执行、3段Node语法、OpenAPI安全声明、ZIP/源码一致性通过；浏览器11个查名目录等待准确标题后通过，HTTP页只显示X-API-Key，无控制台错误。候选页面明确尚未上线。
- 初轮缺少本地根/Agent依赖链接，HTTP启动与全量2项无法运行；只为隔离组装目录关联既有依赖缓存，未安装或升级依赖，重跑全部通过。跨租户测试初版未给第二客户测试授权，先收到403；补齐测试用户和授权后验证404。片段mock输入顺序修正后通过。
- 本机Python3.9.6/requests2.32.5仍有urllib3/LibreSSL环境提示，HTTP验证通过；未验HTTPS、真实生产PG、真机或新Key生产调用。没有生产修改、真实查询、消息发送、推送或重启。

## 发布与回滚

这是服务端鉴权变更，复制静态文档不能生效。正式发布前须新鲜核对ACTIVE、Compose和运行文件，备份数据库、配置/旧镜像，实际媒体宿主机执行D-075只读live，再确认云端维护影响及发布授权。不重载Agent，不动ADB/SYSTEM/Windows/USB/媒体。当前尚未构建生产镜像或生成生产Key。

部署时给原客户生成独立随机Key，仅将其SHA256加入配置；明文只安全单独交付给用户，不进仓库、命令参数、日志、文档或公开静态资源。用户将这一项私发给后端开发。保留原clientId/secret/user/grant/设备池及其他配置。完整Key不可从摘要恢复，遗失应另行轮换并交付；不能伪称后台可找回明文。

基于当时实际下次启动镜像最小覆盖三个运行文件与11静态文件，不能整仓发布。配置修改和云端重载同窗生效。发布后先只读验证Key权限和旧HMAC兼容，再在用户授权号码/设备范围内做灰度；尚无本轮真机授权，不自动启动prepare。

回滚到备份的真实上一镜像及配置，保留业务数据库/任务/别名/结果/冷却，不整库回退；恢复上一文档与下载包。新Key调用方需要暂缓或恢复旧HMAC，原任务ID仍保留。回退云端同样可能短暂断开控屏，须在维护授权范围内。D-075与ADB身份保持。

复现：`python3 verification/prepare-local.py --out /tmp/新的独立目录`。它校验清单，组装rc.16及已发布文档，再叠加本候选；不安装依赖、不读取生产配置。给该目录root/windows-agent分别关联既有node_modules后运行上述检查。`READINESS_HOLD_MS=121000 node verification/api-key-http.mjs`用于真实121秒回环测试，仅模拟设备。
