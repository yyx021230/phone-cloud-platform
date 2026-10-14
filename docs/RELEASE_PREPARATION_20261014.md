# 2026-10-14 组合版本上线准备

当前候选：`platform-core-20261014-rc.7`，提交 `aa3f39934ba192e11d181f47eb6c98be5f7393d6`，分支 `codex/platform-rc2-local-acceptance-20261014`。**OCR修复、Windows原生、双机/API、Linux构建和回归已完成；尚未部署。**

## 最新验收状态（live.2）

- 修复Windows加载OCR DLL卡住、130查询预算不足、已结束会话被旧人工状态占用。保留固定截止时间、两帧/置信度、不重复输入和未知停止保护。
- Windows独立受限目录：单进程真实卡两帧10.1秒，双进程各16.2秒；8生命周期测试、超时回收/重新调用、XHS原生中文OCR通过。原Agent/共享Python/ADB未切换，SYSTEM生产上下文留到灰度验证。
- 118/130四条新API请求：3姓名、1页面无姓名卡而未确认，均1query/1input，同键原ID。两机真实执行重叠，130等待时118返回。118首次进入搜索页失败后自动转130，后续118补测成功；该偶发点击未入页的根因未证明，不把它写成消除。
- 旧118人工请求等待过期，已确认stop后自动释放原通道，取消记录保留，没有冒充查询成功。池/任务/通道/outbox清零，备份后恢复原本地服务。
- Python315、执行器163、Mac与Linux Node各709；Linux语法/平台烟测、临时PG五组通过。当前代码HTTP等待121001ms后8新键仍原ID，仅1query，重开/迟到回执通过；此项为合成Agent。
- 云端已新构建：镜像 `sha256:90c3a980cf842bdced2512a52726fe501501b3763e27821dafa108102fadb5e9`，config `sha256:33076d0d0dbb28c280b7d1656e3eb943880f1363b184ca325481b6c2266a9346`。实际镜像版本/提交标签匹配rc.7；构建命令显式覆盖继承Dockerfile的旧默认标签。129文件哈希、6HTTP路径/healthy及归档通过，上线使用已验归档，不把rc.2镜像改标。
- 交付目录 `~/.config/phone-cloud/release-artifacts/platform-core-20261014-rc.7/`：8交付物、389源码文件、22Agent覆盖文件、19锁定Windows wheel和回退源。以ARTIFACTS.json核对。
- 本轮线上只读：ACTIVE语义、运行/下次镜像、Compose、170云端业务文件与64 Windows文件无漂移；D-075在真实宿主机live通过，8Mbps/2包保留。正式切换前仍须再核验、备份、增量迁移和维护窗口。
- 用户已延期自然8小时冷却、物理设备范围仅两台；148映射和历史14条无姓名卡证据保留。不能宣称完美无缺或生产全量验收完成。
- 完整证据：[live.2验收回执](evidence/PLATFORM_ACCEPTANCE_20261014_LIVE2.json)。原根仓236项保留，未推送、未部署、未外发通知。

## 之前验收状态（live.1，历史）

- rc.3限定搜索入口包和前台；rc.4禁止OCR异常重输号码；rc.5修复姓名卡下方转账推荐项误算重复按钮。最新Python311、执行器163、Node698通过。
- rc.4真实8条7姓名/1未确认，全部1任务/1次输入；124125ms后换3个请求键仍同查询，另一手机在回报延迟期间完成两条。
- rc.5最终2条：130滑块通过后OCR超时，118拼图待人工；都未重复输入。原请求/最新测试库保存，测试池和自有服务已停，原本地Agent已恢复。不能记为最终双机通过。
- 用户要求不等待自然冷却，已暂停17:38续测。冷却前两机拒绝选择均通过，原冷却记录保留；到期后未验。物理5台按用户现有设备范围不再等待，五路仅模拟。
- SSH安全会话两端认证失败，本轮无法刷新生产版本/哈希/D-075；Windows原生OCR、真实查询预算内OCR性能和118原请求接续仍是未完成项。
- 当前交付目录 `~/.config/phone-cloud/release-artifacts/platform-core-20261014-rc.5/`：388源码文件、22 Agent覆盖文件和8项归档；原rc.2云镜像128业务文件与rc.5一致，保留旧组件版本身份，不重新贴标签。归档、镜像blob、SDK和冻结文件哈希已核验。
- 详细失败、原请求、恢复及版本证据见[验收回执](evidence/PLATFORM_ACCEPTANCE_20261014_LIVE1.json)。下文rc.2构建、合并和线上快照作为继承证据，不能当成rc.5已上线。

