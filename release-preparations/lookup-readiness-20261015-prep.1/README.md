# 查名准备与自动调度：发布准备

状态：**本地候选，未上线**。运行版本 `lookup-readiness-20261015-rc.1`，提交 `fda9967e0b5e441f750c7bdae94e07be6cd86235`；补充模拟 `lookup-readiness-20261015-sim.1` / `7fabb9be9f10b2d7b29dfcc8559aa79a82f0167e`。本目录只补交付材料，不修改不可变运行候选。

## 给使用方的更新说明

1. 增加启动准备接口：先用内部授权号码探测手机，至少 2 台通过即可接单，后台补到 5 台；探测和业务合计最多占用 5 台。
2. 正式号码只发给已经探测正常的手机。确认触限并保存冷却、结束旧执行后，原号码转交另一台正常手机；异常手机自行切号、重新探测，合格后再接单。没有可用手机则排队；状态未知时先核对原执行，避免重复查询。
3. 新模式的完成结果是姓名或空字符串，未实名属于空字符串。每条完成就返回；未完成或服务异常不会被伪装成“没名字”。
4. 保留超过两分钟换请求号重试的防重复能力；客户端需要保留 `lookupId`，逐条获取结果。
5. API 文档、OpenAPI、Node/Python SDK、持久化调用示例同步更新。

这次不包含单台设备暂停恢复功能。已有小红书等功能沿用已发布基线，不重新混入其他分支。无数据库迁移、无依赖升级，投屏和 D-075 基线保留。

## 对接顺序与兼容

新客户端按 `POST /api/v1/open/name-lookups/prepare` → `POST /api/v1/open/name-lookups/tasks` → `GET /api/v1/open/name-lookups/tasks/{lookupId}` 调用。沿用 HMAC 鉴权；prepare 的 body 为 `{}`，复用原准备键轮询。就绪后提交业务手机号，不传设备、账号或探测号码。

- 调用 prepare 会让该 **clientId** 进入新结果契约。未调用 prepare 的旧客户端保持旧格式；不要让旧解析器与新模式共用一个 clientId。
- 准备租期固定 30 分钟，轮询不续期；过期后用新键启动下一轮。每客户端最多 1000 个准备键，不要每次轮询造新键。
- 业务完成 `ok:true/status:completed/name`；处理中不带 name；真实失败 `ok:false/status:failed/code`，不是空姓名。最终业务值二选一不等于所有请求都能成功。
- 同客户同号码在途复用同一 lookupId，完成缓存 10 分钟；原队列/总期限不会因换键或转交延长。详见候选内 `docs/OPEN_NAME_LOOKUP_API.md`。

## 交付物与核验

本地制品目录：`~/.config/phone-cloud/release-artifacts/lookup-readiness-20261015-rc.1/`。`ARTIFACTS.json` 记录每个压缩包及成员 SHA256、20 个运行变更文件的前后哈希、旧文件证据来源。构建和隔离验包结果见本目录 `RESULTS.json`。

镜像已构建：Linux AMD64 / Node 22.23.3，OCI manifest `73b24327…ef8f39`，config `7bad36b7…2948a6`。不同 Docker 存储实现可能报告 manifest 或 config 为镜像 ID，需按 `ARCHIVE_VERIFICATION.json` 核对完整关联，不能把两者混为一个哈希。镜像 132 文件匹配、6 个 HTTP 200、未签名 prepare 401、下载内容哈希匹配；归档 11 层全部验证。隔离启动采用 `NODE_ENV=test` + JSON、network=none，不声称本轮验证了生产 PostgreSQL/Redis 配置。