## 相对当前生产的更新

| 模块 | 本次内容 |
|---|---|
| 支付宝查名 | 内部49台名单、最多5路调度；POST提交号码、GET按lookupId取结果；每个号码独立完成；同客户同号码在途新键合并，完成后固定10分钟复用；保留旧接口 |
| 查名执行 | 精确两帧姓名/号码卡、组合邮箱号码、加载过渡等待；普通恢复复用账户；切号入口单次、稳定账户行精确选择；保留限制和冷却 |
| 设备恢复 | 扫描单航班，等待后重新准入，安装器真实忙和探测失败区分；D-024持续恢复策略不变 |
| 小红书采集 | 合入rc.5；按deviceId和app1/app2采集最近30日列表，任务列表/详情/取消；不完整保留部分结果并失败；21分钟服务端上限；不含外部数据库映射或定时同步 |
| API文档 | 小红书自动登录、一键发布、数据采集、快手、短信和查名独立罗列；46接口/9模块；纠正查名首页旧同步描述；查名SDK和下载包保留 |
| OCR依赖 | 私有venv运行RapidOCR/ONNX/OpenCV，Airtest继续用原环境；19个Windows wheel离线锁定；子进程超时/退出处理，不触发ADB/USB恢复 |

9个共用文件逐段合并，6处冲突解决；快手页面渲染/操作原函数块逐字保留。22个冻结源码文件和2个生产投屏bundle哈希保持，未重建投屏。共享根仓236项已有改动不纳入。

## 实际生产比较基线

沿用本任务2026-10-14 12:24–12:36只读取证；本轮不重新连接生产。切换时必须重新检查，不能把快照当实时状态。

- ACTIVE：`lookup-realname-prompt-20261012-deployed.1`，runtimeCandidateCommit `8ceaf56f1927637520f082c9c356ea49847c8b25`。
- 正在运行 `sha256:4e484ed7db6da2760c64de1f4481fdb7deb97b7acf4e4182e1658507a1d8b437` 加热补；下次启动 `sha256:97633e241d545dbe895ad003852dfd35eae39cab9bcb54fbee95740b67daa053`。两份Compose和11项热补已核对，回退不能只使用裸4e484镜像。
- Windows入口 SHA256 `0d6a0aa177f38873b6999e18bba24fdecb865469924bc91efe396e91e2bd883b`；查名Python `24a9429c2735454ef854c0b6fa4346fedbb7a50ce264fd9ee4811cc43e7acc0d`（单独热补，云包旧文件不能覆盖）。
- 媒体 D-075 二进制 `d3a9eab65555680f1a7efe6d1746f315e25c69059d49aff40a0a45d292feec35`、8Mbps、每组最多2包；上轮真实宿主机live通过。本轮只验证仓库保护文件，未冒称新一次live。
- 131设备/125上架/118在线为取证时快照；49查名目标48个唯一上架匹配，148缺映射，79/118/130当时离线。缺映射不猜、不加入执行。

## 验证结果

- 生产Dockerfile固定 Node 基础镜像摘要，实际本地构建 Linux AMD64 / Node22；全量697/697、平台烟测通过，镜像身份/启动健康/文件哈希见 BUILD.json。
- Agent304/304、恢复22/22、Python296/296、执行器163/163、SDK Node6/Python9通过。各组有交集，不合计为独立用例数。
- 临时Postgres：迁移、归档事务、别名重启、设备隔离、迟到结果；XHS提交时锁表确认未提交任务不能被领取，注入写入失败无手机任务且可重提；取消与迟到回执、部分结果和服务重启保留通过。
- 合作方下载包+独立HMAC+持久化Python样例：5路同时运行，第6条排队；一台等待121001ms期间其他5条完成；8次换键仍原lookupId，6个合成号码恰好6次query；重启、重复回执、429、关闭池503和鉴权通过。
- 独立OCR环境真实数字图片识别两次、同子进程复用及回收通过；超时/阻塞输入/父进程退出测试通过；19个Windows wheel和模型哈希离线核对。Windows DLL原生加载尚未验证。
- 本地浏览验证文档目录、采集请求体、响应字段和错误表正常；API文档页只读，不发送业务请求。
- 首次Node22测试容器3项因缺开发依赖/测试Dockerfile失败，补齐测试环境后697全过；首次XHS PG夹具漏设STORAGE_BACKEND，修正后通过真实锁表/失败注入。失败证据保留，不改业务代码掩盖测试问题。

## 交付物与离线预检

本机 `~/.config/phone-cloud/release-artifacts/platform-core-20261014-rc.2/` 保存完整源码、云构建上下文、镜像归档、Windows最小覆盖包、Windows OCR wheel及锁文件、校验清单、前一版回退源引用和Git身份。归档不含真实密钥/配置/业务数据。镜像归档同时校验OCI manifest和config摘要；本地containerd镜像ID是manifest摘要，旧版Docker导入后可能显示config摘要，二者均在BUILD.json记录，不以显示格式差异判断版本漂移。以ARTIFACTS.json哈希和Git tag核对，不直接覆盖生产整仓。

OCR安装器 `windows-agent/scripts/install_lookup_ocr.py` 仅支持64位Windows Python3.9，目标必须是不存在的新目录；不修改Airtest、不允许覆盖已有venv。离线轮子校验、pip check、环境隔离和实际推理全部成功后才写READY标记。默认路径为该Agent目录下 `runtime/lookup-ocr/Scripts/python.exe`；自定义路径用 `PHONE_CLOUD_LOOKUP_OCR_PYTHON`，必须指向私有venv。不要移动已创建的venv，不把Mac环境复制到Windows。

```powershell
# 后续获准Windows测试/部署窗口执行；本轮未执行。
python windows-agent/scripts/install_lookup_ocr.py --wheel-dir <离线wheel目录> --lock-file windows-agent/runtime-manifests/windows-wheel-lock.txt --verify-only
python windows-agent/scripts/install_lookup_ocr.py --wheel-dir <离线wheel目录> --lock-file windows-agent/runtime-manifests/windows-wheel-lock.txt
```

## 获准切换时的顺序与停止条件

1. 重新核对ACTIVE、Compose、所有目标文件/镜像哈希和活动任务；D-075必须在真实媒体宿主机只读`verify --live`。漂移/不一致则停，不自动修复媒体。
2. 保存实际数据库、配置、源码、镜像及Agent依赖回退点；确认维护窗口和排空任务。已有16文件回退源只是上轮快照，不替代切换时备份。新增文件必须记录“原本不存在”。
3. 在独立Windows环境先通过OCR离线安装与原生推理、自有Airtest/Poco回归；没有通过不得激活查名OCR补丁。XHS使用Windows原生OCR，另验其能力探测。此次不修改线上Python或配置。
4. 两份查名增量SQL单独迁移、核对3张新表；cloud初次保持`MANAGED_NAME_LOOKUP_ENABLED=false`。小红书采集复用现有jobs/tasks，无额外迁移。迁移、协调器启用、池启用三步分开，不跳过缺表保护。
5. 更新已核对的Agent文件并保留旧版本，确认单实例、心跳/扫描/outbox、旧扫码/发布/短信/实时控制。Agent切换会影响在用会话，必须事先告知；不随业务升级重启Windows、ADB、USB或媒体。
6. 云端使用本候选不可变镜像，核对容器文件哈希与health/ready。录入明确的设备映射和客户grant前先生成配置预览。随后按单设备→两设备→五设备灰度，检验查名/切号/人工阻塞隔离/冷却及XHS采集，再放量；148确认前保持不参与。
7. 保存正式部署回执（Git/tag、镜像、各组件哈希、迁移、配置与回滚点），更新ACTIVE和主文档；发布前后都执行D-075真实live。

回退先停止新增受理，保留并排空在途、人工和未知停止绑定；保存查询、结果、别名、冷却，不删新增表。已有新查询时旧业务不能丢弃别名后重查同号码，先对账或保留新结果只读服务。恢复核对过的Compose/97633镜像及热补和Agent本轮文件；私有OCR目录可保留待审，不卸载全局Airtest/OpenCV。冻结投屏、十分钟闲置和D-075不能回退。

未验边界以顶部live.2为准：Windows原生隔离目录已通过；生产SYSTEM/真机灰度、正式备份与窗口仍待执行。5物理机仅模拟，自然冷却按用户要求延期；118偶发首次搜索入口失败、148映射、历史14条缺姓名卡证据如实保留。

共同流程修订2026-09-30，SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。rc.2准备阶段无真实任务；后续live.1有118/130授权本地真测。此次生产连接尝试认证失败，成功连接及生产修改0，无外发消息或推送。