| 文件 | 用途 |
|---|---|
| combined-source.zip | 不可变父包叠加候选后的完整源码，398 个清单文件及 MANIFEST |
| cloud-build-context.zip | 云镜像上下文；业务字节与候选一致，Dockerfile 单独修正继承的旧版本标签并绑定候选提交 |
| cloud-image-linux-amd64.tar.gz | 本地构建的 Linux AMD64 镜像；以 RESULTS 的镜像 ID 和归档 SHA256 为准 |
| windows-agent-overlay.zip | 只含 4 个 Agent 运行文件，路径相对于 Agent 根目录 |
| rollback-source-reference.zip | 上一版 19 个旧文件；新加 readiness 模块没有旧文件。仅作回退参考，不能代替发布时真实备份 |
| ARTIFACTS.json / IMAGE.json | 源码、制品、镜像身份及验证证据 |

重新打包使用 `python3 release-preparations/lookup-readiness-20261015-prep.1/package.py --out <新的空目录>`；已存在目录拒绝覆盖。脚本不连接生产、不启动服务。不得使用根仓旧业务或把整个 worktree 覆盖线上。

离线验包：`python3 release-preparations/lookup-readiness-20261015-prep.1/verify-artifacts.py <制品目录>`。需要重建镜像时，把 cloud-build-context.zip 解包到新目录，使用明确的本地 Docker daemon，以 `docker build --platform linux/amd64 --pull=false -t phone-cloud-platform:lookup-readiness-20261015-rc.1 <上下文>` 构建，再运行本目录 verify-image.py 的 `--artifacts <新制品目录>`。该脚本固定本机独立构建 socket；不接受远端生产 daemon。重新构建时间可能影响镜像摘要，应生成新的构建回执，不覆盖已记录制品。

## 已有验证与边界

运行候选已通过 Node 全量 739、Python 344，SDK/传输/持久示例及真实本地 HTTP/PostgreSQL 测试；真实等待 121 秒换 8 个请求键仍复用原 ID。随后新增 5 项模拟通过：100 号码/5 路无重复、连续触限、全离线恢复、普通失败不冒充限制、模拟 8 小时冷却边界。一台等待不阻塞其他模拟设备。各测试集有重叠，不相加当成独立总数。

本轮只做包装、镜像和回退验包，不重复无改动的整套测试。运行候选 24 项冻结记录不变（其中有重复路径），不宣称 24 个不同文件。用户明确手机都在线上，本轮接受本地模拟；新版本真实页面、Windows 原生 OCR、自然 8 小时到期及生产灰度仍未验。模拟 5 路不是 5 台真机。

4 个源码包二次重建逐字节一致。回退演练校验 19 个旧文件恢复、1 个新增模块移除；这是本地文件级模拟，未执行生产回滚。首轮容器因生产模式搭配 JSON 被正确拒绝；随后修正验包配置通过。归档检查最初误把 OCI manifest ID 当作 config ID，已修正为逐层验证并记录两种摘要，详见 RESULTS 的失败记录。

## 正式发布顺序（待另行授权执行）

1. **核对实际生产**：读取 ACTIVE、运行容器/下一次启动镜像、Compose、20 个目标文件及冻结文件。最后已提交生产记录为 `lookup-delivery-20261015-deployed.1` / `509bea2`；旧镜像 `sha256:772df1abf6bfcb2168249840f9f80f817d352ebb81e2eb698e78ae9af5661d2e`。这是历史回执，不代表本轮刚检查过。任何漂移先停止、解释，不覆盖热补。
2. **D-075 前置检查**：在真实媒体宿主机、有读取进程权限的上下文运行 `node deploy/mediamtx-pacing/verify.mjs --live`；失败停止发布，不修复或重启媒体。repository-only 不替代 live。
3. **备份与排空**：在新 releaseId 专属目录备份当前 ACTIVE/Compose/私有环境配置、数据库与运行状态、4 个 Agent 文件、ACL及其哈希，保留旧镜像。旧发布的 backup 目录装的是更老版本，不能直接拿来回退本轮。敏感备份留私有路径，报告只记哈希与位置。
4. **停止接新单、保留读取并排空**：先与调用方停发，再以现有入口控制逐路径拦住 prepare、tasks POST、旧同步 query 及旧会话写入，GET 结果继续可用；平台人工入口也不得新增查名。入口规则需单独核对现网路径，当前没有一键 drain 实现。仅把 pool.enabled 改 false 会停止调度，不能当成排空。保持调度直到 queued/running/manual/recovery、探测、停止确认和 outbox 全部清零；不强制取消或删除记录。排不空则延期，不跨版本接管未知执行。
5. **上传并验包**：校验 ARTIFACTS/IMAGE、加载精确镜像 ID，核对架构和版本；先隔离启动再切换。Agent 只替换 4 文件，不整包覆盖，不更改其他配置或安装依赖。无迁移 SQL 要执行。
6. **内部配置**：由安全环境配置提供 `LOOKUP_READINESS_PROBE_PHONE`，必须是已授权且已知有姓名的探测号码，不写入仓库、报告、命令参数。保留原池/授权映射；设备名单有未映射项不得猜测补齐，不自动全量开放。业务与探测最多 5 路。
7. **配套加载**：在新批准的维护窗口内切换云业务容器和 Windows Agent；这会短暂影响控屏连接，需明确告知。保持 Windows、ADB、USB、媒体及 scrcpy 参数不动。新云端必须收到新 Agent 的 lookupRuntimeId，重启后重新准备，不能继承旧就绪证明。
8. **健康与灰度**：确认 health/ready、PG/Redis、Agent 单实例/新鲜心跳/扫描、文件哈希和 outbox，无新增持续错误。再次执行真实宿主 D-075 live。用当时明确授权且空闲的设备/号码从单台实际探测到两台就绪，再验逐条姓名/空、2 分钟换键、拼图接续、限额转交与冷却；其余手机继续工作。扩大到 5 台前确认设备空闲与权限。不人为制造真实限额或宣布未自然覆盖项通过。
9. **登记与开放**：保存新部署回执、Git 运行提交/标签、镜像及文件哈希、前版及回滚点、实际验证/未验项，原子更新 ACTIVE 和下次启动 Compose。合作方升级新解析器后再允许该 clientId prepare。灰度失败不扩容，不宣称全量验收完成。

## 回滚方案

触发条件：镜像健康不通过、Agent 无心跳或版本不匹配、重复查号/错误空姓名、持续调度异常或控制行为回退。先停新写入、保留 GET 与已有任务；按上面第 4 步排空并核对停止 ACK。执行未知时优先保留当前版本对账，不能把新 prepared 任务直接交给旧协调器。

排空后，在已批准的窗口里恢复本轮备份的旧 Compose/镜像与四个 Agent 文件及 ACL、旧环境配置；只撤销本轮新增配置，不覆盖其他改动。若采用源码回退，仅在新模块当前哈希等于候选且备份证明此前不存在时删除 `server/lookup-readiness.mjs`。镜像回退自然不包含该模块，不需人工删容器文件。两端一起回退，不运行半新半旧组合。

**不恢复旧数据库快照，不清空 lookupId、请求别名、结果、冷却或 outbox**；本轮没有数据库迁移。备份用于灾难恢复，不能作为常规版本降级步骤。已完成新模式结果在旧服务中的读取格式可能变回旧格式，必须与调用方协调解析器；无法兼容就保留新版本做前向修复，不盲目退回。

恢复后重复版本/哈希、health/ready、PG/Redis、Agent 心跳单实例及 D-075 live 检查；保存回滚回执，接口保持关闭新单直到确认。再次升级时新启动准备，旧就绪证明不得复用。全过程不重启 Windows、ADB、USB Hub 或媒体。

## 当前授权与下一步

本轮授权仅本地准备、提交和标签；生产连接、备份、上传、配置、重载、真机查询、外发消息均未执行。历史维护窗口不继承到本次。准备物可审阅；正式发布仍需新的窗口、实际基线核对、私有配置和灰度。无需为这些未来步骤提前修改线上。
